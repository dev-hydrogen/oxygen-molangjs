import type { CallNode, Diagnostic, NameNode, Node, Program } from './ast';
import { parse } from './parser';
import {
	BUILTIN_QUERIES,
	STRUCT_QUERIES,
	DEG,
	EASINGS,
	M,
	MISSING,
	MolangAbort,
	SymbolTable,
	clearSlot,
	copyStruct,
	missingValue,
	readVarSlow,
	type Env,
	type Value,
} from './runtime';
import { resolveFeatures } from './parser';
import { type MolangFeatures } from './version';

export type CompileMode = 'fast' | 'trace' | 'step';

export interface CompileOptions {
	symbols: SymbolTable;
	/** Per-expression version (game enum). */
	version?: number | null;
	/** Pack min_engine_version (plain-string expressions). */
	engine?: string | readonly number[] | null;
	/** Explicit rule set (overrides version/engine). */
	features?: MolangFeatures;
	/**
	 * Query registry check. When given, unknown/unsupported queries are compile errors exactly like
	 * the game's "Failed to resolve query … not supported in this context" load error.
	 */
	queryExists?: (name: string) => boolean;
	/** Emulate Bedrock's 32-bit floats (round every operation with Math.fround). Default true. */
	f32?: boolean;
	mode?: CompileMode;
	/** Legacy molangjs option: trig in radians. Bedrock always uses degrees. */
	radians?: boolean;
	/**
	 * 'particle': flags constructs that don't exist in particle Molang (for_each, ->, arrays,
	 * geometry/texture/material). 'generic': allow them (they still evaluate to 0 here).
	 */
	context?: 'particle' | 'generic';
	/** Allow Oxygen editor-only `//` comments */
	comments?: boolean;
}

export interface CompiledExpression {
	source: string;
	program: Program;
	diagnostics: Diagnostic[];
	/** false when the expression has errors — in Bedrock the whole effect then fails to load */
	ok: boolean;
	complex: boolean;
	/** Known constant value (no evaluation needed), or null */
	constant: number | null;
	run: (E: Env) => Value;
	/** 'step' mode: a generator yielding the node id before each statement */
	step?: (E: Env) => Generator<number, Value, void>;
	/** Generated JavaScript, for debugging */
	js: string;
}

type MathGen = (a: string[], E: string) => string;

/** Codegen for math.* — args are already JS expressions producing numbers */
function mathTable(radians: boolean): Record<string, { min: number; max: number; gen: MathGen; pure: boolean }> {
	const toRad = (x: string) => (radians ? x : `(${x}) * DEG`);
	const fromRad = (x: string) => (radians ? x : `(${x}) / DEG`);
	const t: Record<string, { min: number; max: number; gen: MathGen; pure: boolean }> = {
		abs: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.abs(${a})` },
		sin: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.sin(${toRad(a)})` },
		cos: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.cos(${toRad(a)})` },
		asin: { min: 1, max: 1, pure: true, gen: ([a]) => fromRad(`Math.asin(${a})`) },
		acos: { min: 1, max: 1, pure: true, gen: ([a]) => fromRad(`Math.acos(${a})`) },
		atan: { min: 1, max: 1, pure: true, gen: ([a]) => fromRad(`Math.atan(${a})`) },
		atan2: { min: 2, max: 2, pure: true, gen: ([y, x]) => fromRad(`Math.atan2(${y}, ${x})`) },
		ceil: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.ceil(${a})` },
		floor: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.floor(${a})` },
		trunc: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.trunc(${a})` },
		round: { min: 1, max: 1, pure: true, gen: ([a]) => `M.round(${a})` },
		sqrt: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.sqrt(${a})` },
		exp: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.exp(${a})` },
		ln: { min: 1, max: 1, pure: true, gen: ([a]) => `Math.log(${a})` },
		pow: { min: 2, max: 2, pure: true, gen: ([a, b]) => `Math.pow(${a}, ${b})` },
		min: { min: 2, max: 2, pure: true, gen: ([a, b]) => `Math.min(${a}, ${b})` },
		max: { min: 2, max: 2, pure: true, gen: ([a, b]) => `Math.max(${a}, ${b})` },
		clamp: { min: 3, max: 3, pure: true, gen: ([v, lo, hi]) => `M.clamp(${v}, ${lo}, ${hi})` },
		lerp: { min: 3, max: 3, pure: true, gen: ([a, b, x]) => `M.lerp(${a}, ${b}, ${x})` },
		lerprotate: { min: 3, max: 3, pure: true, gen: ([a, b, x]) => `M.lerpRotate(${a}, ${b}, ${x})` },
		inverse_lerp: { min: 3, max: 3, pure: true, gen: ([a, b, x]) => `M.inverseLerp(${a}, ${b}, ${x})` },
		hermite_blend: { min: 1, max: 1, pure: true, gen: ([a]) => `M.hermite(${a})` },
		min_angle: { min: 1, max: 1, pure: true, gen: ([a]) => `M.minAngle(${a})` },
		sign: { min: 1, max: 1, pure: true, gen: ([a]) => `M.sign(${a})` },
		copy_sign: { min: 2, max: 2, pure: true, gen: ([a, b]) => `M.copySign(${a}, ${b})` },
		mod: { min: 2, max: 2, pure: true, gen: ([a, b]) => `((${a}) % (${b}))` },
		random: { min: 2, max: 2, pure: false, gen: ([a, b], E) => `M.random(${E}.rnd, ${a}, ${b})` },
		random_integer: { min: 2, max: 2, pure: false, gen: ([a, b], E) => `M.randomInt(${E}.rnd, ${a}, ${b})` },
		die_roll: { min: 3, max: 3, pure: false, gen: ([n, a, b], E) => `M.dieRoll(${E}.rnd, ${n}, ${a}, ${b})` },
		die_roll_integer: { min: 3, max: 3, pure: false, gen: ([n, a, b], E) => `M.dieRollInt(${E}.rnd, ${n}, ${a}, ${b})` },
	};
	for (const name of Object.keys(EASINGS)) {
		t[name] = { min: 3, max: 3, pure: true, gen: ([a, b, x]) => `M.lerp(${a}, ${b}, EZ.${name}(${x}))` };
	}
	return t;
}

