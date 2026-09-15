import { describe, expect, test } from 'bun:test';
import { parseNotebookBackup, serializeNotebookBackup, type NotebookBackup } from './backup';

const scopeId = 'backup-owner';
const sourceId = '09a8fdc3-3dc2-4d19-a537-e915e10493e7';
const targetId = '0b49a092-e1b8-48b3-8bce-c0c120c47ed0';
function fixture(): NotebookBackup {
	const note = { schemaVersion: 1 as const, scopeId, revision: 9, createdAt: 1, updatedAt: 2, trashedAt: null, pinned: false };
	return { format: 'wabi-local-notebook', version: 1, sourceScopeId: scopeId, exportedAt: 3, notes: [
		{ ...note, id: sourceId, title: 'Source', normalizedTitle: 'source', text: '[[Target|label]]' },
		{ ...note, id: targetId, title: 'Target', normalizedTitle: 'target', text: 'Body', trashedAt: 2 }
	], links: [{ scopeId, sourceId, normalizedTitle: 'target', targetId }] };
}

describe('notebook backup validation', () => {
	test('retains identities, revisions, aliases and Trash', () => {
		const backup = fixture();
		expect(parseNotebookBackup(serializeNotebookBackup(backup))).toEqual(backup);
	});
	test('applies the same byte limit to multibyte export and import', () => {
		const backup = fixture();
		backup.notes = Array.from({ length: 4 }, (_, index) => ({ ...backup.notes[1], id: `0b49a092-e1b8-48b3-8bce-c0c120c47ed${index}`, title: `Note ${index}`, normalizedTitle: `note ${index}`, text: '文'.repeat(1_800_000) }));
		backup.links = [];
		expect(() => serializeNotebookBackup(backup)).toThrow('20 MB');
		expect(() => parseNotebookBackup(JSON.stringify(backup))).toThrow('20 MB');
	});
	test('rejects a partial graph instead of losing deleted link identity', () => {
		const backup = fixture(); backup.links = [];
		expect(() => parseNotebookBackup(JSON.stringify(backup))).toThrow();
	});
	test('accepts an explicit missing UUID but rejects redirected live links', () => {
		const backup = fixture(); backup.notes.pop();
		expect(parseNotebookBackup(JSON.stringify(backup)).links[0].targetId).toBe(targetId);
		const changed = fixture(); changed.links[0].targetId = sourceId;
		expect(() => parseNotebookBackup(JSON.stringify(changed))).toThrow();
	});
	test('rejects cross-owner records and normalized duplicate titles', () => {
		const owner = fixture(); owner.notes[0].scopeId = 'another-account';
		expect(() => parseNotebookBackup(JSON.stringify(owner))).toThrow();
		const duplicate = fixture(); duplicate.notes[1].title = 'Ｓｏｕｒｃｅ'; duplicate.notes[1].normalizedTitle = 'source';
		expect(() => parseNotebookBackup(JSON.stringify(duplicate))).toThrow();
	});
	test('rejects file paths as record IDs and unsupported schemas', () => {
		const backup = fixture(); backup.notes[0].id = '../../secret';
		expect(() => parseNotebookBackup(JSON.stringify(backup))).toThrow();
		expect(() => parseNotebookBackup('{"format":"wabi-local-notebook","version":99}')).toThrow();
	});
});
