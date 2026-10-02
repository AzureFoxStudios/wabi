import { normalizeNoteTitle, parseNoteLinks } from './links';
import { serializeNotebookBackup, type NotebookBackup } from './backup';

export interface MarkdownFile { name: string; text: string; lastModified?: number; }
/** Convert portable Markdown into the existing atomic, account-fenced importer. */
export async function markdownNotebook(files: MarkdownFile[]): Promise<string> {
 if (!files.length || files.length > 1000) throw new Error('Choose between 1 and 1,000 Markdown files.');
 const sourceScopeId = 'markdown-import';
 const titles = new Set<string>();
 const notes: NotebookBackup['notes'] = [];
 for (const file of files) {
  if (!/\.(md|markdown)$/i.test(file.name)) continue;
  if (file.text.length > 2_000_000) throw new Error(`${file.name} exceeds the supported note size.`);
  const stem = file.name.split('/').pop()!.replace(/\.(md|markdown)$/i, '').replace(/[\[\]|\u0000-\u001f]/g, ' ').trim().slice(0, 180) || 'Imported note';
  let title = stem, suffix = 2;
  while (titles.has(normalizeNoteTitle(title))) title = `${stem} (${suffix++})`;
  titles.add(normalizeNoteTitle(title));
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${file.name}\0${file.text}`));
  const hash = [...new Uint8Array(bytes)].slice(0, 16).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20)}`;
  const modified = Number.isSafeInteger(file.lastModified) && file.lastModified! > 0 ? file.lastModified! : 0;
  notes.push({ schemaVersion: 1, scopeId: sourceScopeId, id, title, normalizedTitle: normalizeNoteTitle(title), text: file.text, revision: 1, createdAt: modified, updatedAt: modified, trashedAt: null, pinned: false });
 }
 if (!notes.length) throw new Error('No Markdown files were found.');
 const targets = new Map(notes.map(note => [note.normalizedTitle, note.id]));
 const links: NotebookBackup['links'] = [];
 for (const note of notes) {
  const seen = new Set<string>();
  for (const link of parseNoteLinks(note.text)) {
   if (seen.has(link.normalizedTitle)) continue;
   seen.add(link.normalizedTitle);
   links.push({ scopeId: sourceScopeId, sourceId: note.id, normalizedTitle: link.normalizedTitle, targetId: targets.get(link.normalizedTitle) || null });
  }
 }
 return serializeNotebookBackup({ format: 'wabi-local-notebook', version: 1, sourceScopeId, exportedAt: 0, notes, links });
}