const MATH_DEG = mathTable(false);
const MATH_RAD = mathTable(true);

/** Evaluate pure math at compile time (constant folding) */
const FOLD_MATH: Record<string, (...a: number[]) => number> = {
	abs: Math.abs,
	sin: (a) => Math.sin(a * DEG),
	cos: (a) => Math.cos(a * DEG),
	asin: (a) => Math.asin(a) / DEG,
	acos: (a) => Math.acos(a) / DEG,
	atan: (a) => Math.atan(a) / DEG,
	atan2: (y, x) => Math.atan2(y, x) / DEG,
	ceil: Math.ceil,
	floor: Math.floor,
	trunc: Math.trunc,
	round: M.round,
	sqrt: Math.sqrt,
	exp: Math.exp,
	ln: Math.log,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	clamp: M.clamp,
	lerp: M.lerp,
	lerprotate: M.lerpRotate,
	inverse_lerp: M.inverseLerp,
	hermite_blend: M.hermite,
	min_angle: M.minAngle,
	sign: M.sign,
	copy_sign: M.copySign,
	mod: (a, b) => a % b,
};

function lit(n: number): string {
	if (Number.isNaN(n)) return 'NaN';
	if (n === Infinity) return 'Infinity';
	if (n === -Infinity) return '-Infinity';
	if (Object.is(n, -0)) return '-0';
	return String(n);
}

class CodeGen {
	private tmpCount = 0;
	private loopLabels: string[] = [];
	/** >0 while compiling inside an IIFE (break/continue/return can't cross it) */
	private fnDepth = 0;
	/** >0 while compiling the left side of `??` (missing names throw MISSING instead of erroring) */
	private soft = 0;
	private labelCount = 0;
	readonly f32: boolean;
	readonly trace: boolean;
	readonly step: boolean;
	readonly features: MolangFeatures;
	private math: ReturnType<typeof mathTable>;

	constructor(
		private sym: SymbolTable,
		private o: CompileOptions,
		private diags: Diagnostic[],
	) {
		this.f32 = o.f32 !== false;
		this.trace = o.mode === 'trace';
		this.step = o.mode === 'step';
		this.features = resolveFeatures(o);
		this.math = o.radians ? MATH_RAD : MATH_DEG;
	}

	tmp(): string {
		return '_' + this.tmpCount++;
	}
	declareTemps(): string {
		if (!this.tmpCount) return '';
		const names: string[] = [];
		for (let i = 0; i < this.tmpCount; i++) names.push('_' + i);
		return `var ${names.join(', ')};`;
	}
	private F(code: string): string {
		return this.f32 ? `F(${code})` : code;
	}
	private tr(node: Node, code: string): string {
		return this.trace ? `TR(${node.id}, ${code})` : code;
	}
	private err(node: Node, code: string, message: string, severity: Diagnostic['severity'] = 'error') {
		this.diags.push({ severity, code, message, start: node.start, end: node.end });
	}

