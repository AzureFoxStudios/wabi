/**
 * Point mode: while typing a formula, clicking or arrowing to a cell writes its reference.
 *
 * Pure rules over the formula text and caret. The grid owns the pointer and the editor; it asks
 * `canPoint` before a click or arrow key is treated as "insert a reference" rather than "commit
 * this edit and select that cell", and keeps the `PointSpan` of the last insertion so the next
 * click or arrow replaces it instead of piling references up (and a drag widens it to a range).
 */
import { columnName } from './formula';

export interface CellPos { r: number; c: number }
/** The reference written by the last point-mode action, still sitting in the text. */
export interface PointSpan { start: number; end: number; label: string }
/** 'enter' is typing a fresh value; 'edit' is F2 or a double click (arrows move the caret). */
export type EditMode = 'enter' | 'edit';

const OPERATOR_BEFORE = /[=(,+\-*/^&<>:]$/;

function insideString(text: string, caret: number): boolean {
	// A doubled quote inside a string flips the count twice, so the parity stays right.
	return (text.slice(0, caret).match(/"/g)?.length ?? 0) % 2 === 1;
}

/** True where a reference may be written: just after "=", an operator, "(" or ",". */
export function canPoint(text: string, caret: number): boolean {
	if (!text.startsWith('=') || insideString(text, caret)) return false;
	const before = text.slice(0, caret).trimEnd();
	if (!before || !OPERATOR_BEFORE.test(before)) return false;
	// Never split a token the caret happens to sit in front of.
	return !/[A-Za-z0-9_$."']/.test(text.charAt(caret));
}

/** "B2" for one cell, "B2:C4" for a range, whichever corner came first. */
export function refLabel(a: CellPos, b: CellPos): string {
	const r0 = Math.min(a.r, b.r);
	const r1 = Math.max(a.r, b.r);
	const c0 = Math.min(a.c, b.c);
	const c1 = Math.max(a.c, b.c);
	const one = (r: number, c: number) => `${columnName(c)}${r + 1}`;
	return r0 === r1 && c0 === c1 ? one(r0, c0) : `${one(r0, c0)}:${one(r1, c1)}`;
}

/** The last insertion, if the text still holds exactly what it wrote there. */
export function liveSpan(text: string, span: PointSpan | null): PointSpan | null {
	return span && text.slice(span.start, span.end) === span.label ? span : null;
}

export interface PointResult { text: string; caret: number; span: PointSpan }

/** Writes `label` at the caret, or over the previous point-mode insertion when it is still there. */
export function pointInsert(text: string, caret: number, label: string, previous: PointSpan | null): PointResult {
	const span = liveSpan(text, previous);
	const start = span ? span.start : caret;
	const end = span ? span.end : caret;
	return {
		text: text.slice(0, start) + label + text.slice(end),
		caret: start + label.length,
		span: { start, end: start + label.length, label }
	};
}

/**
 * What an arrow key does inside the cell editor.
 *  - 'caret': move the text caret (F2 edit mode, or a formula that is not at a pointing spot).
 *  - 'point': move the reference being written.
 *  - 'commit': accept the entry and move the selection, as Excel does when you type a value and press an arrow.
 */
export function arrowAction(mode: EditMode, text: string, caret: number, pointing: boolean): 'caret' | 'point' | 'commit' {
	if (mode === 'edit') return 'caret';
	if (pointing || canPoint(text, caret)) return 'point';
	return 'commit';
}
