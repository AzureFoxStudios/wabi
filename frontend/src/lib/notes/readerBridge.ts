export interface ReaderNoteSource { scopeId: string; noteId: string }
const prefix = 'notes:wabi-note:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readerNoteSourceId(scopeId: string, noteId: string): string {
	return `wabi-note:${scopeId}:${noteId}`;
}

/** Existing Reader working copies already preserve this source identity. */
export function parseReaderNoteSource(sourceKey?: string | null): ReaderNoteSource | null {
	if (!sourceKey?.startsWith(prefix)) return null;
	const separator = sourceKey.lastIndexOf(':');
	const scopeId = sourceKey.slice(prefix.length, separator);
	const noteId = sourceKey.slice(separator + 1);
	if (!scopeId.startsWith('notebook:v1:') || !uuid.test(noteId)) return null;
	return { scopeId, noteId };
}