	/** Static: does this node always produce a number? */
	isNumeric(node: Node): boolean {
		switch (node.type) {
			case 'Number':
			case 'Unary':
			case 'Binary':
			case 'Logical':
			case 'This':
				return true;
			case 'Call':
				return node.callee.ns === 'math' || BUILTIN_QUERIES.has(node.callee.full);
			case 'Name':
				return node.ns === 'math';
			case 'Ternary':
				return this.isNumeric(node.consequent) && (!node.alternate || this.isNumeric(node.alternate));
			default:
				return false;
		}
	}

	/** Constant folding: returns the folded value or null */
	fold(node: Node): number | null {
		const f = (n: number) => (this.f32 ? Math.fround(n) : n);
		switch (node.type) {
			case 'Number':
				return f(node.value);
			case 'Name':
				return node.ns === 'math' && node.path === 'pi' ? f(Math.PI) : null;
			case 'Unary': {
				const a = this.fold(node.arg);
				if (a === null) return null;
				return node.op === '-' ? -a : a === 0 ? 1 : 0;
			}
			case 'Binary': {
				const a = this.fold(node.left);
				const b = this.fold(node.right);
				if (a === null || b === null) return null;
				switch (node.op) {
					case '+':
						return f(a + b);
					case '-':
						return f(a - b);
					case '*':
						return f(a * b);
					case '/':
						return b === 0 ? null : f(a / b); // keep runtime div-zero error
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
					case '!=':
						return a !== b ? 1 : 0;
				}
				return null;
			}
			case 'Logical': {
				const a = this.fold(node.left);
				const b = this.fold(node.right);
				if (a === null || b === null) return null;
				return node.op === '&&' ? (a !== 0 && b !== 0 ? 1 : 0) : a !== 0 || b !== 0 ? 1 : 0;
			}
			case 'Ternary': {
				const t = this.fold(node.test);
				if (t === null) return null;
				if (t !== 0) return this.fold(node.consequent);
				return node.alternate ? this.fold(node.alternate) : 0;
			}
			case 'Call': {
				if (node.callee.ns !== 'math') return null;
				const fn = FOLD_MATH[node.callee.path];
				if (!fn || this.o.radians) return null;
				const entry = this.math[node.callee.path];
				if (!entry || node.args.length < entry.min || node.args.length > entry.max) return null;
				const args: number[] = [];
				for (const a of node.args) {
					const v = this.fold(a);
					if (v === null) return null;
					args.push(v);
				}
				return f(fn(...args));
			}
		}
		return null;
	}

	// ---- names

	private readRaw(node: NameNode): { code: string; kind: 0 | 1 | 2; slot: number } | null {
		switch (node.ns) {
			case 'variable': {
				const s = this.sym.variable(node.full);
				return { code: `v[${s}]`, kind: 0, slot: s };
			}
			case 'temp': {
				const s = this.sym.temp(node.full);
				return { code: `(T.g[${s}] === T.gen ? T.v[${s}] : undefined)`, kind: 1, slot: s };
			}
			case 'context': {
				const s = this.sym.context(node.full);
				return { code: `(E.c === null ? undefined : E.c[${s}])`, kind: 2, slot: s };
			}
		}
		return null;
	}

	private nameNum(node: NameNode): string {
		if (node.ns === 'math') {
			if (node.path === 'pi') return lit(this.f32 ? Math.fround(Math.PI) : Math.PI);
			return '0';
		}
		const raw = this.readRaw(node);
		if (!raw) {
			this.notAvailable(node);
			return '0';
		}
		const t = this.tmp();
		if (this.soft) return `(typeof (${t} = ${raw.code}) === "number" ? ${t} : SOFTN(E, ${t}, ${node.id}))`;
		return `(typeof (${t} = ${raw.code}) === "number" ? ${t} : RV(E, ${t}, ${raw.kind}, ${raw.slot}, ${node.id}))`;
	}

	private nameVal(node: NameNode): string {
		if (node.ns === 'math') return this.nameNum(node);
		const raw = this.readRaw(node);
		if (!raw) {
			this.notAvailable(node);
			return '0';
		}
		const t = this.tmp();
		if (this.soft) return `((${t} = ${raw.code}) === undefined ? SOFTV() : ${t})`;
		return `((${t} = ${raw.code}) === undefined ? MV(E, ${raw.kind}, ${raw.slot}, ${node.id}) : ${t})`;
	}

