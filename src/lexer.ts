export type TokenType = 'number' | 'string' | 'name' | 'keyword' | 'op' | 'punct' | 'comment' | 'error' | 'eof';

export interface Token {
	type: TokenType;
	/** Source text of the token */
	text: string;
	/** Lowercased text for names/keywords (Molang identifiers are case-insensitive) */
	lower: string;
	start: number;
	end: number;
	value?: number;
	message?: string;
}

export const KEYWORDS = new Set(['return', 'loop', 'for_each', 'break', 'continue', 'true', 'false', 'this']);

const OPS3: string[] = [];
const OPS2 = ['&&', '||', '==', '!=', '<=', '>=', '??', '->'];
const OPS1 = '<>+-*/!?:=';
const PUNCT = '(){}[],;';

export interface LexOptions {
	/** Emit `// line comments` as comment tokens (Oxygen editor-only comments). Molang itself has no comments. */
	comments?: boolean;
}

function isIdentStart(c: number) {
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isIdentPart(c: number) {
	return isIdentStart(c) || (c >= 48 && c <= 57);
}
function isDigit(c: number) {
	return c >= 48 && c <= 57;
}

export function tokenize(src: string, options: LexOptions = {}): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = src.length;
	const push = (type: TokenType, start: number, end: number, extra?: Partial<Token>) => {
		const text = src.slice(start, end);
		tokens.push({ type, text, lower: text.toLowerCase(), start, end, ...extra });
	};
	while (i < n) {
		const c = src.charCodeAt(i);
		// whitespace (incl. newlines — the editor may show multi-line formatted Molang)
		if (c === 32 || c === 9 || c === 10 || c === 13) {
			i++;
			continue;
		}
		if (c === 47 /* / */ && src.charCodeAt(i + 1) === 47 && options.comments) {
			const start = i;
			while (i < n && src.charCodeAt(i) !== 10) i++;
			push('comment', start, i);
			continue;
		}
		if (isIdentStart(c)) {
			const start = i;
			i++;
			while (i < n) {
				const d = src.charCodeAt(i);
				if (isIdentPart(d)) i++;
				else if (d === 46 /* . */ && i + 1 < n && isIdentStart(src.charCodeAt(i + 1))) i += 2;
				else break;
			}
			const lower = src.slice(start, i).toLowerCase();
			push(KEYWORDS.has(lower) ? 'keyword' : 'name', start, i);
			continue;
		}
		if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
			const start = i;
			while (i < n && isDigit(src.charCodeAt(i))) i++;
			if (src.charCodeAt(i) === 46) {
				i++;
				while (i < n && isDigit(src.charCodeAt(i))) i++;
			}
			const e = src.charCodeAt(i);
			if ((e === 101 || e === 69) && (isDigit(src.charCodeAt(i + 1)) || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src.charCodeAt(i + 2))))) {
				i += 2;
				while (i < n && isDigit(src.charCodeAt(i))) i++;
			}
			const numEnd = i;
			if (src[i] === 'f' || src[i] === 'F') i++; // C-style float suffix
			push('number', start, i, { value: parseFloat(src.slice(start, numEnd)) });
			if (i < n && isIdentStart(src.charCodeAt(i))) {
				const s2 = i;
				while (i < n && isIdentPart(src.charCodeAt(i))) i++;
				push('error', s2, i, { message: `Unexpected identifier '${src.slice(s2, i)}' directly after a number` });
			}
			continue;
		}
		if (c === 39 /* ' */) {
			const start = i;
			i++;
			while (i < n && src.charCodeAt(i) !== 39) i++;
			if (i >= n) {
				push('error', start, n, { message: 'Unterminated string (strings use single quotes)' });
				break;
			}
			i++;
			push('string', start, i);
			continue;
		}
		if (c === 34 /* " */) {
			const start = i;
			i++;
			while (i < n && src.charCodeAt(i) !== 34) i++;
			i = Math.min(n, i + 1);
			push('error', start, i, { message: 'Molang strings must use single quotes' });
			continue;
		}
		const two = src.slice(i, i + 2);
		if (OPS3.length && OPS3.includes(src.slice(i, i + 3))) {
			push('op', i, i + 3);
			i += 3;
			continue;
		}
		if (OPS2.includes(two)) {
			push('op', i, i + 2);
			i += 2;
			continue;
		}
		const ch = src[i];
		if (OPS1.includes(ch)) {
			push('op', i, i + 1);
			i++;
			continue;
		}
		if (PUNCT.includes(ch)) {
			push('punct', i, i + 1);
			i++;
			continue;
		}
		const start = i;
		i++;
		push('error', start, i, { message: `Unknown character '${ch}'` });
	}
	tokens.push({ type: 'eof', text: '', lower: '', start: n, end: n });
	return tokens;
}
