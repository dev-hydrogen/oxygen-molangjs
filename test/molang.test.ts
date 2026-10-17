import { describe, expect, it } from 'vitest';
import { analyze, compile, createEnv, evaluate, featuresForEngine, format, LATEST_FEATURES, Molang, parse, SymbolTable, TempScope, type Env, type MolangErrorCode } from '../src/index';

function run(src: string, opts: { version?: number; f32?: boolean; env?: Partial<Env>; symbols?: SymbolTable } = {}) {
	const symbols = opts.symbols ?? new SymbolTable();
	const errors: MolangErrorCode[] = [];
	const expr = compile(src, { symbols, version: opts.version, f32: opts.f32 ?? false });
	const env = createEnv({ err: (c) => errors.push(c), ...opts.env });
	const value = evaluate(expr, env);
	const vars: Record<string, unknown> = {};
	symbols.variableNames.forEach((n, i) => {
		if (env.v[i] !== undefined) vars[n] = env.v[i];
	});
	return { value, errors, expr, env, vars, symbols };
}

describe('precedence', () => {
	it('arithmetic', () => {
		expect(run('1 + 2 * 3').value).toBe(7);
		expect(run('(1 + 2) * 3').value).toBe(9);
		expect(run('10 - 4 - 3').value).toBe(3);
		expect(run('100 / 10 / 5').value).toBe(2);
		expect(run('-2 * 3').value).toBe(-6);
		expect(run('2 * -3').value).toBe(-6);
		expect(run('5 - -3').value).toBe(8);
	});
	it('&& binds tighter than || (1.18.20+)', () => {
		expect(run('1 || 0 && 0').value).toBe(1);
		expect(run('0 && 1 || 1').value).toBe(1);
	});
	it('pre-1.18.20 logic: A && B || C == A && (B || C)', () => {
		expect(run('0 && 1 || 1', { version: 4 }).value).toBe(0);
		expect(run('1 || 0 && 0', { version: 4 }).value).toBe(0);
	});
	it('comparison before equality (1.18.20+)', () => {
		expect(run('1 < 2 == 3 > 2').value).toBe(1);
	});
	it('ternary is right-associative from 1.18.10', () => {
		expect(run('1 ? 0 : 1 ? 2 : 3').value).toBe(0);
		expect(run('1 ? 0 : 1 ? 2 : 3', { version: 3 }).value).toBe(3);
	});
	it('nested ternary in the true branch', () => {
		expect(run('1 ? 0 ? 5 : 6 : 7').value).toBe(6);
		expect(run('0 ? 0 ? 5 : 6 : 7').value).toBe(7);
	});
	it('?? is lowest precedence', () => {
		expect(run('v.missing ?? 2 + 3').value).toBe(5);
	});
	it('binary conditional returns 0 when false', () => {
		expect(run('0 ? 5').value).toBe(0);
		expect(run('1 ? 5').value).toBe(5);
	});
});

describe('statements and return', () => {
	it('single expression returns its value', () => {
		expect(run('5').value).toBe(5);
		expect(run('math.sin(90)').value).toBeCloseTo(1);
	});
	it('complex expression without return evaluates to 0.0', () => {
		const r = run('v.a = 1; v.a');
		expect(r.value).toBe(0);
		expect(r.vars['variable.a']).toBe(1);
		expect(run('5;').value).toBe(0);
	});
	it('return supplies the value', () => {
		expect(run('v.a = 2; return v.a * 3;').value).toBe(6);
	});
	it('return stops execution', () => {
		const r = run('v.a = 1; return 4; v.a = 2;');
		expect(r.value).toBe(4);
		expect(r.vars['variable.a']).toBe(1);
	});
	it('later statements see earlier assignments', () => {
		expect(run('t.a = 2; t.b = t.a * 2; return t.b + t.a;').value).toBe(6);
	});
});