	private notAvailable(node: NameNode) {
		if (node.ns === 'unknown') return; // already reported by the parser
		this.err(node, 'not-available', `${node.ns}.* is not available in particle Molang`);
	}

	// ---- expressions

	num(node: Node): string {
		const k = this.fold(node);
		if (k !== null && !this.trace) return lit(k);
		return this.tr(node, this.numInner(node));
	}

	private numInner(node: Node): string {
		switch (node.type) {
			case 'Number':
				return lit(this.f32 ? Math.fround(node.value) : node.value);
			case 'String':
				return `(E.err("string-math", ${node.id}), 0)`;
			case 'Name':
				return this.nameNum(node);
			case 'This':
				return 'E.self';
			case 'Unary':
				return node.op === '-' ? `(-${this.num(node.arg)})` : `(${this.num(node.arg)} === 0 ? 1 : 0)`;
			case 'Binary':
				return this.binary(node);
			case 'Logical':
				return node.op === '&&'
					? `(${this.num(node.left)} !== 0 ? (${this.num(node.right)} !== 0 ? 1 : 0) : 0)`
					: `(${this.num(node.left)} !== 0 ? 1 : (${this.num(node.right)} !== 0 ? 1 : 0))`;
			case 'Ternary':
				return `(${this.num(node.test)} !== 0 ? ${this.num(node.consequent)} : ${node.alternate ? this.num(node.alternate) : '0'})`;
			case 'Call':
				if (node.callee.ns === 'math') return this.mathCall(node);
				return this.toNum(this.callVal(node), node);
			case 'Coalesce':
			case 'Assign':
			case 'Index':
			case 'Arrow':
				return this.toNum(this.valInner(node), node);
			case 'Block':
			case 'Loop':
			case 'ForEach':
				return `(${this.iife(node)}, 0)`;
			case 'Return':
			case 'Break':
			case 'Continue':
				this.err(node, 'syntax', `'${node.type.toLowerCase()}' can't be used as a value here`);
				return '0';
			case 'Error':
				return '0';
		}
	}

	private toNum(code: string, node: Node): string {
		const t = this.tmp();
		return `(typeof (${t} = ${code}) === "number" ? ${t} : TN(E, ${t}, ${node.id}))`;
	}

	val(node: Node): string {
		if (this.isNumeric(node)) return this.num(node);
		return this.tr(node, this.valInner(node));
	}

	private valInner(node: Node): string {
		switch (node.type) {
			case 'String':
				return JSON.stringify(node.value);
			case 'Name':
				return this.nameVal(node);
			case 'Ternary':
				return `(${this.num(node.test)} !== 0 ? ${this.val(node.consequent)} : ${node.alternate ? this.val(node.alternate) : '0'})`;
			case 'Coalesce':
				return this.coalesce(node);
			case 'Assign':
				// an assignment has the assigned value: v.a = (v.b = 3) sets both (t72 b4)
				return `(${this.assignExpr(node)})`;
			case 'Call':
				if (node.callee.ns === 'math') return this.mathCall(node);
				return this.callVal(node);
			case 'Index':
			case 'Arrow':
				if (this.o.context !== 'generic') this.err(node, 'not-available', `${node.type === 'Arrow' ? "'->'" : 'Array access'} is not available in particle Molang`);
				return '0';
			default:
				return this.numInner(node);
		}
	}

	private binary(node: Extract<Node, { type: 'Binary' }>): string {
		const { op } = node;
		// a string literal in arithmetic or an ordering comparison is a load error in the game: "'Less Than '<''
		// expression cannot take a 'String' argument. It only supports numerical arguments." (t73 s1, s2)
		if (op !== '==' && op !== '!=' && (node.left.type === 'String' || node.right.type === 'String')) {
			this.err(node, 'string-operand', `'${OP_NAMES[op] ?? op} ${op}' can't take a string: it only supports numbers`);
			return '0';
		}
		if (op === '==' || op === '!=') {
			const both = this.isNumeric(node.left) && this.isNumeric(node.right);
			const a = both ? this.num(node.left) : this.val(node.left);
			const b = both ? this.num(node.right) : this.val(node.right);
			return op === '==' ? `(${a} === ${b} ? 1 : 0)` : `(${a} !== ${b} ? 1 : 0)`;
		}
		const a = this.num(node.left);
		const b = this.num(node.right);
		switch (op) {
			case '+':
			case '-':
			case '*':
				return this.F(`(${a} ${op} ${b})`);
			case '/': {
				const ta = this.tmp();
				const td = this.tmp();
				const dynamicDivisor = node.right.type !== 'Number' && this.fold(node.right) === null;
				const divisor = !this.features.negativeDivisorFix && dynamicDivisor ? `Math.abs(${td})` : td;
				return `(${ta} = ${a}, (${td} = ${b}) === 0 ? DZ(E, ${node.id}) : ${this.F(`${ta} / ${divisor}`)})`;
			}
			default:
				return `(${a} ${op} ${b} ? 1 : 0)`;
		}
	}

