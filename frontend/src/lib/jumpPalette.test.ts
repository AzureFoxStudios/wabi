import { afterEach, expect, mock, test } from 'bun:test';
import { get } from 'svelte/store';
import {
	PALETTE_SCOPES,
	PALETTE_SCOPE_LABEL,
	closePalette,
	isPaletteShortcut,
	nextPaletteScope,
	openPalette,
	palette,
	paletteOpen,
	paletteScope,
	parsePaletteInput,
	setPaletteScope,
	togglePalette,
	type PaletteScope
} from './jumpPalette';

function fakeOrigin(connected = true) {
	return { isConnected: connected, focus: mock((_options?: FocusOptions) => {}) } as unknown as HTMLElement & { focus: ReturnType<typeof mock> };
}

afterEach(() => closePalette({ restoreFocus: false }));

test('starts closed in Everything', () => {
	expect(get(paletteOpen)).toBe(false);
	expect(get(paletteScope)).toBe('all');
});

test('opens in Everything by default, or in the requested scope', () => {
	openPalette();
	expect(get(paletteOpen)).toBe(true);
	expect(get(paletteScope)).toBe('all');
	closePalette();
	openPalette('people');
	expect(get(palette)).toMatchObject({ open: true, scope: 'people', query: '' });
});

test('an unknown scope falls back to Everything', () => {
	openPalette('servers' as PaletteScope);
	expect(get(paletteScope)).toBe('all');
});

test('each opening from closed is a new session; re-opening while open only switches scope', () => {
	const start = get(palette).session;
	openPalette('channels', { query: 'gen' });
	expect(get(palette)).toMatchObject({ session: start + 1, scope: 'channels', query: 'gen' });
	openPalette('workspaces');
	expect(get(palette)).toMatchObject({ open: true, session: start + 1, scope: 'workspaces', query: 'gen' });
	closePalette();
	expect(get(palette)).toMatchObject({ open: false, query: '' });
	openPalette();
	expect(get(palette).session).toBe(start + 2);
});

test('closing returns focus to the origin, unless told not to', () => {
	const origin = fakeOrigin();
	openPalette('all', { origin });
	closePalette();
	expect(origin.focus).toHaveBeenCalledTimes(1);
	expect(origin.focus.mock.calls[0][0]).toEqual({ preventScroll: true });

	const other = fakeOrigin();
	openPalette('all', { origin: other });
	closePalette({ restoreFocus: false });
	expect(other.focus).not.toHaveBeenCalled();
});

test('the origin is kept from the first opening and skipped once it left the document', () => {
	const first = fakeOrigin();
	const second = fakeOrigin();
	openPalette('all', { origin: first });
	openPalette('actions', { origin: second });
	closePalette();
	expect(first.focus).toHaveBeenCalledTimes(1);
	expect(second.focus).not.toHaveBeenCalled();

	const detached = fakeOrigin(false);
	openPalette('all', { origin: detached });
	closePalette();
	expect(detached.focus).not.toHaveBeenCalled();
});

test('closing an already closed palette does nothing', () => {
	const before = get(palette);
	closePalette();
	expect(get(palette)).toBe(before);
});

test('Ctrl K toggles', () => {
	togglePalette();
	expect(get(paletteOpen)).toBe(true);
	togglePalette();
	expect(get(paletteOpen)).toBe(false);
});

test('scope chips switch scope only while open', () => {
	setPaletteScope('people');
	expect(get(paletteScope)).toBe('all');
	openPalette();
	setPaletteScope('actions');
	expect(get(paletteScope)).toBe('actions');
	setPaletteScope('nope' as PaletteScope);
	expect(get(paletteScope)).toBe('actions');
});

test('Tab walks the scope row in chip order and wraps both ways', () => {
	expect(PALETTE_SCOPES).toEqual(['all', 'channels', 'people', 'workspaces', 'actions']);
	expect(PALETTE_SCOPES.map((scope) => PALETTE_SCOPE_LABEL[scope])).toEqual(['Everything', 'Channels', 'People', 'Workspaces', 'Actions']);
	expect(nextPaletteScope('all')).toBe('channels');
	expect(nextPaletteScope('actions')).toBe('all');
	expect(nextPaletteScope('all', -1)).toBe('actions');
	expect(nextPaletteScope('people', -1)).toBe('channels');
});

test('a leading prefix switches scope and leaves the rest as the query', () => {
	expect(parsePaletteInput('#gen', 'all')).toEqual({ scope: 'channels', query: 'gen' });
	expect(parsePaletteInput('@mei', 'channels')).toEqual({ scope: 'people', query: 'mei' });
	expect(parsePaletteInput('/doc', 'all')).toEqual({ scope: 'workspaces', query: 'doc' });
	expect(parsePaletteInput('>theme', 'all')).toEqual({ scope: 'actions', query: 'theme' });
	expect(parsePaletteInput('doc #2', 'people')).toEqual({ scope: 'people', query: 'doc #2' });
	expect(parsePaletteInput('', 'workspaces')).toEqual({ scope: 'workspaces', query: '' });
});

test('the shortcut is Ctrl K or ⌘K without Shift or Alt, and not while composing', () => {
	const key = (init: Partial<KeyboardEvent> & { isComposing?: boolean }) => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
	expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
	expect(isPaletteShortcut(key({ metaKey: true, key: 'K' }))).toBe(true);
	expect(isPaletteShortcut(key({}))).toBe(false);
	expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
	expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
	expect(isPaletteShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false);
	expect(isPaletteShortcut(key({ ctrlKey: true, key: 'j' }))).toBe(false);
});

test('the shortcut follows the physical K key on non-Latin layouts, never a moved Latin letter', () => {
	const key = (init: Partial<KeyboardEvent>) => ({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...init });
	expect(isPaletteShortcut(key({ key: 'л' }))).toBe(true); // Russian
	expect(isPaletteShortcut(key({ key: 'κ' }))).toBe(true); // Greek
	expect(isPaletteShortcut(key({ key: 'Л', metaKey: true, ctrlKey: false }))).toBe(true);
	expect(isPaletteShortcut(key({ key: 'л', shiftKey: true }))).toBe(false);
	expect(isPaletteShortcut(key({ key: 'л', ctrlKey: false }))).toBe(false);
	// Dvorak: the physical K key types "t", and "k" lives on the physical V key.
	expect(isPaletteShortcut(key({ key: 't' }))).toBe(false);
	expect(isPaletteShortcut(key({ key: 'k', code: 'KeyV' }))).toBe(true);
	// A non-Latin letter on another key is not the shortcut.
	expect(isPaletteShortcut(key({ key: 'д', code: 'KeyL' }))).toBe(false);
});