describe('names and values', () => {
	it('identifiers are case-insensitive, strings keep case and spaces', () => {
		expect(run("V.Foo = 3; return variable.foo;").value).toBe(3);
		expect(run("'Hello World' == 'Hello World'").value).toBe(1);
		expect(run("'ABC' == 'abc'").value).toBe(0);
	});
	it('unset read aborts the whole expression (in-game t01)', () => {
		const r = run('v.nope + 1');
		expect(r.value).toBe(0);
		expect(r.errors).toContain('unset-variable');
		const s = run('v.a = v.b + 1; v.c = 5;');
		expect(s.vars['variable.a']).toBeUndefined();
		expect(s.vars['variable.c']).toBeUndefined();
	});
	it("unsetMode 'zero' keeps the legacy read-as-0 behaviour", () => {
		const r = run('v.nope + 1', { env: { unsetMode: 'zero' } });
		expect(r.value).toBe(1);
		expect(r.errors).toContain('unset-variable');
	});
	it('?? catches an unset read even inside a complex left side', () => {
		expect(run('(v.x + 1) ?? 9').value).toBe(9);
	});
	it('?? supplies a default for unset variables only', () => {
		expect(run('v.x ?? 7').value).toBe(7);
		expect(run('v.x = 0; return v.x ?? 7;').value).toBe(0);
		expect(run('(v.x + 1) ?? 9').value).toBe(9);
		expect(run('v.x ?? 7').errors).toEqual([]);
	});
	it('lookup hook resolves before erroring', () => {
		const symbols = new SymbolTable();
		const slot = symbols.variable('variable.curve');
		const r = run('v.curve * 2', { symbols, env: { lookup: (k, s) => (k === 0 && s === slot ? 21 : undefined) } });
		expect(r.value).toBe(42);
		expect(r.errors).toEqual([]);
	});
	it('string arithmetic is a content error', () => {
		const r = run("v.s = 'a'; return v.s + 1;");
		expect(r.value).toBe(1);
		expect(r.errors).toContain('string-math');
	});
	it('division by zero yields 0 with a content error', () => {
		const r = run('v.z = 0; return 5 / v.z;');
		expect(r.value).toBe(0);
		expect(r.errors).toContain('div-zero');
	});
	it('pre-1.19.60 divides by the absolute value of a dynamic negative divisor', () => {
		expect(run('v.d = -2; return 10 / v.d;', { version: 5 }).value).toBe(5);
		expect(run('v.d = -2; return 10 / v.d;').value).toBe(-5);
		expect(run('10 / -2', { version: 5 }).value).toBe(-5);
	});
	it('NaN propagates instead of becoming 0', () => {
		expect(Number.isNaN(run('math.sqrt(-1)').value)).toBe(true);
	});
	it('NaN is truthy like in C++', () => {
		expect(run('v.n = math.sqrt(-1); return v.n ? 1 : 2;').value).toBe(1);
	});
});

describe('features', () => {
	it('engine thresholds map to rule sets', () => {
		expect(featuresForEngine('1.18.0')).toMatchObject({ ternaryRightAssoc: false, logicalPrecedence: false, negativeDivisorFix: false });
		expect(featuresForEngine('1.18.10')).toMatchObject({ ternaryRightAssoc: true, logicalPrecedence: false });
		expect(featuresForEngine([1, 18, 20])).toMatchObject({ logicalPrecedence: true, negativeDivisorFix: false });
		expect(featuresForEngine('1.21.0')).toEqual(LATEST_FEATURES);
	});
	it('plain strings follow the pack min_engine_version', () => {
		expect(run2('1 ? 0 : 1 ? 2 : 3', { engine: '1.18.0' })).toBe(3);
		expect(run2('1 ? 0 : 1 ? 2 : 3', { engine: '1.20.0' })).toBe(0);
	});
	it('explicit version wins over the pack engine', () => {
		expect(run2('1 ? 0 : 1 ? 2 : 3', { engine: '1.18.0', version: 12 })).toBe(0);
	});
	it('queryExists turns unknown queries into compile errors', () => {
		const expr = compile('q.not_a_query + 1', { symbols: new SymbolTable(), queryExists: (n) => n === 'query.particle_age' });
		expect(expr.diagnostics.some((d) => d.severity === 'error' && d.message.startsWith('Failed to resolve query query.not_a_query'))).toBe(true);
	});
});

function run2(src: string, o: { engine?: string; version?: number }) {
	return evaluate(compile(src, { symbols: new SymbolTable(), ...o, f32: false }), createEnv());
}