	private coalesce(node: Extract<Node, { type: 'Coalesce' }>): string {
		const left = node.left;
		// the game logs this at load, but keeps the field, and ?? still catches a missing member (t67 m2–m4, m8)
		if (hasMember(left)) {
			this.err(left, 'member-coalesce', "found left-hand-side of ?? expression that isn't a direct-variable reference - this is unsupported at this time. The game logs this when it loads the effect, then runs it anyway", 'warning');
		}
		if (left.type === 'Name' && (left.ns === 'variable' || left.ns === 'temp' || left.ns === 'context')) {
			const raw = this.readRaw(left)!;
			const t = this.tmp();
			const read = `(${t} = ${raw.code}) === undefined && E.lookup ? (${t} = E.lookup(${raw.kind}, ${raw.slot})) : ${t}`;
			return `((${read}) === undefined ? ${this.val(node.right)} : ${this.trace ? `TR(${left.id}, ${t})` : t})`;
		}
		this.soft++;
		this.fnDepth++;
		const l = this.val(left);
		this.fnDepth--;
		this.soft--;
		return `(function () { try { return ${l}; } catch (e) { if (e !== MISSING) throw e; } return ${this.val(node.right)}; })()`;
	}

	private assignExpr(node: Extract<Node, { type: 'Assign' }>): string {
		const target = node.target;
		if (target.ns === 'temp' && target.path.includes('.')) {
			// t67 m10: logged at load, but it runs
			this.err(target, 'temp-member', 'left side of an assignment expression can only use temp variables if they are on their own and not part of a more complicated expression. The game logs this when it loads the effect, then runs it anyway', 'warning');
		}
		const clear = this.clearParents(target);
		const call = node.value.type === 'Call' && node.value.callee.ns === 'query' ? node.value : null;
		const members = call ? STRUCT_QUERIES[call.callee.full] : undefined;
		if (call && members) return withClear(clear, this.structAssign(node, call, members));
		const value = this.isNumeric(node.value) ? this.num(node.value) : this.val(node.value);
		const kind = target.ns === 'variable' ? 0 : 1;
		const s = kind === 0 ? this.sym.variable(target.full) : this.sym.temp(target.full);
		let assign: string;
		if (kind === 0) assign = this.trace ? `TR(${node.id}, v[${s}] = ${value})` : `v[${s}] = ${value}`;
		else {
			const t = this.tmp();
			assign = `(${t} = ${value}, T.v[${s}] = ${t}, T.g[${s}] = T.gen${this.trace ? `, TR(${node.id}, ${t})` : ''}, ${t})`;
		}
		// v.d = v.a where v.a is a struct: a copy of every member (t67 m5, t68 s4/s5)
		const src = node.value;
		if (src.type === 'Name' && (src.ns === 'variable' || src.ns === 'temp')) {
			const raw = this.readRaw(src)!;
			assign = `(${raw.code} === undefined && SC(E, ${raw.kind}, ${raw.slot}, ${kind}, ${s}) ? 0 : (${assign}))`;
		}
		return withClear(clear, assign);
	}

	/** Setting `v.a.b` replaces a number held by `v.a` (t68 s2): the names it's a member of are cleared first */
	private clearParents(target: NameNode): string[] {
		if (target.ns !== 'variable' && target.ns !== 'temp') return [];
		const out: string[] = [];
		const full = target.full;
		for (let dot = full.indexOf('.', full.indexOf('.') + 1); dot !== -1; dot = full.indexOf('.', dot + 1)) {
			const parent = full.slice(0, dot);
			out.push(target.ns === 'variable' ? `CL(E, 0, ${this.sym.variable(parent)})` : `CL(E, 1, ${this.sym.temp(parent)})`);
		}
		return out;
	}

