import { expect, test } from 'bun:test';
import { parseReaderNoteSource, readerNoteSourceId } from './readerBridge';

test('Reader source survives scoped URL punctuation and keeps UUID identity', () => {
	const scopeId = 'notebook:v1:https%3A%2F%2Fexample.test%2FCase:account:2';
	const noteId = '09a8fdc3-3dc2-4d19-a537-e915e10493e7';
	expect(parseReaderNoteSource(`notes:${readerNoteSourceId(scopeId, noteId)}`)).toEqual({ scopeId, noteId });
});

test('ordinary Reader sources and malformed references cannot masquerade as note links', () => {
	for (const value of [undefined, 'notes:legacy:123', 'generated:wabi-note:scope:id', 'notes:wabi-note:other:09a8fdc3-3dc2-4d19-a537-e915e10493e7', 'notes:wabi-note:notebook:v1:x:../../file']) expect(parseReaderNoteSource(value)).toBeNull();
});
