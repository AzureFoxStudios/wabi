import { describe, expect, test } from 'bun:test';
import { peekKeyLabel, peekModifierHeld, reorderIndexes } from './railPrefs';

const none = { shiftKey: false, altKey: false, ctrlKey: false };

describe('rail peek modifier', () => {
	test('hover alone does not peek unless the preference is none', () => {
		expect(peekModifierHeld('shift', none)).toBe(false);
		expect(peekModifierHeld('none', none)).toBe(true);
	});
	test('only the configured modifier counts', () => {
		expect(peekModifierHeld('shift', { ...none, shiftKey: true })).toBe(true);
		expect(peekModifierHeld('shift', { ...none, altKey: true })).toBe(false);
		expect(peekModifierHeld('alt', { ...none, altKey: true })).toBe(true);
		expect(peekModifierHeld('ctrl', { ...none, ctrlKey: true })).toBe(true);
	});
	test('labels', () => {
		expect(peekKeyLabel('shift')).toBe('Shift');
		expect(peekKeyLabel('none')).toBe('');
	});
});

describe('rail reorder', () => {
	test('ignores no-op and out-of-range moves', () => {
		expect(reorderIndexes(4, 1, 1)).toBeNull();
		expect(reorderIndexes(4, -1, 2)).toBeNull();
		expect(reorderIndexes(4, 0, 4)).toBeNull();
		expect(reorderIndexes(4, 0, 3)).toEqual({ from: 0, to: 3 });
	});
});