	/** `v.o = q.bone_origin('head')`: one query call per member of the struct, into `v.o.x`, `v.o.y`, … */
	private structAssign(node: Extract<Node, { type: 'Assign' }>, call: CallNode, members: readonly string[]): string {
		if (!this.knownQuery(call)) return '0';
		const target = node.target;
		const args = this.tmp();
		const parts = [`${args} = ${call.args.length ? `[${call.args.map((a) => this.val(a)).join(', ')}]` : 'EA'}`];
		// a member without a value reads 0: a bone query that finds no bone logs an error, fills the struct with zeros
		// and the expression goes on (e17 b1, e20 b6, t80 b2); setting the members replaces a number held by its name
		const own = target.ns === 'variable' ? `CL(E, 0, ${this.sym.variable(target.full)})` : `CL(E, 1, ${this.sym.temp(target.full)})`;
		for (const m of members) {
			const q = `QS(E, ${this.sym.query(`${call.callee.full}.${m}`)}, ${args}, ${call.id})`;
			const name = `${target.full}.${m}`;
			const t = this.tmp();
			if (target.ns === 'variable') parts.push(`${t} = ${q}, ${own}, v[${this.sym.variable(name)}] = ${t} === undefined ? 0 : ${t}`);
			else {
				const s = this.sym.temp(name);
				parts.push(`${t} = ${q}, ${own}, T.v[${s}] = ${t} === undefined ? 0 : ${t}, T.g[${s}] = T.gen`);
			}
		}
		return `(${parts.join(', ')}${this.trace ? `, TR(${node.id}, 0)` : ''}, 0)`;
	}

	private mathCall(node: CallNode): string {
		const name = node.callee.path;
		const entry = this.math[name];
		if (!entry) {
			if (name !== 'pi') this.err(node.callee, 'unknown-function', `Unknown math function 'math.${name}'`);
			return name === 'pi' ? lit(this.f32 ? Math.fround(Math.PI) : Math.PI) : '0';
		}
		if (node.args.length < entry.min || node.args.length > entry.max) {
			this.err(node, 'arity', `math.${name} takes ${entry.min === entry.max ? entry.min : `${entry.min}-${entry.max}`} argument${entry.max === 1 ? '' : 's'}, got ${node.args.length}`);
			return '0';
		}
		const args = node.args.map((a) => this.num(a));
		return this.F(entry.gen(args, 'E'));
	}

	private callVal(node: CallNode): string {
		const full = node.callee.full;
		if (node.callee.ns !== 'query') return '0';
		if (BUILTIN_QUERIES.has(full)) {
			switch (full) {
				case 'query.in_range':
					if (node.args.length !== 3) {
						this.err(node, 'arity', 'query.in_range takes 3 arguments (value, min, max)');
						return '0';
					}
					return `M.inRange(${node.args.map((a) => this.num(a)).join(', ')})`;
				case 'query.approx_eq':
					return `M.approxEq(${node.args.map((a) => this.num(a)).join(', ')})`;
				case 'query.all':
					return `M.all(${node.args.map((a) => this.val(a)).join(', ')})`;
				case 'query.any':
					return `M.any(${node.args.map((a) => this.val(a)).join(', ')})`;
			}
		}
		if (!this.knownQuery(node)) return '0';
		const id = this.sym.query(full);
		const args = node.args.length ? `[${node.args.map((a) => this.val(a)).join(', ')}]` : 'EA';
		// a struct query anywhere but on the right of an assignment is a load error in the game ("Add '+' expression
		// cannot take a struct", e17 b2); assign it to a variable and read its members
		if (STRUCT_QUERIES[full]) {
			this.err(node, 'struct-query', `${full} returns a struct: assign it to a variable (v.o = ${node.callee.raw}(…);) and read its members (v.o.${STRUCT_QUERIES[full][0]})`);
			return '0';
		}
		return `E.q(${id}, ${args}, ${node.id})`;
	}

	/** Unknown or unsupported queries are load errors, as in the game */
	private knownQuery(node: CallNode): boolean {
		const full = node.callee.full;
		if (!this.o.queryExists || this.o.queryExists(full)) return true;
		this.err(node, 'unknown-query', `Failed to resolve query ${full}.  Either the query does not exist or it is not supported in this context.`);
		return false;
	}

	private iife(node: Node): string {
		this.fnDepth++;
		const body = this.stmt(node);
		this.fnDepth--;
		return `(function () { ${body} })()`;
	}

	// ---- statements

	stmt(node: Node): string {
		const prefix = this.step ? `yield ${node.id}; ` : '';
		return prefix + this.stmtInner(node);
	}