describe('math semantics', () => {
	it('trig in degrees', () => {
		expect(run('math.cos(180)').value).toBeCloseTo(-1);
		expect(run('math.atan2(1, 0)').value).toBeCloseTo(90);
	});
	it('sign(0) is 1 in-game (docs say -1)', () => {
		expect(run('math.sign(0)').value).toBe(1);
		expect(run('math.sign(-0.001)').value).toBe(-1);
		expect(run('math.sign(3)').value).toBe(1);
	});
	it('round halves away from zero', () => {
		expect(run('math.round(-2.5)').value).toBe(-3);
		expect(run('math.round(2.5)').value).toBe(3);
	});
	it('min_angle maps into [-180, 180)', () => {
		expect(run('math.min_angle(180)').value).toBe(-180);
		expect(run('math.min_angle(-190)').value).toBe(170);
		expect(run('math.min_angle(540)').value).toBe(-180);
	});
	it('random functions use the env RNG', () => {
		const env = { rnd: () => 0.5 };
		expect(run('math.random(0, 10)', { env }).value).toBe(5);
		expect(run('math.random_integer(1, 4)', { env }).value).toBe(3);
	});
	it('easing and hermite', () => {
		expect(run('math.ease_in_quad(0, 10, 0.5)').value).toBe(2.5);
		expect(run('math.hermite_blend(0.5)').value).toBe(0.5);
		expect(run('math.ease_in_bounce(0, 1, 1)').value).toBeCloseTo(1);
	});
	it('float32 emulation rounds every operation', () => {
		const f = Math.fround;
		expect(run('0.1 + 0.2', { f32: true }).value).toBe(f(f(0.1) + f(0.2)));
		expect(run('0.1 + 0.2', { f32: false }).value).toBe(0.1 + 0.2);
	});
});

describe('loops', () => {
	it('fibonacci example from the docs', () => {
		const r = run('v.x = 1; v.y = 1; loop(10, { t.x = v.x + v.y; v.x = v.y; v.y = t.x; }); return v.y;');
		expect(r.value).toBe(144);
	});
	it('break exits the innermost loop (docs example = 15)', () => {
		expect(run('v.x = 0; loop(10, {loop(10, {v.x = v.x + 1; (v.x > 5) ? break;});}); return v.x;').value).toBe(15);
	});
	it('continue skips (docs example = 6)', () => {
		expect(run('v.x = 0; loop(10, { (v.x > 5) ? continue; v.x = v.x + 1; }); return v.x;').value).toBe(6);
	});
	it('caps at 1024 iterations', () => {
		expect(run('v.c = 0; loop(5000, { v.c = v.c + 1; }); return v.c;').value).toBe(1024);
	});
	it('return inside a loop returns from the expression', () => {
		expect(run('v.i = 0; loop(10, { v.i = v.i + 1; (v.i == 3) ? return v.i * 10; }); return -1;').value).toBe(30);
	});
});

describe('temps', () => {
	it('are cleared between executions unless the scope is shared (temp leaking)', () => {
		const symbols = new SymbolTable();
		const t = new TempScope();
		const set = compile('t.x = 42;', { symbols });
		const get = compile('t.x ?? -1', { symbols });
		const env = createEnv({ t });
		evaluate(set, env);
		expect(evaluate(get, env)).toBe(42); // same scope (event sequence) → leaks
		t.reset();
		expect(evaluate(get, env)).toBe(-1); // new execution → cleared
	});
});

describe('errors', () => {
	it.each([
		['1+(2 3)', 'missing operator'],
		['"abc"', 'double quotes'],
		['abc + 1', 'unknown identifier'],
		['v.a = ', 'incomplete'],
		['math.sin(1', 'unclosed paren'],
		['math.nope(1)', 'unknown math function'],
		['math.sin(1, 2)', 'wrong arity'],
		['break', 'break outside loop'],
	])('%s → error (%s)', (src) => {
		const { expr } = run(src);
		expect(expr.ok).toBe(false);
		expect(expr.diagnostics.length).toBeGreaterThan(0);
	});
	it('reports positions', () => {
		const { diagnostics } = parse('v.a + "x"');
		expect(diagnostics[0].start).toBe(6);
	});
});

