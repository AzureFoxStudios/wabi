import { expect, test } from 'bun:test';
import { countShortcuts, searchShortcutAreas, shortcutAreas, UNLISTED_NOTE } from './appShortcuts';

test('the page covers the app, chat, the three office tools and settings, each with something in it', () => {
	const areas = shortcutAreas(false);
	expect(areas.map((area) => area.id)).toEqual(['general', 'chat', 'documents', 'sheets', 'present', 'other']);
	for (const area of areas) {
		expect(area.where.length).toBeGreaterThan(5);
		expect(area.groups.length).toBeGreaterThan(0);
		for (const group of area.groups) {
			expect(group.rows.length).toBeGreaterThan(0);
			for (const row of group.rows) { expect(row.keys.trim().length).toBeGreaterThan(0); expect(row.action.trim().length).toBeGreaterThan(3); }
		}
	}
});

test('the office areas are the very lists the shortcuts sheet in the editor shows', async () => {
	const { shortcutsFor } = await import('../workspaces/officeShortcuts');
	const areas = shortcutAreas(false);
	for (const tool of ['documents', 'sheets', 'present'] as const) expect(areas.find((area) => area.id === tool)!.groups).toEqual(shortcutsFor(tool, false));
});

test('no key is listed twice within an area', () => {
	for (const area of shortcutAreas(false)) {
		const keys = area.groups.flatMap((group) => group.rows.map((row) => row.keys));
		expect(new Set(keys).size, area.id).toBe(keys.length);
	}
});

test('Mod is Ctrl, or the command key on a Mac, everywhere including the app-wide keys', () => {
	const text = (mac: boolean) => shortcutAreas(mac).flatMap((area) => area.groups.flatMap((group) => group.rows.map((row) => row.keys))).join(' | ');
	expect(text(false)).not.toContain('Mod');
	expect(text(false)).toContain('Ctrl+K');
	expect(text(true)).not.toContain('Mod');
	expect(text(true)).toContain('⌘+K');
	expect(text(true)).toContain('⌘+Shift+N');
	// Sign out is bound to the Control key itself on every platform, so it is not turned into the command key.
	expect(text(true)).toContain('Ctrl+Shift+O');
});

test('search finds a key, an action word, or an area, and every word must match', () => {
	const areas = shortcutAreas(false);
	const ids = (query: string) => searchShortcutAreas(areas, query).map((area) => area.id);
	expect(ids('scratchpad')).toEqual(['general']);
	expect(ids('ctrl+k')).toContain('general');
	expect(ids('ctrl+k')).toContain('documents'); // Link in a document is Ctrl+K as well
	expect(ids('fill handle')).toEqual(['sheets']);
	expect(ids('PRESENT slide')).toEqual(['present']);
	expect(ids('emoji')).toEqual(['chat']);
	expect(ids('zzzz')).toEqual([]);
	expect(searchShortcutAreas(areas, '   ')).toHaveLength(areas.length);
});

test('search drops the groups and rows that do not match, but keeps their areas intact otherwise', () => {
	const found = searchShortcutAreas(shortcutAreas(false), 'send');
	const chat = found.find((area) => area.id === 'chat')!;
	expect(chat.groups.flatMap((group) => group.rows.map((row) => row.keys))).toEqual(['Enter']);
	expect(countShortcuts(found)).toBeGreaterThan(0);
	expect(countShortcuts(shortcutAreas(false))).toBeGreaterThan(60);
});

test('the page says plainly what it does not cover', () => {
	expect(UNLISTED_NOTE).toContain('Calls');
	expect(UNLISTED_NOTE).toContain('not listed yet');
});
