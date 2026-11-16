/**
 * The `=` function autocomplete and the argument hint, as pure rules over text and caret.
 *
 * Suggestions appear while the caret ends a name typed where a value may begin (after "=", an
 * operator, "(" or ","), and not while it ends something that already reads as a cell such as B12.
 * Tab accepts, as in Excel. The hint names the function the caret is inside and which argument.
 */
import type { FunctionInfo } from './functionCatalog';

const NAME_START_AFTER = /[=(,+\-*/^&<>:]$/;
const CELL_LIKE = /^[A-Za-z]{1,4}\d+$/;

export interface TypedName { start: number; prefix: string }

/** The function name being typed at the caret, or null when none is. */
export function typedName(text: string, caret: number): TypedName | null {
	if (!text.startsWith('=')) return null;
	const before = text.slice(0, caret);
	if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return null;
	const match = /[A-Za-z][A-Za-z0-9_.]*$/.exec(before);
	if (!match) return null;
	const head = before.slice(0, match.index).trimEnd();
	if (!head || !NAME_START_AFTER.test(head)) return null;
	if (CELL_LIKE.test(match[0])) return null;
	// Do not offer to rewrite a name the caret is in the middle of.
	if (/[A-Za-z0-9_.]/.test(text.charAt(caret))) return null;
	return { start: match.index, prefix: match[0] };
}

/** Functions whose name starts with what was typed, in alphabetical order. */
export function suggest(text: string, caret: number, catalog: readonly FunctionInfo[], max = 8): FunctionInfo[] {
	const typed = typedName(text, caret);
	if (!typed) return [];
	const prefix = typed.prefix.toUpperCase();
	return catalog.filter((item) => item.name.startsWith(prefix)).slice(0, max);
}

export interface Accepted { text: string; caret: number }

/** Replaces the typed name with the chosen function and its opening bracket. */
export function accept(text: string, caret: number, name: string): Accepted {
	const typed = typedName(text, caret);
	if (!typed) return { text, caret };
	const rest = text.slice(caret);
	const open = rest.startsWith('(') ? '' : '(';
	const head = text.slice(0, typed.start) + name + open;
	return { text: head + rest, caret: head.length + (open ? 0 : 1) };
}

export interface SignatureParts { before: string; current: string; after: string }

/**
 * A signature split around the argument the caret is in, so the hint can set it in bold:
 * "IF(" · "value_if_true" · ", [value_if_false])". Past the last argument of a variadic
 * function (one ending in "…") the last argument stays current; otherwise nothing is.
 */
export function signatureParts(signature: string, argIndex: number): SignatureParts {
	const open = signature.indexOf('(');
	const close = signature.lastIndexOf(')');
	if (open < 0 || close < open) return { before: signature, current: '', after: '' };
	const args = signature.slice(open + 1, close).split(', ');
	const variadic = args.length > 0 && args[args.length - 1] === '…';
	const index = variadic && argIndex >= args.length - 1 ? Math.max(0, args.length - 2) : argIndex;
	if (index < 0 || index >= args.length) return { before: signature, current: '', after: '' };
	const head = signature.slice(0, open + 1) + args.slice(0, index).map((arg) => arg + ', ').join('');
	const tail = args.slice(index + 1).map((arg) => ', ' + arg).join('') + signature.slice(close);
	return { before: head, current: args[index], after: tail };
}

export interface CallContext { name: string; argIndex: number }

/** The function call the caret is inside, and which argument it is in. */
export function callAt(text: string, caret: number): CallContext | null {
	if (!text.startsWith('=')) return null;
	const stack: { name: string; arg: number }[] = [];
	let inString = false;
	for (let i = 1; i < caret && i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === '(') {
			const name = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(text.slice(0, i));
			stack.push({ name: name ? name[1].toUpperCase() : '', arg: 0 });
		} else if (ch === ')') stack.pop();
		else if (ch === ',' && stack.length) stack[stack.length - 1].arg++;
	}
	for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name) return { name: stack[i].name, argIndex: stack[i].arg };
	return null;
}
