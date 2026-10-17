import { describe, expect, it } from 'vitest';
import { compile, createEnv, evaluate, SymbolTable, type Value } from '../src/index';

// Differential fuzzing: random programs printed with the fewest parentheses Mojang's precedence table
// allows, run by an independent reference interpreter and by the compiler in fast, trace and step mode.

type Expr =
	| { k: 'num'; v: number }
	| { k: 'var'; name: string }
	| { k: 'un'; op: '-' | '!'; a: Expr }
	| { k: 'bin'; op: string; a: Expr; b: Expr }
	| { k: 'tern'; c: Expr; a: Expr; b: Expr }
	| { k: 'coal'; name: string; b: Expr }
	| { k: 'call'; fn: string; args: Expr[] };

const VARS = ['v.a', 'v.b', 'v.c', 'v.d'];
const BIN: Record<string, number> = { '||': 3, '&&': 4, '==': 5, '!=': 5, '<': 6, '<=': 6, '>': 6, '>=': 6, '+': 7, '-': 7, '*': 8, '/': 8 };
const FNS: Record<string, number> = { abs: 1, floor: 1, sin: 1, cos: 1, min: 2, max: 2, clamp: 3, lerp: 3 };

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function gen(r: () => number, depth: number): Expr {
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
	if (depth <= 0 || r() < 0.25) return r() < 0.5 ? { k: 'num', v: Math.floor(r() * 40) / 4 } : { k: 'var', name: pick(VARS) };
	const x = r();
	if (x < 0.5) return { k: 'bin', op: pick(Object.keys(BIN)), a: gen(r, depth - 1), b: gen(r, depth - 1) };
	if (x < 0.62) return { k: 'un', op: r() < 0.5 ? '-' : '!', a: gen(r, depth - 1) };
	if (x < 0.75) return { k: 'tern', c: gen(r, depth - 1), a: gen(r, depth - 1), b: gen(r, depth - 1) };
	if (x < 0.82) return { k: 'coal', name: r() < 0.5 ? 'v.unset' : pick(VARS), b: gen(r, depth - 1) };
	const fn = pick(Object.keys(FNS));
	return { k: 'call', fn, args: Array.from({ length: FNS[fn] }, () => gen(r, depth - 1)) };
}

const prec = (e: Expr): number => (e.k === 'bin' ? BIN[e.op] : e.k === 'tern' ? 2 : e.k === 'coal' ? 1 : e.k === 'un' ? 9 : 10);
const wrap = (e: Expr, need: boolean) => (need ? `(${print(e)})` : print(e));

function print(e: Expr): string {
	switch (e.k) {
		case 'num':
			return String(e.v);
		case 'var':
			return e.name;
		case 'un':
			// a space keeps `- -x` from reading as a decrement
			return `${e.op}${e.op === '-' ? ' ' : ''}${wrap(e.a, prec(e.a) < 9)}`;
		case 'bin': {
			const p = BIN[e.op];
			return `${wrap(e.a, prec(e.a) < p)} ${e.op} ${wrap(e.b, prec(e.b) <= p)}`;
		}
		case 'tern':
			return `${wrap(e.c, prec(e.c) <= 2)} ? ${wrap(e.a, prec(e.a) <= 2)} : ${wrap(e.b, prec(e.b) < 2)}`;
		case 'coal':
			return `${e.name} ?? ${wrap(e.b, prec(e.b) <= 1)}`;
		case 'call':
			return `math.${e.fn}(${e.args.map(print).join(', ')})`;
	}
}

const DEG = Math.PI / 180;
function ref(e: Expr, vars: Map<string, number>): number {
	const t = (x: number) => (x !== 0 ? 1 : 0);
	switch (e.k) {
		case 'num':
			return e.v;
		case 'var':
			return vars.get(e.name)!;
		case 'un':
			return e.op === '-' ? -ref(e.a, vars) : t(ref(e.a, vars)) ? 0 : 1;
		case 'bin': {
			if (e.op === '&&') return t(ref(e.a, vars)) && t(ref(e.b, vars)) ? 1 : 0;
			if (e.op === '||') return t(ref(e.a, vars)) || t(ref(e.b, vars)) ? 1 : 0;
			const a = ref(e.a, vars);
			const b = ref(e.b, vars);
			switch (e.op) {
				case '+':
					return a + b;
				case '-':
					return a - b;
				case '*':
					return a * b;
				case '/':
					return b === 0 ? 0 : a / b;
				case '<':
					return a < b ? 1 : 0;
				case '<=':
					return a <= b ? 1 : 0;
				case '>':
					return a > b ? 1 : 0;
				case '>=':
					return a >= b ? 1 : 0;
				case '==':
					return a === b ? 1 : 0;
				default:
					return a !== b ? 1 : 0;
			}
		}
		case 'tern':
			return t(ref(e.c, vars)) ? ref(e.a, vars) : ref(e.b, vars);
		case 'coal':
			return vars.has(e.name) ? vars.get(e.name)! : ref(e.b, vars);
		case 'call': {
			const a = e.args.map((x) => ref(x, vars));
			switch (e.fn) {
				case 'abs':
					return Math.abs(a[0]);
				case 'floor':
					return Math.floor(a[0]);
				case 'sin':
					return Math.sin(a[0] * DEG);
				case 'cos':
					return Math.cos(a[0] * DEG);
				case 'min':
					return Math.min(a[0], a[1]);
				case 'max':
					return Math.max(a[0], a[1]);
				case 'clamp':
					return a[0] < a[1] ? a[1] : a[0] > a[2] ? a[2] : a[0];
				default:
					return a[0] + (a[1] - a[0]) * a[2];
			}
		}
	}
}