	private stmtInner(node: Node): string {
		switch (node.type) {
			case 'Assign':
				return `${this.assignExpr(node)};`;
			case 'Ternary': {
				const test = this.num(node.test);
				const cons = this.stmt(node.consequent);
				const alt = node.alternate ? this.stmt(node.alternate) : '';
				return `if (${test} !== 0) { ${cons} }${alt ? ` else { ${alt} }` : ''}`;
			}
			case 'Logical':
				if (node.right.type === 'Block' || node.right.type === 'Assign' || node.right.type === 'Break' || node.right.type === 'Continue' || node.right.type === 'Return') {
					const test = this.num(node.left);
					return node.op === '&&' ? `if (${test} !== 0) { ${this.stmt(node.right)} }` : `if (${test} === 0) { ${this.stmt(node.right)} }`;
				}
				return `${this.val(node)};`;
			case 'Block':
				return `{ ${node.body.map((s) => this.stmt(s)).join(' ')} }`;
			case 'Loop': {
				const count = this.num(node.count);
				const label = `L${this.labelCount++}`;
				const n = this.tmp();
				const i = this.tmp();
				this.loopLabels.push(label);
				const savedDepth = this.fnDepth;
				const body = this.stmt(node.body);
				this.loopLabels.pop();
				void savedDepth;
				// a fractional count rounds up (2.4 and 2.5 run 3 times, 0.5 once); no cap: 200,000 iterations ran (t72, t78).
				// A cap still guards against a runaway count freezing the editor.
				return `${n} = Math.ceil(${count}); if (${n} > ${LOOP_GUARD}) ${n} = ${LOOP_GUARD}; ${label}: for (${i} = 0; ${i} < ${n}; ${i}++) { ${body} }`;
			}
			case 'ForEach':
				if (this.o.context !== 'generic') this.err(node, 'not-available', 'for_each is not available in particle Molang');
				return '';
			case 'Return':
				if (this.fnDepth > 0) {
					this.err(node, 'unsupported', "'return' inside this construct isn't supported");
					return '';
				}
				return `return ${node.arg ? this.val(node.arg) : '0'};`;
			case 'Break':
			case 'Continue': {
				const label = this.loopLabels[this.loopLabels.length - 1];
				if (!label) return ''; // parser already reported
				return `${node.type === 'Break' ? 'break' : 'continue'} ${label};`;
			}
			case 'Error':
				return '';
			default:
				return `${this.val(node)};`;
		}
	}

	program(p: Program): string {
		if (!p.complex) {
			if (p.body.length === 0) return 'return 0;';
			const only = p.body[0];
			if (only.type === 'Assign' || only.type === 'Loop' || only.type === 'Block' || only.type === 'ForEach') {
				return `${this.stmt(only)} return 0;`;
			}
			return `${this.step ? `yield ${only.id}; ` : ''}return ${this.val(only)};`;
		}
		return `${p.body.map((s) => this.stmt(s)).join(' ')} return 0;`;
	}
}

/** Called by generated code when a string or unset value reaches a numeric context */
function TN(E: Env, value: Value, node: number): number {
	if (typeof value === 'number') return value;
	E.err('string-math', node);
	return 0;
}
function DZ(E: Env, node: number): number {
	E.err('div-zero', node);
	return 0;
}
function SOFTN(E: Env, value: Value | undefined, node: number): number {
	if (value === undefined) throw MISSING;
	return TN(E, value, node);
}
function SOFTV(): never {
	throw MISSING;
}
const EA: Value[] = Object.freeze([]) as unknown as Value[];
/** Loops have no iteration cap in the game; this only stops a runaway count (NaN counts run 0 times) */
const LOOP_GUARD = 1_000_000;
/** A query that may have no value: the engine's soft dispatch when it has one */
function QS(E: Env, id: number, args: Value[], node: number): Value | undefined {
	return E.qs ? E.qs(id, args, node) : E.q(id, args, node);
}
const OP_NAMES: Record<string, string> = { '+': 'Add', '-': 'Subtract', '*': 'Multiply', '/': 'Divide', '<': 'Less Than', '<=': 'Less Than or Equal', '>': 'Greater Than', '>=': 'Greater Than or Equal' };

/** `code`, with `clear` run first */
function withClear(clear: string[], code: string): string {
	return clear.length ? `(${clear.join(', ')}, ${code})` : code;
}

/** Does this expression read a member of a struct (`v.a.b`)? */
function hasMember(node: Node): boolean {
	if (node.type === 'Name') return (node.ns === 'variable' || node.ns === 'temp' || node.ns === 'context') && node.path.includes('.');
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const v of value) if (v && typeof v === 'object' && 'type' in v && hasMember(v as Node)) return true;
		} else if (value && typeof value === 'object' && 'type' in value && hasMember(value as Node)) return true;
	}
	return false;
}

