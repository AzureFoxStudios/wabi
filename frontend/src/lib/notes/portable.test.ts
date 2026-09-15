import { expect, test } from 'bun:test';
import { portableNotebookFiles, packNotebookFiles, portableNotePath } from './portable';
import type { NotebookBackup } from './backup';
const scopeId = 'export-owner';
const a = '09a8fdc3-3dc2-4d19-a537-e915e10493e7', b = '0b49a092-e1b8-48b3-8bce-c0c120c47ed0';
const base = { schemaVersion: 1 as const, scopeId, revision: 1, createdAt: 1, updatedAt: 1, trashedAt: null, pinned: false };
function fixture(): NotebookBackup {
	return { format: 'wabi-local-notebook', version: 1, sourceScopeId: scopeId, exportedAt: 1, notes: [
		{ ...base, id: a, title: 'CON', normalizedTitle: 'con', text: '[[Target|a *label*]] `[[Target]]`' },
		{ ...base, id: b, title: 'Target', normalizedTitle: 'target', text: '文', trashedAt: 1 }
	], links: [{ scopeId, sourceId: a, normalizedTitle: 'target', targetId: b }] };
}
test('portable files preserve aliases, literal code, Trash links and complete restore metadata', () => {
	const backup = fixture(), files = portableNotebookFiles(backup);
	expect(files.get(`notes/con-${a}.md`)).toBe(`[a \\*label\\*](../trash/target-${b}.md) \`[[Target]]\``);
	expect(files.get(`trash/target-${b}.md`)).toBe('文');
	expect(JSON.parse(files.get('notebook.json')!)).toEqual(backup);
});
test('missing UUID links stay unresolved despite a reused title', () => {
	const backup = fixture(); backup.links[0].targetId = '29a8fdc3-3dc2-4d19-a537-e915e10493e7';
	expect(portableNotebookFiles(backup).get(`notes/con-${a}.md`)).toBe(backup.notes[0].text);
});
test('portable paths avoid traversal and slug collisions; malformed graph cannot export', () => {
	expect(portableNotePath('../../É?!', a, false)).toBe(`notes/e-${a}.md`);
	expect(portableNotePath('文', b, false)).toBe(`notes/note-${b}.md`);
	expect(() => packNotebookFiles(new Map([['../bad', 'text']]))).toThrow();
	const backup = fixture(); backup.links = [];
	expect(() => portableNotebookFiles(backup)).toThrow();
});
