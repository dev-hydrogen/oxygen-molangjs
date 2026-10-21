import type { CallNode, Diagnostic, NameNode, Node, Program } from './ast';
import { STRUCT_QUERIES } from './runtime';

export interface NameUse {
	/** canonical lowercase name, e.g. `variable.foo` */
	name: string;
	ns: NameNode['ns'];
	start: number;
	end: number;
	node: number;
	/** evaluation-order index within the expression */
	order: number;
	/** the read happens inside a branch/loop body that may not execute */
	conditional: boolean;
	/** the read is protected by `??` (an unset value doesn't abort the expression) */
	guarded?: boolean;
}

export interface QueryUse {
	name: string;
	/** literal argument values (string/number) or null where an argument is dynamic */
	args: (string | number | null)[];
	/** canonical signature, e.g. `query.armor_texture_slot(0)` or `query.property('ns:x')`; dynamic args become `?` */
	signature: string;
	start: number;
	end: number;
	node: number;
}

export interface Analysis {
	reads: NameUse[];
	writes: NameUse[];
	queries: QueryUse[];
	mathCalls: { name: string; argc: number; start: number; end: number }[];
	/** Variables/temps whose first use (in evaluation order) is a read */
	readBeforeWrite: Set<string>;
	complex: boolean;
	hasReturn: boolean;
	usesRandom: boolean;
	diagnostics: Diagnostic[];
}

export interface AnalyzeOptions {
	/** Particle context: flags constructs Bedrock particles don't support */
	context?: 'particle' | 'generic';
	/** Does the field consume the expression's value? (size, color, rate…) vs. statement-only (creation_expression) */
	expectsValue?: boolean;
	/** Optional query metadata lookup for arity checks */
	queryInfo?: (name: string) => { minArgs: number; maxArgs: number | null } | undefined;
}

const RANDOM_MATH = new Set(['random', 'random_integer', 'die_roll', 'die_roll_integer']);

function literalOf(node: Node): string | number | null {
	if (node.type === 'Number') return node.value;
	if (node.type === 'String') return node.value;
	if (node.type === 'Unary' && node.op === '-' && node.arg.type === 'Number') return -node.arg.value;
	return null;
}

export function querySignature(name: string, args: (string | number | null)[]): string {
	return `${name}(${args.map((a) => (a === null ? '?' : typeof a === 'string' ? `'${a}'` : String(a))).join(', ')})`;
}

