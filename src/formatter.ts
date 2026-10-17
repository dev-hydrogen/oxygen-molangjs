import type { Node, Program } from './ast';
import type { MolangFeatures } from './version';

export type FormatStyle = 'pretty' | 'spaced' | 'compact';

export interface FormatOptions {
	style?: FormatStyle;
	/** pretty: target line width before breaking calls/chains */
	width?: number;
	indent?: string;
	/** Use short namespaces (v. q. t. c.) instead of the written form */
	shortNames?: boolean;
	/** Re-emit editor comments (pretty only) */
	comments?: boolean;
}

/** Binding strength of a node for parenthesization (higher = tighter) */
export function strength(node: Node, features: MolangFeatures): number {
	const fixed = features.logicalPrecedence;
	switch (node.type) {
		case 'Assign':
			return 5;
		case 'Coalesce':
			return 10;
		case 'Ternary':
			return 20;
		case 'Logical':
			return node.op === '||' ? (fixed ? 30 : 40) : fixed ? 40 : 30;
		case 'Binary':
			switch (node.op) {
				case '==':
				case '!=':
					return fixed ? 50 : 55;
				case '<':
				case '<=':
				case '>':
				case '>=':
					return fixed ? 60 : 55;
				case '+':
				case '-':
					return 70;
				default:
					return 80;
			}
		case 'Unary':
			return 90;
		case 'Return':
			return 1;
		default:
			return 100;
	}
}

const SHORT: Record<string, string> = { variable: 'v', temp: 't', context: 'c', query: 'q' };

/**
 * Format Molang. 'pretty' is the editor-only view (multi-line, indented); 'spaced'/'compact' are the
 * single-line forms written back to particle JSON. Parentheses the user wrote are always preserved.
 */
