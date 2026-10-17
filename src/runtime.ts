/** Runtime pieces shared by compiled Molang: values, symbol interning, temp scopes, math semantics. */

export type Value = number | string;

/** Content-error codes raised while evaluating (mirrors the categories Bedrock logs) */
export type MolangErrorCode =
	| 'unset-variable'
	| 'unset-temp'
	| 'unset-context'
	| 'div-zero'
	| 'string-math'
	| 'string-compare'
	| 'unknown-query'
	| 'unsupported'
	| 'nan';

/**
 * Interns Molang names to integer slots so compiled code indexes arrays instead of hashing strings.
 * One table is shared by all expressions of an effect (and its variable maps).
 */
export class SymbolTable {
	readonly variables = new Map<string, number>();
	readonly variableNames: string[] = [];
	readonly temps = new Map<string, number>();
	readonly tempNames: string[] = [];
	readonly contexts = new Map<string, number>();
	readonly contextNames: string[] = [];
	readonly queries = new Map<string, number>();
	readonly queryNames: string[] = [];

	private intern(map: Map<string, number>, names: string[], key: string): number {
		let id = map.get(key);
		if (id === undefined) {
			id = names.length;
			names.push(key);
			map.set(key, id);
		}
		return id;
	}
	/** `variable.foo` → slot */
	variable(full: string): number {
		return this.intern(this.variables, this.variableNames, full.toLowerCase());
	}
	temp(full: string): number {
		return this.intern(this.temps, this.tempNames, full.toLowerCase());
	}
	context(full: string): number {
		return this.intern(this.contexts, this.contextNames, full.toLowerCase());
	}
	query(full: string): number {
		return this.intern(this.queries, this.queryNames, full.toLowerCase());
	}
}

/**
 * Temporary variables. Bedrock clears `t.*` per expression execution — except across the steps of
 * an event `sequence`, which is how "temp leaking" passes data into a child's pre_effect_expression.
 * Clearing is O(1): bump the generation instead of wiping the array.
 */
export class TempScope {
	v: Value[] = [];
	g: number[] = [];
	gen = 1;
	reset(): void {
		this.gen++;
	}
	get(slot: number): Value | undefined {
		return this.g[slot] === this.gen ? this.v[slot] : undefined;
	}
	set(slot: number, value: Value): void {
		this.v[slot] = value;
		this.g[slot] = this.gen;
	}
	/** Snapshot of live temps (debugger) */
	entries(names: string[]): [string, Value][] {
		const out: [string, Value][] = [];
		for (let i = 0; i < this.v.length; i++) if (this.g[i] === this.gen) out.push([names[i], this.v[i]]);
		return out;
	}
}

/** Thrown to abort an expression (used when unset reads are configured to abort). */
export class MolangAbort extends Error {
	constructor(readonly code: MolangErrorCode, readonly node: number) {
		super(code);
	}
}
/** Internal: signals a missing name inside the left side of `??` */
export const MISSING = Symbol('molang-missing');

export type QueryFn = (id: number, args: Value[], node: number) => Value;

/** Everything a compiled expression reads from. Engines create one per emitter and reuse it. */
export interface Env {
	/** variable.* slots (the emitter's shared variable map) */
	v: Value[];
	t: TempScope;
	/** context.* slots, or null when no context is available */
	c: Value[] | null;
	/** Query dispatch (ids from the SymbolTable) */
	q: QueryFn;
	/** Uniform random in [0, 1) */
	rnd: () => number;
	/** Content-error sink */
	err: (code: MolangErrorCode, node: number, detail?: string) => void;
	/** `this` */
	self: number;
	/** Trace sink for 'trace' mode (value lenses / expression trace) */
	trace: ((node: number, value: Value) => Value) | null;
	/** How unset reads behave: 'zero' (game default: 0.0 + content error) or 'abort' (stop the expression) */
	unsetMode: 'zero' | 'abort';
	/** Optional resolver consulted before an unset read errors (kind 0 = variable, 1 = temp, 2 = context) */
	lookup?: ((kind: 0 | 1 | 2, slot: number) => Value | undefined) | null;
}

export function createEnv(partial: Partial<Env> = {}): Env {
	return {
		v: [],
		t: new TempScope(),
		c: null,
		q: () => 0,
		rnd: Math.random,
		err: () => {},
		self: 0,
		trace: null,
		// In-game an unset read aborts the whole expression (it evaluates to 0.0): Oxygen test t01
		unsetMode: 'abort',
		...partial,
	};
}

// ---------- slow paths called from generated code (kept out of line so the fast path stays small)

/** Numeric read of a variable slot that was undefined or a string */
export function readVarSlow(E: Env, value: Value | undefined, kind: 0 | 1 | 2, slot: number, node: number): number {
	if (value === undefined && E.lookup) value = E.lookup(kind, slot);
	if (value === undefined) {
		const code: MolangErrorCode = kind === 0 ? 'unset-variable' : kind === 1 ? 'unset-temp' : 'unset-context';
		E.err(code, node);
		if (E.unsetMode === 'abort') throw new MolangAbort(code, node);
		return 0;
	}
	if (typeof value === 'string') {
		E.err('string-math', node);
		return 0;
	}
	return value;
}

/** Value read of an unset slot */
export function missingValue(E: Env, kind: 0 | 1 | 2, slot: number, node: number): Value {
	if (E.lookup) {
		const r = E.lookup(kind, slot);
		if (r !== undefined) return r;
	}
	const code: MolangErrorCode = kind === 0 ? 'unset-variable' : kind === 1 ? 'unset-temp' : 'unset-context';
	E.err(code, node);
	if (E.unsetMode === 'abort') throw new MolangAbort(code, node);
	return 0;
}

