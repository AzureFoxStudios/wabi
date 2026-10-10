/**
 * Right rail preferences.
 *
 * `railPeekKey` is the modifier that must be held while hovering a rail item to peek
 * its panel. Hover alone no longer opens panels: moving the pointer toward the scrollbar
 * or a window edge used to fling them open. 'none' restores the old hover-to-peek.
 */
import { writable } from 'svelte/store';

export type RailPeekKey = 'shift' | 'alt' | 'ctrl' | 'none';

const STORAGE_KEY = 'wabi:rail-peek-key';
const VALID: RailPeekKey[] = ['shift', 'alt', 'ctrl', 'none'];

function read(): RailPeekKey {
	try {
		const value = globalThis.localStorage?.getItem(STORAGE_KEY);
		return VALID.includes(value as RailPeekKey) ? (value as RailPeekKey) : 'shift';
	} catch {
		return 'shift';
	}
}

export const railPeekKey = writable<RailPeekKey>(read());

railPeekKey.subscribe((value) => {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, value);
	} catch {
		/* preference just won't persist */
	}
});

/** Does this pointer/keyboard event satisfy the configured peek modifier? */
export function peekModifierHeld(
	key: RailPeekKey,
	event: Pick<MouseEvent, 'shiftKey' | 'altKey' | 'ctrlKey'>
): boolean {
	switch (key) {
		case 'none':
			return true;
		case 'shift':
			return event.shiftKey;
		case 'alt':
			return event.altKey;
		case 'ctrl':
			return event.ctrlKey;
	}
}

/** The label shown in hints, e.g. "Shift". */
export function peekKeyLabel(key: RailPeekKey): string {
	return key === 'none' ? '' : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Pure helper for drag-reorder: where an item moves when dropped on `target`. */
export function reorderIndexes(length: number, from: number, to: number): { from: number; to: number } | null {
	if (from < 0 || from >= length || to < 0 || to >= length || from === to) return null;
	return { from, to };
}