export function format(program: Program, options: FormatOptions = {}): string {
	const style = options.style ?? 'pretty';
	const width = options.width ?? 64;
	const ind = options.indent ?? '  ';
	const version = program.features;
	const sp = style === 'compact' ? '' : ' ';
	const comments = options.comments !== false && style === 'pretty' ? [...program.comments] : [];
	const rightAssocTernary = program.features.ternaryRightAssoc;

	const name = (n: Extract<Node, { type: 'Name' }>) => {
		if (!options.shortNames) return n.raw;
		const s = SHORT[n.ns];
		return s ? `${s}.${n.path}` : n.raw;
	};

	/** Should `node` be parenthesized when placed under a parent of strength `ps` (on the right side if `right`)? */
	const needsParens = (node: Node, ps: number, right: boolean) => {
		if (node.parens) return true;
		const s = strength(node, version);
		if (s >= 100) return false;
		if (s < ps) return true;
		if (s === ps && right) {
			// right-assoc operators chain on the right without parens
			if (s === 5) return false;
			if (s === 20 && rightAssocTernary) return false;
			return true;
		}
		if (s === ps && !right && s === 20 && rightAssocTernary) return true; // (a ? b : c) ? d : e
		return false;
	};

	const flat = (node: Node, ps = 0, right = false): string => {
		const out = flatInner(node);
		return needsParens(node, ps, right) ? `(${out})` : out;
	};

	const flatInner = (node: Node): string => {
		switch (node.type) {
			case 'Number':
				return node.raw;
			case 'String':
				return `'${node.value}'`;
			case 'Name':
				return name(node);
			case 'This':
				return 'this';
			case 'Unary':
				return `${node.op}${flat(node.arg, 90)}`;
			case 'Binary':
			case 'Logical': {
				const s = strength(node, version);
				return `${flat(node.left, s)}${sp}${node.op}${sp}${flat(node.right, s, true)}`;
			}
			case 'Coalesce':
				return `${flat(node.left, 10)}${sp}??${sp}${flat(node.right, 10, true)}`;
			case 'Ternary': {
				const t = flat(node.test, 20);
				const c = flat(node.consequent, 0);
				if (!node.alternate) return `${t}${sp}?${sp}${c}`;
				return `${t}${sp}?${sp}${c}${sp}:${sp}${flat(node.alternate, 20, true)}`;
			}
			case 'Assign':
				return `${name(node.target)}${sp}=${sp}${flat(node.value, 5, true)}`;
			case 'Call':
				return node.hasParens ? `${name(node.callee)}(${node.args.map((a) => flat(a)).join(`,${sp}`)})` : name(node.callee);
			case 'Index':
				return `${flat(node.object, 100)}[${flat(node.index)}]`;
			case 'Arrow':
				return `${flat(node.left, 100)}->${flat(node.right, 100)}`;
			case 'Block':
				return node.body.length ? `{${sp}${node.body.map((s) => flat(s) + ';').join(sp)}${sp}}` : '{}';
			case 'Loop':
				return `loop(${flat(node.count)},${sp}${flat(node.body)})`;
			case 'ForEach':
				return `for_each(${flat(node.variable)},${sp}${flat(node.collection)},${sp}${flat(node.body)})`;
			case 'Return':
				return node.arg ? `return ${flat(node.arg)}` : 'return';
			case 'Break':
				return 'break';
			case 'Continue':
				return 'continue';
			case 'Error':
				return program.source.slice(node.start, node.end);
		}
	};

	if (style !== 'pretty') {
		const parts = program.body.map((s) => flat(s));
		if (!program.complex) return parts.join('');
		return parts.map((p) => p + ';').join(sp);
	}

	const pretty = (node: Node, depth: number, ps = 0, right = false): string => {
		const one = flat(node, ps, right);
		const pad = ind.repeat(depth);
		const multiLineBody = node.type === 'Block' || (node.type === 'Loop' && node.body.type === 'Block' && node.body.body.length > 1);
		if (!multiLineBody && pad.length + one.length <= width) return one;
		const inner = ind.repeat(depth + 1);
		const wrap = (s: string) => (needsParens(node, ps, right) ? `(${s})` : s);
		switch (node.type) {
			case 'Call': {
				if (!node.hasParens || node.args.length === 0) return one;
				return wrap(`${name(node.callee)}(\n${node.args.map((a) => inner + pretty(a, depth + 1)).join(',\n')}\n${pad})`);
			}
			case 'Binary':
			case 'Logical': {
				const s = strength(node, version);
				const chain: { op: string | null; node: Node }[] = [];
				const walkLeft = (n: Node) => {
					if ((n.type === 'Binary' || n.type === 'Logical') && strength(n, version) === s && !n.parens) {
						walkLeft(n.left);
						chain.push({ op: n.op, node: n.right });
					} else chain.push({ op: null, node: n });
				};
				walkLeft(node.left);
				chain.push({ op: node.op, node: node.right });
				const lines = chain.map((c, i) => (i === 0 ? pretty(c.node, depth, s) : `${inner}${c.op} ${pretty(c.node, depth + 1, s, true)}`));
				return wrap(lines.join('\n'));
			}
			case 'Ternary': {
				const t = pretty(node.test, depth, 20);
				const c = pretty(node.consequent, depth + 1, 0);
				if (!node.alternate) return wrap(`${t}\n${inner}? ${c}`);
				return wrap(`${t}\n${inner}? ${c}\n${inner}: ${pretty(node.alternate, depth + 1, 20, true)}`);
			}
			case 'Assign':
				return `${name(node.target)} = ${pretty(node.value, depth, 5, true)}`;
			case 'Coalesce':
				return wrap(`${pretty(node.left, depth, 10)}\n${inner}?? ${pretty(node.right, depth + 1, 10, true)}`);
			case 'Block':
				return node.body.length ? `{\n${node.body.map((s) => inner + pretty(s, depth + 1) + ';').join('\n')}\n${pad}}` : '{}';
			case 'Loop':
				return `loop(${flat(node.count)}, ${pretty(node.body, depth)})`;
			case 'Return':
				return node.arg ? `return ${pretty(node.arg, depth, 1)}` : 'return';
			default:
				return one;
		}
	};

	const out: string[] = [];
	for (const stmt of program.body) {
		while (comments.length && comments[0].start < stmt.start) out.push(`// ${comments.shift()!.text}`);
		out.push(pretty(stmt, 0) + (program.complex ? ';' : ''));
	}
	for (const c of comments) out.push(`// ${c.text}`);
	return out.join('\n');
}