describe('trace and step modes', () => {
	it('trace records intermediate values', () => {
		const symbols = new SymbolTable();
		const values = new Map<number, unknown>();
		const expr = compile('v.a = 2; return v.a * 3 + 1;', { symbols, mode: 'trace', f32: false });
		const env = createEnv({ trace: (id, v) => (values.set(id, v), v) });
		expect(evaluate(expr, env)).toBe(7);
		expect([...values.values()]).toContain(6);
	});
	it('step mode yields once per statement', () => {
		const symbols = new SymbolTable();
		const expr = compile('v.a = 1; v.b = 2; return v.a + v.b;', { symbols, mode: 'step', f32: false });
		const it = expr.step!(createEnv());
		const ids: number[] = [];
		let r = it.next();
		while (!r.done) {
			ids.push(r.value);
			r = it.next();
		}
		expect(ids.length).toBe(3);
		expect(r.value).toBe(3);
	});
});

describe('formatter', () => {
	const roundTrip = (src: string, style: 'compact' | 'spaced' | 'pretty') => {
		const { program } = parse(src);
		const out = format(program, { style });
		expect(run(out).value).toEqual(run(src).value);
		return out;
	};
	it('compact and spaced keep semantics and user parens', () => {
		expect(roundTrip('math.min(1,math.max(0,math.lerp((v.a ?? 0.5),0,0.25)))', 'compact')).toBe('math.min(1,math.max(0,math.lerp((v.a??0.5),0,0.25)))');
		expect(roundTrip('(1+2)*3', 'spaced')).toBe('(1 + 2) * 3');
		expect(roundTrip('v.a=1;v.b=v.a*2;return v.b;', 'spaced')).toBe('v.a = 1; v.b = v.a * 2; return v.b;');
	});
	it('pretty breaks long nested calls across lines', () => {
		const src = 'math.min(1,math.max(0,math.lerp((v.a),0,variable.particle_age/variable.particle_lifetime)))';
		const out = format(parse(src).program, { style: 'pretty', width: 40 });
		expect(out.split('\n').length).toBeGreaterThan(3);
		expect(run(out, { env: { v: [] } }).value).toEqual(run(src).value);
	});
	it('keeps editor comments in pretty mode only', () => {
		const { program } = parse('// set up\nv.a = 1;\nreturn v.a;', { comments: true });
		expect(format(program, { style: 'pretty' })).toContain('// set up');
		expect(format(program, { style: 'compact' })).toBe('v.a=1;return v.a;');
	});
});

describe('analyzer', () => {
	it('collects reads/writes in evaluation order and read-before-write', () => {
		const a = analyze(parse('v.a = v.a + 1; v.b = 2; return v.b + v.c;').program, { expectsValue: true });
		expect(a.writes.map((w) => w.name)).toEqual(['variable.a', 'variable.b']);
		expect([...a.readBeforeWrite].sort()).toEqual(['variable.a', 'variable.c']);
	});
	it('collects query call signatures', () => {
		const a = analyze(parse("q.armor_texture_slot(0) + q.armor_texture_slot(v.s) + q.property('ns:state')").program);
		expect(a.queries.map((q) => q.signature)).toEqual(["query.armor_texture_slot(0)", 'query.armor_texture_slot(?)', "query.property('ns:state')"]);
	});
	it('warns on missing return when a value is expected', () => {
		const a = analyze(parse('v.a = 1; v.a').program, { expectsValue: true });
		expect(a.diagnostics.some((d) => d.code === 'missing-return')).toBe(true);
	});
	it('flags particle-unsupported constructs', () => {
		const a = analyze(parse('for_each(t.x, q.list, { v.a = 1; })').program);
		expect(a.diagnostics.some((d) => d.code === 'not-available')).toBe(true);
	});
});

describe('legacy molangjs API', () => {
	it('parse with variables', () => {
		const m = new Molang();
		expect(m.parse('v.x + 1', { 'variable.x': 2 })).toBe(3);
		expect(m.parse('query.foo * 2', { 'query.foo': 4 })).toBe(8);
	});
	it('variableHandler fallback and persistent variables', () => {
		const m = new Molang();
		m.variableHandler = (key) => (key === 'variable.curve' ? 10 : undefined);
		expect(m.parse('v.curve + 1')).toBe(11);
		m.parse('v.keep = 5;');
		expect(m.parse('v.keep')).toBe(5);
	});
	it('functions in globals act as queries', () => {
		const m = new Molang();
		m.global_variables['query.double'] = (x) => (x as number) * 2;
		expect(m.parse('q.double(21)')).toBe(42);
	});
});
