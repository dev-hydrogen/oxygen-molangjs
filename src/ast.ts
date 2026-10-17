import type { MolangFeatures } from './version';

export type Namespace =
	| 'variable'
	| 'temp'
	| 'context'
	| 'query'
	| 'math'
	| 'geometry'
	| 'texture'
	| 'material'
	| 'array'
	| 'unknown';

interface Base {
	/** Stable id within one parsed program (used by tracing, value lenses, diagnostics) */
	id: number;
	start: number;
	end: number;
	/** Number of explicit parentheses around this node in the source */
	parens?: number;
}

export interface NumberNode extends Base {
	type: 'Number';
	value: number;
	raw: string;
}
export interface StringNode extends Base {
	type: 'String';
	value: string;
}
export interface NameNode extends Base {
	type: 'Name';
	ns: Namespace;
	/** Lowercased path after the namespace, e.g. `particle_age` or `location.x` */
	path: string;
	/** Canonical lowercase full name, e.g. `variable.particle_age` */
	full: string;
	/** Text as written, e.g. `v.Particle_Age` */
	raw: string;
}
export interface UnaryNode extends Base {
	type: 'Unary';
	op: '!' | '-';
	arg: Node;
}
export type BinaryOp = '+' | '-' | '*' | '/' | '<' | '<=' | '>' | '>=' | '==' | '!=';
export interface BinaryNode extends Base {
	type: 'Binary';
	op: BinaryOp;
	left: Node;
	right: Node;
}
export interface LogicalNode extends Base {
	type: 'Logical';
	op: '&&' | '||';
	left: Node;
	right: Node;
}
export interface TernaryNode extends Base {
	type: 'Ternary';
	test: Node;
	consequent: Node;
	/** null for the binary conditional `A ? B` */
	alternate: Node | null;
}
export interface CoalesceNode extends Base {
	type: 'Coalesce';
	left: Node;
	right: Node;
}
export interface AssignNode extends Base {
	type: 'Assign';
	target: NameNode;
	value: Node;
}
export interface CallNode extends Base {
	type: 'Call';
	callee: NameNode;
	args: Node[];
	/** false for `query.foo` written without parentheses */
	hasParens: boolean;
}
export interface IndexNode extends Base {
	type: 'Index';
	object: Node;
	index: Node;
}
export interface ArrowNode extends Base {
	type: 'Arrow';
	left: Node;
	right: Node;
}
export interface BlockNode extends Base {
	type: 'Block';
	body: Node[];
}
export interface LoopNode extends Base {
	type: 'Loop';
	count: Node;
	body: Node;
}
export interface ForEachNode extends Base {
	type: 'ForEach';
	variable: Node;
	collection: Node;
	body: Node;
}
export interface ReturnNode extends Base {
	type: 'Return';
	arg: Node | null;
}
export interface BreakNode extends Base {
	type: 'Break';
}
export interface ContinueNode extends Base {
	type: 'Continue';
}
export interface ThisNode extends Base {
	type: 'This';
}
export interface ErrorNode extends Base {
	type: 'Error';
	message: string;
}

export type Node =
	| NumberNode
	| StringNode
	| NameNode
	| UnaryNode
	| BinaryNode
	| LogicalNode
	| TernaryNode
	| CoalesceNode
	| AssignNode
	| CallNode
	| IndexNode
	| ArrowNode
	| BlockNode
	| LoopNode
	| ForEachNode
	| ReturnNode
	| BreakNode
	| ContinueNode
	| ThisNode
	| ErrorNode;

export interface Comment {
	text: string;
	start: number;
	end: number;
}

export interface Program {
	type: 'Program';
	body: Node[];
	/**
	 * A "complex" expression contains statements (a top-level `;` or `return`). Its value is the
	 * `return` value, or 0.0 when no return executes — a single bare expression returns its value.
	 */
	complex: boolean;
	start: number;
	end: number;
	nodeCount: number;
	comments: Comment[];
	/** Source text the program was parsed from */
	source: string;
	/** Per-expression version (game enum) if one was given */
	version: number | null;
	/** Rule set used to parse */
	features: MolangFeatures;
}

export interface Diagnostic {
	severity: 'error' | 'warning' | 'info';
	code: string;
	message: string;
	start: number;
	end: number;
}

export function walk(node: Node | Program, visit: (n: Node, parent: Node | Program | null) => void | false, parent: Node | Program | null = null): void {
	if (node.type !== 'Program') {
		if (visit(node, parent) === false) return;
	}
	for (const child of children(node)) walk(child, visit, node);
}

export function children(node: Node | Program): Node[] {
	switch (node.type) {
		case 'Program':
		case 'Block':
			return node.body;
		case 'Unary':
			return [node.arg];
		case 'Binary':
		case 'Logical':
		case 'Coalesce':
		case 'Arrow':
			return [node.left, node.right];
		case 'Ternary':
			return node.alternate ? [node.test, node.consequent, node.alternate] : [node.test, node.consequent];
		case 'Assign':
			return [node.target, node.value];
		case 'Call':
			return [node.callee, ...node.args];
		case 'Index':
			return [node.object, node.index];
		case 'Loop':
			return [node.count, node.body];
		case 'ForEach':
			return [node.variable, node.collection, node.body];
		case 'Return':
			return node.arg ? [node.arg] : [];
		default:
			return [];
	}
}