function buildFunction(js: string, step: boolean, f32: boolean) {
	const factory = new Function(
		'F', 'M', 'EZ', 'DEG', 'RV', 'MV', 'TN', 'DZ', 'SOFTN', 'SOFTV', 'MISSING', 'EA', 'SC', 'CL', 'QS',
		`"use strict"; return ${step ? 'function*' : 'function'} molang(E) { var v = E.v, T = E.t, TR = E.trace; ${js} };`,
	);
	return factory(f32 ? Math.fround : (x: number) => x, M, EASINGS, DEG, readVarSlow, missingValue, TN, DZ, SOFTN, SOFTV, MISSING, EA, copyStruct, clearSlot, QS);
}

const ZERO_RUN = () => 0;

interface CacheEntry {
	key: string;
	result: CompiledExpression;
}
const caches = new WeakMap<SymbolTable, Map<string, CacheEntry>>();
const CACHE_LIMIT = 10000;

/**
 * Compile Molang source to a JS function. Numbers (JSON numeric fields) compile to constants.
 * Results are cached per SymbolTable.
 */
export function compile(source: string | number, options: CompileOptions): CompiledExpression {
	const features = resolveFeatures(options);
	const version = typeof options.version === 'number' ? options.version : null;
	const f32 = options.f32 !== false;
	if (typeof source === 'number') {
		const value = f32 ? Math.fround(source) : source;
		const program: Program = { type: 'Program', body: [], complex: false, start: 0, end: 0, nodeCount: 0, comments: [], source: String(source), version, features };
		return { source: String(source), program, diagnostics: [], ok: true, complex: false, constant: value, run: () => value, js: `return ${lit(value)};` };
	}
	const mode = options.mode ?? 'fast';
	const fkey = `${+features.strictErrors}${+features.ternaryRightAssoc}${+features.logicalPrecedence}${+features.negativeDivisorFix}`;
	const key = `${fkey}|${version}|${f32 ? 1 : 0}|${mode}|${options.context ?? 'particle'}|${options.radians ? 1 : 0}|${options.comments ? 1 : 0}|${options.queryExists ? 'q' : ''}|${source}`;
	let cache = caches.get(options.symbols);
	if (!cache) caches.set(options.symbols, (cache = new Map()));
	const hit = cache.get(key);
	if (hit) {
		// refresh LRU position
		cache.delete(key);
		cache.set(key, hit);
		return hit.result;
	}

	const { program, diagnostics } = parse(source, { features, version, comments: options.comments });
	const gen = new CodeGen(options.symbols, { ...options, features, f32, mode }, diagnostics);
	let constant: number | null = null;
	if (!program.complex && program.body.length === 1) constant = gen.fold(program.body[0]);
	if (!program.complex && program.body.length === 0) constant = 0;
	const body = gen.program(program);
	const js = `${gen.declareTemps()} ${body}`;
	const ok = !diagnostics.some((d) => d.severity === 'error');

	let run: (E: Env) => Value = ZERO_RUN;
	let step: CompiledExpression['step'];
	try {
		if (mode === 'step') {
			const g = buildFunction(js, true, f32);
			step = g;
			run = (E: Env) => {
				const it = g(E) as Generator<number, Value, void>;
				let r = it.next();
				while (!r.done) r = it.next();
				return r.value;
			};
		} else if (constant !== null && mode === 'fast') {
			const k = constant;
			run = () => k;
		} else {
			run = buildFunction(js, false, f32);
		}
	} catch (e) {
		diagnostics.push({ severity: 'error', code: 'internal', message: `Internal compile error: ${(e as Error).message}`, start: 0, end: source.length });
	}
	const result: CompiledExpression = { source, program, diagnostics, ok, complex: program.complex, constant, run, step, js };
	cache.set(key, { key, result });
	if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	return result;
}

/** Run a compiled expression, turning an abort (unsetMode 'abort') into 0.0 like Bedrock. */
export function evaluate(expr: CompiledExpression, E: Env): Value {
	try {
		return expr.run(E);
	} catch (e) {
		if (e instanceof MolangAbort) return 0;
		throw e;
	}
}

/** Numeric evaluation (strings in numeric fields are a content error → 0) */
export function evaluateNumber(expr: CompiledExpression, E: Env): number {
	const v = evaluate(expr, E);
	if (typeof v === 'number') return v;
	E.err('string-math', -1);
	return 0;
}
