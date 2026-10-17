import type { Comment, Diagnostic, NameNode, Namespace, Node, Program } from './ast';
import { tokenize, type Token } from './lexer';
import { LATEST_FEATURES, featuresForEngine, featuresForVersion, type MolangFeatures } from './version';

export interface ParseOptions {
	/** Per-expression version (game enum, `{ "expression", "version" }`). */
	version?: number | null;
	/** Pack min_engine_version (used for plain-string expressions when no version is given). */
	engine?: string | readonly number[] | null;
	/** Explicit rule set (overrides version/engine) */
	features?: MolangFeatures;
	/** Allow Oxygen editor-only `//` comments (collected into program.comments) */
	comments?: boolean;
}

export interface ParseResult {
	program: Program;
	diagnostics: Diagnostic[];
}

const NAMESPACES: Record<string, Namespace> = {
	v: 'variable',
	variable: 'variable',
	t: 'temp',
	temp: 'temp',
	c: 'context',
	context: 'context',
	q: 'query',
	query: 'query',
	math: 'math',
	geometry: 'geometry',
	texture: 'texture',
	material: 'material',
	array: 'array',
};

export function splitName(lower: string): { ns: Namespace; path: string; full: string } {
	const dot = lower.indexOf('.');
	const head = dot === -1 ? lower : lower.slice(0, dot);
	const ns = NAMESPACES[head] ?? 'unknown';
	const path = dot === -1 ? '' : lower.slice(dot + 1);
	return { ns, path, full: ns === 'unknown' ? lower : `${ns}.${path}` };
}

/** Binding powers. Larger binds tighter. */
interface Precedence {
	assign: number;
	coalesce: number;
	ternary: number;
	or: number;
	and: number;
	equality: number;
	comparison: number;
	additive: number;
	multiplicative: number;
	prefix: number;
	postfix: number;
	ternaryRightAssoc: boolean;
}

export function resolveFeatures(o: { version?: number | null; engine?: string | readonly number[] | null; features?: MolangFeatures }): MolangFeatures {
	if (o.features) return o.features;
	if (typeof o.version === 'number') return featuresForVersion(o.version);
	if (o.engine) return featuresForEngine(o.engine);
	return LATEST_FEATURES;
}

function precedenceFor(f: MolangFeatures): Precedence {
	const fixedLogic = f.logicalPrecedence;
	return {
		assign: 5,
		coalesce: 10,
		ternary: 20,
		// Before 1.18.20 `A && B || C` evaluated as `A && (B || C)`, and comparisons/equality shared a level.
		or: fixedLogic ? 30 : 40,
		and: fixedLogic ? 40 : 30,
		equality: fixedLogic ? 50 : 55,
		comparison: fixedLogic ? 60 : 55,
		additive: 70,
		multiplicative: 80,
		prefix: 90,
		postfix: 100,
		ternaryRightAssoc: f.ternaryRightAssoc,
	};
}

class Parser {
	private tokens: Token[];
	private pos = 0;
	private nextId = 0;
	readonly diagnostics: Diagnostic[] = [];
	readonly comments: Comment[] = [];
	private prec: Precedence;
	private loopDepth = 0;

	constructor(
		private src: string,
		private features: MolangFeatures,
		private version: number | null,
		comments: boolean,
	) {
		const all = tokenize(src, { comments });
		this.tokens = [];
		for (const t of all) {
			if (t.type === 'comment') this.comments.push({ text: t.text.replace(/^\/\/\s?/, ''), start: t.start, end: t.end });
			else if (t.type === 'error') this.error('syntax', t.message ?? 'Invalid token', t.start, t.end);
			else this.tokens.push(t);
		}
		this.prec = precedenceFor(features);
	}

