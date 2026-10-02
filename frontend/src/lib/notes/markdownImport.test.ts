import { expect, test } from 'bun:test';
import { markdownNotebook } from './markdownImport';
import { parseNotebookBackup } from './backup';
import { noteSnippet } from './snippet';
test('Markdown import keeps title links and produces a stable restorable backup', async () => {
 const files = [{name:'vault/First.md',text:'See [[Second]]'}, {name:'vault/Second.md',text:'# Heading'}];
 const raw = await markdownNotebook(files); const backup = parseNotebookBackup(raw);
 expect(backup.links[0].targetId).toBe(backup.notes[1].id);
 expect(await markdownNotebook(files)).toBe(raw);
 expect(backup.notes[0].contextChannelId).toBeUndefined();
});
test('duplicate names remain distinct and invalid import is refused', async () => {
 const backup = parseNotebookBackup(await markdownNotebook([{name:'a/Note.md',text:'a'}, {name:'b/Note.md',text:'b'}]));
 expect(backup.notes.map(note => note.title)).toEqual(['Note','Note (2)']);
 await expect(markdownNotebook([])).rejects.toThrow();
});
test('note snippets show readable text rather than Markdown punctuation', () => {
 expect(noteSnippet('# A **bold** *note* with [link](https://example.org) and [[Other|alias]]')).toBe('A bold note with link and alias');
});
test('Markdown imports retain file modification dates instead of displaying 1970', async () => {
 const lastModified = Date.UTC(2026, 9, 1);
 const backup = parseNotebookBackup(await markdownNotebook([{ name: 'Note.md', text: 'Writing', lastModified }]));
 expect(backup.notes[0].updatedAt).toBe(lastModified);
 expect(backup.notes[0].createdAt).toBe(lastModified);
});
