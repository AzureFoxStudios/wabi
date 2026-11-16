import { expect, test } from 'bun:test';
import { shortcutsFor, type OfficeTool } from './officeShortcuts';

const tools: OfficeTool[] = ['sheets', 'documents', 'present'];

test('every tool lists its own keys and the keys that work everywhere', () => {
	for (const tool of tools) {
		const groups = shortcutsFor(tool, false);
		expect(groups.length).toBeGreaterThanOrEqual(2);
		expect(groups.at(-1)!.title).toBe('Everywhere in the editor');
		for (const group of groups) {
			expect(group.rows.length).toBeGreaterThan(0);
			for (const row of group.rows) { expect(row.keys.length).toBeGreaterThan(0); expect(row.action.length).toBeGreaterThan(3); }
		}
	}
});

test('Mod is Ctrl, or the command key on a Mac, with Alt as Option', () => {
	const all = (mac: boolean) => shortcutsFor('documents', mac).flatMap((group) => group.rows.map((row) => row.keys)).join(' | ');
	expect(all(false)).toContain('Ctrl+K');
	expect(all(false)).not.toContain('Mod');
	expect(all(true)).toContain('⌘+K');
	expect(all(true)).toContain('Option+1');
	expect(all(true)).not.toContain('Ctrl');
});

test('no key is listed twice within one tool', () => {
	for (const tool of tools) {
		const keys = shortcutsFor(tool, false).flatMap((group) => group.rows.map((row) => row.keys));
		expect(new Set(keys).size).toBe(keys.length);
	}
});
