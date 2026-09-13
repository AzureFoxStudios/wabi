import { describe, expect, test } from 'bun:test';
import { computeKeyboardInset, isKeyboardInsetOpen } from './mobileShell';

describe('mobile shell viewport measurements', () => {
	test('treats an Android-style IME resize as keyboard space', () => {
		const inset = computeKeyboardInset({
			layoutHeight: 800,
			viewportHeight: 488,
			viewportOffsetTop: 0
		});
		expect(inset).toBe(312);
		expect(isKeyboardInsetOpen(inset)).toBe(true);
	});

	test('accounts for iOS visual viewport offset while the keyboard is open', () => {
		const inset = computeKeyboardInset({
			layoutHeight: 844,
			viewportHeight: 515,
			viewportOffsetTop: 42
		});
		expect(inset).toBe(287);
		expect(isKeyboardInsetOpen(inset)).toBe(true);
	});

	test('does not mistake ordinary browser chrome movement for a keyboard', () => {
		const inset = computeKeyboardInset({
			layoutHeight: 800,
			viewportHeight: 752,
			viewportOffsetTop: 0
		});
		expect(inset).toBe(48);
		expect(isKeyboardInsetOpen(inset)).toBe(false);
	});

	test('handles landscape measurements without producing a negative inset', () => {
		const inset = computeKeyboardInset({
			layoutHeight: 390,
			viewportHeight: 390,
			viewportOffsetTop: 12
		});
		expect(inset).toBe(0);
		expect(isKeyboardInsetOpen(inset)).toBe(false);
	});

	test('clamps malformed measurements instead of poisoning CSS with NaN', () => {
		expect(computeKeyboardInset({ layoutHeight: Number.NaN, viewportHeight: Number.NaN })).toBe(0);
		expect(isKeyboardInsetOpen(Number.NaN)).toBe(false);
	});
});