export function toNum(E: Env, value: Value, node: number): number {
	if (typeof value === 'number') return value;
	E.err('string-math', node);
	return 0;
}

export function equals(a: Value, b: Value): boolean {
	return a === b;
}

// ---------- math (Bedrock semantics; angles in degrees)

export const DEG = Math.PI / 180;

function bounceOut(x: number): number {
	const n1 = 7.5625;
	const d1 = 2.75;
	if (x < 1 / d1) return n1 * x * x;
	if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
	if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
	return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

/** Easing curves (easings.net definitions), applied as lerp(start, end, ease(t)) */
export const EASINGS: Record<string, (x: number) => number> = {
	ease_in_quad: (x) => x * x,
	ease_out_quad: (x) => 1 - (1 - x) * (1 - x),
	ease_in_out_quad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
	ease_in_cubic: (x) => x * x * x,
	ease_out_cubic: (x) => 1 - Math.pow(1 - x, 3),
	ease_in_out_cubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
	ease_in_quart: (x) => x * x * x * x,
	ease_out_quart: (x) => 1 - Math.pow(1 - x, 4),
	ease_in_out_quart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
	ease_in_quint: (x) => x * x * x * x * x,
	ease_out_quint: (x) => 1 - Math.pow(1 - x, 5),
	ease_in_out_quint: (x) => (x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2),
	ease_in_sine: (x) => 1 - Math.cos((x * Math.PI) / 2),
	ease_out_sine: (x) => Math.sin((x * Math.PI) / 2),
	ease_in_out_sine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
	ease_in_expo: (x) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
	ease_out_expo: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
	ease_in_out_expo: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
	ease_in_circ: (x) => 1 - Math.sqrt(1 - Math.pow(x, 2)),
	ease_out_circ: (x) => Math.sqrt(1 - Math.pow(x - 1, 2)),
	ease_in_out_circ: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2),
	ease_in_back: (x) => c3 * x * x * x - c1 * x * x,
	ease_out_back: (x) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2),
	ease_in_out_back: (x) => (x < 0.5 ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2 : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
	ease_in_elastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4)),
	ease_out_elastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
	ease_in_out_elastic: (x) =>
		x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2 : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
	ease_in_bounce: (x) => 1 - bounceOut(1 - x),
	ease_out_bounce: bounceOut,
	ease_in_out_bounce: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
};

/** Math helpers called by generated code. Kept as plain functions for inlining. */
export const M = {
	round(x: number): number {
		// C/C++ std::round: halves round away from zero (JS Math.round rounds -2.5 to -2)
		return x < 0 ? -Math.round(-x) : Math.round(x);
	},
	clamp(v: number, lo: number, hi: number): number {
		return v < lo ? lo : v > hi ? hi : v;
	},
	lerp(a: number, b: number, t: number): number {
		return a + (b - a) * t;
	},
	inverseLerp(a: number, b: number, v: number): number {
		return a === b ? 0 : (v - a) / (b - a);
	},
	lerpRotate(a: number, b: number, t: number): number {
		const diff = ((((b - a) % 360) + 540) % 360) - 180;
		return a + diff * t;
	},
	minAngle(a: number): number {
		// into [-180, 180)
		let r = (a + 180) % 360;
		if (r < 0) r += 360;
		return r - 180;
	},
	hermite(t: number): number {
		return 3 * t * t - 2 * t * t * t;
	},
	sign(x: number): number {
		// In-game (1.26.52): math.sign(0) == 1 — i.e. "1 if value >= 0, -1 otherwise" (the docs say -1)
		return x >= 0 ? 1 : -1;
	},
	copySign(a: number, b: number): number {
		const m = Math.abs(a);
		return b < 0 || Object.is(b, -0) ? -m : m;
	},
	random(rnd: () => number, lo: number, hi: number): number {
		return lo + rnd() * (hi - lo);
	},
	randomInt(rnd: () => number, lo: number, hi: number): number {
		const a = Math.round(lo);
		const b = Math.round(hi);
		return a + Math.floor(rnd() * (b - a + 1));
	},
	dieRoll(rnd: () => number, num: number, lo: number, hi: number): number {
		let s = 0;
		const n = Math.min(Math.trunc(num), 1e6);
		for (let i = 0; i < n; i++) s += lo + rnd() * (hi - lo);
		return s;
	},
	dieRollInt(rnd: () => number, num: number, lo: number, hi: number): number {
		let s = 0;
		const n = Math.min(Math.trunc(num), 1e6);
		for (let i = 0; i < n; i++) s += M.randomInt(rnd, lo, hi);
		return s;
	},
	ease(name: string, a: number, b: number, t: number): number {
		return a + (b - a) * EASINGS[name](t);
	},
	inRange(v: number, lo: number, hi: number): number {
		return v >= lo && v <= hi ? 1 : 0;
	},
	all(v: Value, ...rest: Value[]): number {
		for (const r of rest) if (r !== v) return 0;
		return 1;
	},
	any(v: Value, ...rest: Value[]): number {
		for (const r of rest) if (r === v) return 1;
		return 0;
	},
	approxEq(v: number, ...rest: number[]): number {
		for (const r of rest) if (Math.abs(v - r) > 1e-7) return 0;
		return 1;
	},
};

/** Built-in pure queries that Molang evaluates itself. */
export const BUILTIN_QUERIES = new Set(['query.in_range', 'query.all', 'query.any', 'query.approx_eq']);

/** Deterministic PRNG (mulberry32) — reproducible simulations / replays. */
export function createRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