	private error(code: string, message: string, start: number, end: number) {
		this.diagnostics.push({ severity: 'error', code, message, start, end });
	}

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
	}
	private next(): Token {
		const t = this.tokens[this.pos];
		if (this.pos < this.tokens.length - 1) this.pos++;
		return t;
	}
	private is(text: string, offset = 0): boolean {
		const t = this.peek(offset);
		return (t.type === 'op' || t.type === 'punct') && t.text === text;
	}
	private isKeyword(word: string): boolean {
		const t = this.peek();
		return t.type === 'keyword' && t.lower === word;
	}
	private expect(text: string): Token | null {
		if (this.is(text)) return this.next();
		const t = this.peek();
		this.error('syntax', t.type === 'eof' ? `Expected '${text}' before end of expression` : `Expected '${text}' but found '${t.text}'`, t.start, t.end);
		return null;
	}
	private id() {
		return this.nextId++;
	}

	parseProgram(): Program {
		const body: Node[] = [];
		let complex = false;
		while (this.peek().type !== 'eof') {
			if (this.is(';')) {
				complex = true;
				this.next();
				continue;
			}
			const before = this.pos;
			const stmt = this.parseStatement();
			body.push(stmt);
			if (stmt.type === 'Return') complex = true;
			if (this.is(';')) {
				complex = true;
				this.next();
			} else if (this.peek().type !== 'eof') {
				const t = this.peek();
				// 1.17.40+: "too many operators / unexpected token" is a content error (e.g. `1+(2 3)`)
				this.error('syntax', `Unexpected '${t.text}' — missing operator or ';'?`, t.start, t.end);
				this.recover();
			}
			if (this.pos === before) this.next();
		}
		return {
			type: 'Program',
			body,
			complex,
			start: 0,
			end: this.src.length,
			nodeCount: this.nextId,
			comments: this.comments,
			source: this.src,
			version: this.version,
			features: this.features,
		};
	}

	/** Skip to the next statement boundary after an error */
	private recover() {
		let depth = 0;
		while (this.peek().type !== 'eof') {
			const t = this.peek();
			if (t.type === 'punct') {
				if (t.text === '(' || t.text === '{' || t.text === '[') depth++;
				else if (t.text === ')' || t.text === '}' || t.text === ']') {
					if (depth === 0) return;
					depth--;
				} else if (t.text === ';' && depth === 0) return;
			}
			this.next();
		}
	}

	private parseStatement(): Node {
		return this.parseExpression(0);
	}

	parseExpression(minBp: number): Node {
		let left = this.parsePrefix();
		for (;;) {
			const t = this.peek();
			if (t.type !== 'op' && !(t.type === 'punct' && (t.text === '(' || t.text === '['))) break;
			const op = t.text;
			const p = this.prec;
			let lbp: number;
			switch (op) {
				case '=':
					lbp = p.assign;
					break;
				case '??':
					lbp = p.coalesce;
					break;
				case '?':
					lbp = p.ternary;
					break;
				case '||':
					lbp = p.or;
					break;
				case '&&':
					lbp = p.and;
					break;
				case '==':
				case '!=':
					lbp = p.equality;
					break;
				case '<':
				case '<=':
				case '>':
				case '>=':
					lbp = p.comparison;
					break;
				case '+':
				case '-':
					lbp = p.additive;
					break;
				case '*':
				case '/':
					lbp = p.multiplicative;
					break;
				case '->':
				case '[':
					lbp = p.postfix;
					break;
				default:
					lbp = -1;
			}
			if (lbp < 0 || lbp <= minBp) break;
			this.next();
			const start = left.start;
			switch (op) {
				case '=': {
					const value = this.parseExpression(p.assign - 1); // right-assoc
					if (left.type !== 'Name' || (left.ns !== 'variable' && left.ns !== 'temp')) {
						this.error('assign-target', left.type === 'Name' && left.ns === 'context' ? 'context.* variables are read-only' : 'Only variable.* and temp.* can be assigned', left.start, left.end);
						left = { type: 'Error', id: this.id(), start, end: value.end, message: 'Invalid assignment target' };
					} else {
						left = { type: 'Assign', id: this.id(), start, end: value.end, target: left as NameNode, value };
					}
					break;
				}
				case '??': {
					const right = this.parseExpression(p.coalesce);
					left = { type: 'Coalesce', id: this.id(), start, end: right.end, left, right };
					break;
				}
				case '?': {
					// consequent may itself be a full ternary (`a ? b ? c : d : e`)
					const consequent = this.parseExpression(p.assign - 1);
					let alternate: Node | null = null;
					if (this.is(':')) {
						this.next();
						alternate = this.parseExpression(p.ternaryRightAssoc ? p.ternary - 1 : p.ternary);
					}
					left = { type: 'Ternary', id: this.id(), start, end: (alternate ?? consequent).end, test: left, consequent, alternate };
					break;
				}
				case '||':
				case '&&': {
					const right = this.parseExpression(lbp);
					left = { type: 'Logical', id: this.id(), start, end: right.end, op, left, right };
					break;
				}
				case '->': {
					const right = this.parseExpression(p.postfix);
					left = { type: 'Arrow', id: this.id(), start, end: right.end, left, right };
					break;
				}
				case '[': {
					const index = this.parseExpression(0);
					const close = this.expect(']');
					left = { type: 'Index', id: this.id(), start, end: close ? close.end : index.end, object: left, index };
					break;
				}
				default: {
					const right = this.parseExpression(lbp);
					left = { type: 'Binary', id: this.id(), start, end: right.end, op: op as any, left, right };
				}
			}
		}
		return left;
	}

	private parsePrefix(): Node {
		const t = this.peek();
		const p = this.prec;
		if (t.type === 'number') {
			this.next();
			return { type: 'Number', id: this.id(), start: t.start, end: t.end, value: t.value!, raw: t.text };
		}
		if (t.type === 'string') {
			this.next();
			return { type: 'String', id: this.id(), start: t.start, end: t.end, value: t.text.slice(1, -1) };
		}
		if (t.type === 'op' && (t.text === '-' || t.text === '!')) {
			this.next();
			const arg = this.parseExpression(p.prefix);
			return { type: 'Unary', id: this.id(), start: t.start, end: arg.end, op: t.text as '-' | '!', arg };
		}
		if (t.type === 'punct' && t.text === '(') {
			this.next();
			const inner = this.parseExpression(0);
			const close = this.expect(')');
			inner.parens = (inner.parens ?? 0) + 1;
			// keep the node's own span but remember parens for the formatter
			if (close) {
				(inner as any).parenStart = t.start;
				(inner as any).parenEnd = close.end;
			}
			return inner;
		}
		if (t.type === 'punct' && t.text === '{') return this.parseBlock();
		if (t.type === 'keyword') {
			switch (t.lower) {
				case 'true':
				case 'false':
					this.next();
					return { type: 'Number', id: this.id(), start: t.start, end: t.end, value: t.lower === 'true' ? 1 : 0, raw: t.text };
				case 'this':
					this.next();
					return { type: 'This', id: this.id(), start: t.start, end: t.end };
				case 'return': {
					this.next();
					if (this.is(';') || this.is('}') || this.peek().type === 'eof') {
						return { type: 'Return', id: this.id(), start: t.start, end: t.end, arg: null };
					}
					const arg = this.parseExpression(0);
					return { type: 'Return', id: this.id(), start: t.start, end: arg.end, arg };
				}
				case 'break':
				case 'continue':
					this.next();
					if (this.loopDepth === 0) this.error('syntax', `'${t.lower}' used outside of a loop`, t.start, t.end);
					return { type: t.lower === 'break' ? 'Break' : 'Continue', id: this.id(), start: t.start, end: t.end } as Node;
				case 'loop': {
					this.next();
					this.expect('(');
					const count = this.parseExpression(0);
					this.expect(',');
					this.loopDepth++;
					const body = this.parseExpression(0);
					this.loopDepth--;
					const close = this.expect(')');
					return { type: 'Loop', id: this.id(), start: t.start, end: close ? close.end : body.end, count, body };
				}
				case 'for_each': {
					this.next();
					this.expect('(');
					const variable = this.parseExpression(0);
					this.expect(',');
					const collection = this.parseExpression(0);
					this.expect(',');
					this.loopDepth++;
					const body = this.parseExpression(0);
					this.loopDepth--;
					const close = this.expect(')');
					return { type: 'ForEach', id: this.id(), start: t.start, end: close ? close.end : body.end, variable, collection, body };
				}
			}
		}
		if (t.type === 'name') {
			this.next();
			const { ns, path, full } = splitName(t.lower);
			const name: NameNode = { type: 'Name', id: this.id(), start: t.start, end: t.end, ns, path, full, raw: t.text };
			if (ns === 'unknown') {
				this.error('unknown-identifier', `Unknown identifier '${t.text}' — expected v., t., c., q. or math.`, t.start, t.end);
			} else if (!path) {
				this.error('syntax', `'${t.text}' needs a name after the namespace, e.g. ${t.text}.name`, t.start, t.end);
			}
			if (this.is('(')) {
				const open = this.next();
				const args: Node[] = [];
				if (!this.is(')')) {
					for (;;) {
						args.push(this.parseExpression(0));
						if (this.is(',')) {
							this.next();
							continue;
						}
						break;
					}
				}
				const close = this.expect(')');
				if (ns !== 'query' && ns !== 'math') {
					this.error('not-callable', `'${t.text}' is not a function`, t.start, open.end);
				}
				return { type: 'Call', id: this.id(), start: t.start, end: close ? close.end : this.peek().start, callee: name, args, hasParens: true };
			}
			if (ns === 'query') {
				return { type: 'Call', id: this.id(), start: t.start, end: t.end, callee: name, args: [], hasParens: false };
			}
			if (ns === 'math' && path !== 'pi') {
				this.error('syntax', `'${t.text}' is a function — add arguments, e.g. ${t.text}(...)`, t.start, t.end);
			}
			return name;
		}
		// error
		this.next();
		if (t.type === 'eof') {
			this.error('syntax', 'Unexpected end of expression', t.start, t.end);
		} else {
			this.error('syntax', `Unexpected '${t.text}'`, t.start, t.end);
		}
		return { type: 'Error', id: this.id(), start: t.start, end: t.end, message: 'Unexpected token' };
	}

	private parseBlock(): Node {
		const open = this.next();
		const body: Node[] = [];
		while (!this.is('}') && this.peek().type !== 'eof') {
			if (this.is(';')) {
				this.next();
				continue;
			}
			const before = this.pos;
			body.push(this.parseStatement());
			if (this.is(';')) this.next();
			else if (!this.is('}')) {
				const t = this.peek();
				if (t.type !== 'eof') {
					this.error('syntax', `Unexpected '${t.text}' — missing ';'?`, t.start, t.end);
					this.recover();
				}
			}
			if (this.pos === before) this.next();
		}
		const close = this.expect('}');
		return { type: 'Block', id: this.id(), start: open.start, end: close ? close.end : this.peek().start, body };
	}
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
	const parser = new Parser(source, resolveFeatures(options), typeof options.version === 'number' ? options.version : null, options.comments ?? false);
	const program = parser.parseProgram();
	return { program, diagnostics: parser.diagnostics };
}