interface Program {
	src: string;
	value: number;
	vars: Map<string, number>;
}

/** A few assignments, then `return`: the reference runs it statement by statement */
function program(r: () => number): Program {
	const vars = new Map<string, number>([
		['v.a', 1.5],
		['v.b', -2],
		['v.c', 0],
		['v.d', 7.25],
	]);
	const statements: string[] = [];
	const n = Math.floor(r() * 3);
	for (let i = 0; i < n; i++) {
		const target = VARS[Math.floor(r() * VARS.length)];
		const e = gen(r, 3);
		statements.push(`${target} = ${print(e)};`);
		vars.set(target, ref(e, vars));
	}
	const e = gen(r, 4);
	const value = ref(e, vars);
	return { src: n ? `${statements.join(' ')} return ${print(e)};` : print(e), value, vars };
}

function same(a: Value, b: number): boolean {
	return typeof a === 'number' && (a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));
}

function runMode(src: string, mode: 'fast' | 'trace' | 'step', f32: boolean) {
	const symbols = new SymbolTable();
	const expr = compile(src, { symbols, mode, f32, context: 'generic' });
	const v: Value[] = [];
	const init: [string, number][] = [
		['variable.a', 1.5],
		['variable.b', -2],
		['variable.c', 0],
		['variable.d', 7.25],
	];
	for (const [name, value] of init) v[symbols.variable(name)] = f32 ? Math.fround(value) : value;
	const env = createEnv({ v, unsetMode: 'abort', trace: mode === 'trace' ? (_id, x) => x : null });
	const value = mode === 'step' ? (() => {
		const it = expr.step!(env) as Generator<number, Value, void>;
		let s = it.next();
		while (!s.done) s = it.next();
		return s.value;
	})() : evaluate(expr, env);
	const vars = new Map(init.map(([name]) => [name.replace('variable.', 'v.'), v[symbols.variable(name)] as number]));
	return { value, vars, diagnostics: expr.diagnostics };
}

describe('differential fuzzing', () => {
	it('the compiler agrees with a reference interpreter on 3000 random programs', () => {
		const r = rng(20261017);
		const failures: string[] = [];
		for (let i = 0; i < 3000 && failures.length < 5; i++) {
			const p = program(r);
			const got = runMode(p.src, 'fast', false);
			const errors = got.diagnostics.filter((d) => d.severity === 'error');
			if (errors.length) {
				failures.push(`${p.src}\n  doesn't compile: ${errors[0].message}`);
				continue;
			}
			if (!same(got.value, p.value)) failures.push(`${p.src}\n  expected ${p.value}, got ${got.value}`);
			for (const [name, value] of p.vars) if (!same(got.vars.get(name)!, value)) failures.push(`${p.src}\n  ${name}: expected ${value}, got ${got.vars.get(name)}`);
		}
		expect(failures).toEqual([]);
	});

	it('fast, trace and step modes agree, with and without float32', () => {
		const r = rng(77);
		const failures: string[] = [];
		for (let i = 0; i < 1500 && failures.length < 5; i++) {
			const { src } = program(r);
			for (const f32 of [false, true]) {
				const fast = runMode(src, 'fast', f32);
				for (const mode of ['trace', 'step'] as const) {
					const other = runMode(src, mode, f32);
					const ok = Object.is(other.value, fast.value) && [...fast.vars].every(([k, x]) => Object.is(other.vars.get(k), x));
					if (!ok) failures.push(`${src} (${mode}, f32 ${f32}): fast ${fast.value}, ${mode} ${other.value}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
