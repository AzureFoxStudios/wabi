/**
 * Grid navigation the way Excel does it, as pure functions over row and column indexes.
 * The grid supplies "is this cell filled?" and the sheet's size; nothing here touches the DOM.
 */
import { columnIndex } from './formula';

export type Direction = 'up' | 'down' | 'left' | 'right';
export interface Pos { r: number; c: number }

const STEP: Record<Direction, Pos> = {
	up: { r: -1, c: 0 },
	down: { r: 1, c: 0 },
	left: { r: 0, c: -1 },
	right: { r: 0, c: 1 }
};

const clamp = (value: number, max: number) => Math.max(0, Math.min(max - 1, value));

/** One cell in a direction, staying inside the sheet. */
export function stepTo(from: Pos, direction: Direction, rows: number, columns: number): Pos {
	const step = STEP[direction];
	return { r: clamp(from.r + step.r, rows), c: clamp(from.c + step.c, columns) };
}

/**
 * Ctrl+Arrow. From a filled cell whose neighbour is filled, go to the last cell of that run.
 * Otherwise go to the next filled cell, or to the edge of the sheet when there is none.
 */
export function jumpTarget(filled: (cell: Pos) => boolean, from: Pos, direction: Direction, rows: number, columns: number): Pos {
	const step = STEP[direction];
	const inside = (cell: Pos) => cell.r >= 0 && cell.c >= 0 && cell.r < rows && cell.c < columns;
	const move = (cell: Pos): Pos => ({ r: cell.r + step.r, c: cell.c + step.c });
	const edge: Pos = {
		r: step.r < 0 ? 0 : step.r > 0 ? rows - 1 : from.r,
		c: step.c < 0 ? 0 : step.c > 0 ? columns - 1 : from.c
	};
	const next = move(from);
	if (!inside(next)) return from;
	if (filled(from) && filled(next)) {
		let cell = next;
		while (inside(move(cell)) && filled(move(cell))) cell = move(cell);
		return cell;
	}
	let cell = next;
	while (inside(cell) && !filled(cell)) cell = move(cell);
	return inside(cell) ? cell : edge;
}

/** Home: the start of the row. Ctrl+Home: A1. */
export function homeTarget(from: Pos, ctrl: boolean): Pos {
	return ctrl ? { r: 0, c: 0 } : { r: from.r, c: 0 };
}

/** Ctrl+End: the bottom-right corner of the used area (A1 when the sheet is empty). */
export function endTarget(filledCells: Iterable<Pos>): Pos {
	let r = 0;
	let c = 0;
	for (const cell of filledCells) {
		if (cell.r > r) r = cell.r;
		if (cell.c > c) c = cell.c;
	}
	return { r, c };
}

/** PageUp / PageDown: a screenful of rows, in the same column. */
export function pageTarget(from: Pos, direction: 1 | -1, pageRows: number, rows: number): Pos {
	return { r: clamp(from.r + direction * Math.max(1, pageRows), rows), c: from.c };
}

/** Where Enter and Tab take the active cell once the edit is committed. */
export function commitDirection(key: 'Enter' | 'Tab', shift: boolean): Direction {
	if (key === 'Enter') return shift ? 'up' : 'down';
	return shift ? 'left' : 'right';
}

export interface Address { from: Pos; to: Pos | null }

/**
 * What the name box accepts: "B7", "$B$7", or a range "B2:D9", inside a sheet of the given size.
 * Returns zero-based positions, or null when the text is not an address on this sheet.
 */
export function parseAddress(text: string, rows: number, columns: number): Address | null {
	const match = /^\s*\$?([A-Za-z]{1,4})\$?([1-9]\d*)(?:\s*:\s*\$?([A-Za-z]{1,4})\$?([1-9]\d*))?\s*$/.exec(text);
	if (!match) return null;
	const at = (letters: string, digits: string): Pos => ({ r: Number(digits) - 1, c: columnIndex(letters) });
	const inside = (pos: Pos) => pos.r >= 0 && pos.c >= 0 && pos.r < rows && pos.c < columns;
	const from = at(match[1], match[2]);
	const to = match[3] ? at(match[3], match[4]) : null;
	return inside(from) && (!to || inside(to)) ? { from, to } : null;
}
