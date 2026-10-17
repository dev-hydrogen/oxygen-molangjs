import { compile, evaluate } from './compiler';
import { createEnv, SymbolTable, TempScope, type Env, type Value } from './runtime';
import { LATEST_MOLANG_VERSION } from './version';
// Legacy API keeps the old (pre-abort) unset behaviour: unknown names read as 0 and evaluation continues.

type VariableValue = number | string | ((...args: Value[]) => Value);

function canonical(key: string): string {
	const lower = key.toLowerCase();
	const dot = lower.indexOf('.');
	if (dot === -1) return lower;
	const head = lower.slice(0, dot);
	const rest = lower.slice(dot);
	switch (head) {
		case 'v':
			return 'variable' + rest;
		case 't':
			return 'temp' + rest;
		case 'q':
			return 'query' + rest;
		case 'c':
			return 'context' + rest;
	}
	return lower;
}

/**
 * Backwards-compatible molangjs API (`new Molang().parse(expr, variables)`), now backed by the
 * faithful compiler. Behavioural differences from molangjs 1.x follow Bedrock: multi-statement
 * expressions return 0.0 without `return`, strings keep their case, `&&` binds tighter than `||`.
 */
export default class Molang {
	global_variables: Record<string, VariableValue> = {};
	variables: Record<string, VariableValue> = {};
	cache_enabled = true;
	use_radians = false;
	/** Molang version index used to parse (defaults to latest) */
	version = LATEST_MOLANG_VERSION;
	/** Called for names that aren't defined anywhere: (key, variables, args?) => value */
	variableHandler: ((key: string, variables: Record<string, VariableValue>, args?: Value[]) => Value | undefined) | null = null;

	private symbols = new SymbolTable();
	private temps = new TempScope();

	parse(input: unknown, variables?: Record<string, VariableValue>): number {
		if (typeof input === 'number') return input || 0;
		if (typeof input !== 'string' || input.length === 0) return 0;
		const sym = this.cache_enabled ? this.symbols : new SymbolTable();
		const expr = compile(input, { symbols: sym, f32: false, radians: this.use_radians, context: 'generic', version: this.version });
		const scope: Record<string, VariableValue> = {};
		for (const k in this.global_variables) scope[canonical(k)] = this.global_variables[k];
		for (const k in this.variables) scope[canonical(k)] = this.variables[k];
		if (variables) for (const k in variables) scope[canonical(k)] = variables[k];

		const v: Value[] = [];
		sym.variableNames.forEach((name, i) => {
			const val = scope[name];
			if (typeof val === 'number' || typeof val === 'string') v[i] = val;
		});
		const resolve = (name: string, args?: Value[]): Value | undefined => {
			const val = scope[name];
			if (typeof val === 'function') return val(...(args ?? []));
			if (val !== undefined) return val;
			const handled = this.variableHandler?.(name, scope, args);
			return handled === undefined ? undefined : handled;
		};
		this.temps.reset();
		const env: Env = createEnv({
			v,
			t: this.temps,
			c: [],
			q: (id, args) => resolve(sym.queryNames[id], args) ?? 0,
			unsetMode: 'zero',
			lookup: (kind, slot) => {
				const name = kind === 0 ? sym.variableNames[slot] : kind === 1 ? sym.tempNames[slot] : sym.contextNames[slot];
				return name === undefined ? undefined : resolve(name);
			},
		});
		const result = evaluate(expr, env);
		// persist variable writes like molangjs did
		v.forEach((val, i) => {
			if (val !== undefined && scope[sym.variableNames[i]] !== val) this.variables[sym.variableNames[i]] = val;
		});
		return typeof result === 'number' ? result || 0 : 0;
	}

	resetVariables(): void {
		this.variables = {};
	}
}
