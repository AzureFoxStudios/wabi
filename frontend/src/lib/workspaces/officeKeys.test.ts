import { expect, test } from 'bun:test';
import { officeKeyAction, keyTarget } from './officeKeys';

const grid = { textEntry: false, codeEditor: false };
const typing = { textEntry: true, codeEditor: false };
const code = { textEntry: false, codeEditor: true };
const press = (key: string, extra: Partial<Parameters<typeof officeKeyAction>[0]> = {}) => ({
	key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...extra
});

test('Ctrl and Cmd undo and redo from the grid or canvas', () => {
	expect(officeKeyAction(press('z'), grid)).toBe('undo');
	expect(officeKeyAction(press('Z', { shiftKey: true }), grid)).toBe('redo');
	expect(officeKeyAction(press('y'), grid)).toBe('redo');
	expect(officeKeyAction(press('z', { ctrlKey: false, metaKey: true }), grid)).toBe('undo');
});

test('undo and redo are left to a text field or the code editor', () => {
	expect(officeKeyAction(press('z'), typing)).toBeNull();
	expect(officeKeyAction(press('y'), typing)).toBeNull();
	expect(officeKeyAction(press('z'), code)).toBeNull();
	expect(officeKeyAction(press('z', { shiftKey: true }), code)).toBeNull();
});

test('save is taken everywhere, including while typing', () => {
	expect(officeKeyAction(press('s'), grid)).toBe('save');
	expect(officeKeyAction(press('S'), typing)).toBe('save');
	expect(officeKeyAction(press('s'), code)).toBe('save');
});

test('shifted save, plain keys and other chords are ignored', () => {
	expect(officeKeyAction(press('s', { shiftKey: true }), grid)).toBeNull();
	expect(officeKeyAction(press('z', { ctrlKey: false }), grid)).toBeNull();
	expect(officeKeyAction(press('a'), grid)).toBeNull();
	expect(officeKeyAction(press('y', { shiftKey: true }), grid)).toBeNull();
});

test('AltGr (Ctrl+Alt), both modifiers, and IME composition never trigger', () => {
	expect(officeKeyAction(press('z', { altKey: true }), grid)).toBeNull();
	expect(officeKeyAction(press('s', { altKey: true }), grid)).toBeNull();
	expect(officeKeyAction(press('z', { metaKey: true }), grid)).toBeNull();
	expect(officeKeyAction(press('z', { isComposing: true }), grid)).toBeNull();
});

test('outside a browser the target is treated as plain', () => {
	expect(keyTarget(null)).toEqual({ textEntry: false, codeEditor: false });
});

test('Ctrl+/ opens the shortcuts list from anywhere, but a shifted slash is left alone', () => {
	expect(officeKeyAction(press('/'), grid)).toBe('help');
	expect(officeKeyAction(press('/'), typing)).toBe('help');
	expect(officeKeyAction(press('/'), code)).toBe('help');
	expect(officeKeyAction(press('/', { shiftKey: true }), grid)).toBeNull();
	expect(officeKeyAction(press('/', { altKey: true }), grid)).toBeNull();
});