export function analyze(program: Program, options: AnalyzeOptions = {}): Analysis {
	const reads: NameUse[] = [];
	const writes: NameUse[] = [];
	const queries: QueryUse[] = [];
	const mathCalls: Analysis['mathCalls'] = [];
	const diagnostics: Diagnostic[] = [];
	const firstUse = new Map<string, 'read' | 'write'>();
	let order = 0;
	let hasReturn = false;
	let usesRandom = false;
	const particle = options.context !== 'generic';

	const use = (list: NameUse[], n: NameNode, conditional: boolean, kind: 'read' | 'write') => {
		list.push({ name: n.full, ns: n.ns, start: n.start, end: n.end, node: n.id, order: order++, conditional });
		if ((n.ns === 'variable' || n.ns === 'temp') && !firstUse.has(n.full)) firstUse.set(n.full, kind);
	};

	const visit = (node: Node, conditional: boolean): void => {
		switch (node.type) {
			case 'Name':
				if (node.ns === 'variable' || node.ns === 'temp' || node.ns === 'context') use(reads, node, conditional, 'read');
				else if (particle && (node.ns === 'geometry' || node.ns === 'texture' || node.ns === 'material' || node.ns === 'array')) {
					diagnostics.push({ severity: 'error', code: 'not-available', message: `${node.ns}.* is not available in particle Molang`, start: node.start, end: node.end });
				}
				return;
			case 'Assign': {
				visit(node.value, conditional); // RHS evaluates first
				const v = node.value;
				const members = v.type === 'Call' && v.callee.ns === 'query' ? STRUCT_QUERIES[v.callee.full] : undefined;
				// a struct query fills one entry per member (v.o.x, v.o.y, …), not v.o itself
				if (members) for (const m of members) use(writes, { ...node.target, path: `${node.target.path}.${m}`, full: `${node.target.full}.${m}` }, conditional, 'write');
				else use(writes, node.target, conditional, 'write');
				return;
			}
			case 'Call':
				visitCall(node, conditional);
				return;
			case 'Ternary':
				visit(node.test, conditional);
				visit(node.consequent, true);
				if (node.alternate) visit(node.alternate, true);
				checkTernaryAmbiguity(node);
				return;
			case 'Logical':
				visit(node.left, conditional);
				visit(node.right, true); // short-circuit
				if ((node.left.type === 'Logical' && node.left.op !== node.op && !node.left.parens) || (node.right.type === 'Logical' && node.right.op !== node.op && !node.right.parens)) {
					diagnostics.push({
						severity: 'info',
						code: 'mixed-logic',
						message: 'Mixing && and || without parentheses — packs older than 1.18.20 evaluate this differently. Add parentheses to make the intent explicit.',
						start: node.start,
						end: node.end,
					});
				}
				return;
			case 'Coalesce':
				// left side reads are allowed to be unset
				if (node.left.type === 'Name') {
					reads.push({ name: node.left.full, ns: node.left.ns, start: node.left.start, end: node.left.end, node: node.left.id, order: order++, conditional: true, guarded: true });
				} else {
					// any unset read inside the left side is caught by ?? (t01 p7)
					const from = reads.length;
					visit(node.left, true);
					for (let k = from; k < reads.length; k++) reads[k].guarded = true;
				}
				visit(node.right, true);
				return;
			case 'Loop':
				visit(node.count, conditional);
				visit(node.body, true);
				return;
			case 'ForEach':
				if (particle) diagnostics.push({ severity: 'error', code: 'not-available', message: 'for_each is not available in particle Molang', start: node.start, end: node.end });
				visit(node.collection, conditional);
				visit(node.body, true);
				return;
			case 'Arrow':
			case 'Index':
				if (particle) {
					diagnostics.push({
						severity: 'error',
						code: 'not-available',
						message: `${node.type === 'Arrow' ? "'->'" : 'Array access'} is not available in particle Molang`,
						start: node.start,
						end: node.end,
					});
				}
				break;
			case 'Return':
				hasReturn = true;
				if (node.arg) visit(node.arg, conditional);
				return;
			case 'Binary':
				if ((node.left.type === 'String' || node.right.type === 'String') && !(node.op === '==' || node.op === '!=')) {
					diagnostics.push({ severity: 'error', code: 'string-math', message: `Strings can only be compared with == or != (found '${node.op}')`, start: node.start, end: node.end });
				}
				if (node.op === '/' && node.right.type === 'Number' && node.right.value === 0) {
					diagnostics.push({ severity: 'warning', code: 'div-zero', message: 'Division by zero always evaluates to 0.0 (and logs a content error)', start: node.start, end: node.end });
				}
				break;
		}
		for (const child of childNodes(node)) visit(child, conditional);
	};

	const visitCall = (node: CallNode, conditional: boolean) => {
		for (const a of node.args) visit(a, conditional);
		const callee = node.callee;
		if (callee.ns === 'math') {
			mathCalls.push({ name: callee.full, argc: node.args.length, start: node.start, end: node.end });
			if (RANDOM_MATH.has(callee.path)) usesRandom = true;
			return;
		}
		if (callee.ns === 'query') {
			const args = node.args.map(literalOf);
			queries.push({ name: callee.full, args, signature: querySignature(callee.full, args), start: node.start, end: node.end, node: node.id });
			const info = options.queryInfo?.(callee.full);
			if (options.queryInfo && !info) {
				diagnostics.push({ severity: 'warning', code: 'unknown-query', message: `Unknown query '${callee.raw}'`, start: callee.start, end: callee.end });
			} else if (info) {
				const n = node.args.length;
				if (n < info.minArgs || (info.maxArgs !== null && n > info.maxArgs)) {
					const range = info.maxArgs === null ? `at least ${info.minArgs}` : info.minArgs === info.maxArgs ? `${info.minArgs}` : `${info.minArgs}–${info.maxArgs}`;
					diagnostics.push({ severity: 'error', code: 'arity', message: `${callee.raw} takes ${range} argument${info.maxArgs === 1 ? '' : 's'}, got ${n}`, start: node.start, end: node.end });
				}
			}
		}
	};

	const checkTernaryAmbiguity = (node: Extract<Node, { type: 'Ternary' }>) => {
		const nested = (n: Node | null) => n && n.type === 'Ternary' && !n.parens;
		if (nested(node.alternate) || nested(node.test)) {
			diagnostics.push({
				severity: !program.features.ternaryRightAssoc ? 'warning' : 'info',
				code: 'ternary-assoc',
				message:
					!program.features.ternaryRightAssoc
						? 'Nested ternary without parentheses: this pack version groups it as (A ? B : C) ? D : E.'
						: 'Nested ternary without parentheses: packs older than 1.18.10 group this differently. Add parentheses.',
				start: node.start,
				end: node.end,
			});
		}
	};

	for (const stmt of program.body) visit(stmt, false);

	if (program.complex && !hasReturn && options.expectsValue) {
		diagnostics.push({
			severity: 'warning',
			code: 'missing-return',
			message: "This expression has statements but no 'return', so it evaluates to 0.0.",
			start: 0,
			end: program.end,
		});
	}

	const readBeforeWrite = new Set<string>();
	for (const [name, kind] of firstUse) if (kind === 'read') readBeforeWrite.add(name);

	return { reads, writes, queries, mathCalls, readBeforeWrite, complex: program.complex, hasReturn, usesRandom, diagnostics };
}

function childNodes(node: Node): Node[] {
	switch (node.type) {
		case 'Block':
			return node.body;
		case 'Unary':
			return [node.arg];
		case 'Binary':
		case 'Arrow':
			return [node.left, node.right];
		case 'Index':
			return [node.object, node.index];
		default:
			return [];
	}
}
