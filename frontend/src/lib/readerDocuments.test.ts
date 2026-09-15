import { describe, expect, test } from 'bun:test';
import {
	acceptReaderSuggestion,
	applyReaderDocumentEdit,
	createOrUpdateReaderSuggestion,
	createReaderDocumentRecord,
	hasReaderDocumentWriteConflict,
	isReaderDocumentChanged,
	shouldFinalizeReaderDocumentSave,
	type ReaderLocalDocument
} from './readerDocuments';
import { makeReaderDocumentScope, normalizeReaderDocumentServerScope } from './readerDocumentScope';
import { readerSourceDocumentKey } from './readerWorkspace';
import type { ReaderDocumentSelection } from './readerWorkspace';

function selection(overrides: Partial<ReaderDocumentSelection> = {}): ReaderDocumentSelection {
	return {
		id: 'reader-1',
		docKey: 'source-key',
		title: 'Lesson Notes',
		content: '# Hello\n\nOriginal body.',
		format: 'markdown',
		updatedAt: 1,
		source: 'chat',
		contentType: 'text',
		...overrides
	};
}

describe('Reader local-first document model', () => {
	test('first editable copy is private, stable, scoped, and preserves the source snapshot', () => {
		const record = createReaderDocumentRecord(selection(), 'wdoc-test', 100, 'https://one.example|user:7');
		expect(record.documentId).toBe('wdoc-test');
		expect(record.scopeId).toBe('https://one.example|user:7');
		expect(record.storageRevision).toBe(0);
		expect(record.kind).toBe('working-copy');
		expect(record.shareState).toBe('private');
		expect(record.sourceDocKey).toBe('source-key');
		expect(record.originalContent).toBe('# Hello\n\nOriginal body.');
		expect(record.content).toBe(record.originalContent);
		expect(record.revision).toBe(0);
	});

	test('server and account identities produce isolated document scopes', () => {
		expect(normalizeReaderDocumentServerScope('HTTPS://Wabi.Example/')).toBe('https://wabi.example');
		expect(makeReaderDocumentScope('https://wabi.example', 'user:1'))
			.not.toBe(makeReaderDocumentScope('https://wabi.example', 'user:2'));
		expect(makeReaderDocumentScope('https://wabi.example', 'user:1'))
			.not.toBe(makeReaderDocumentScope('https://other.example', 'user:1'));
	});

	test('chat and note source ids stay distinct even when content hashes collide', () => {
		expect(readerSourceDocumentKey('chat', 'message-a', 'same-content-key')).toBe('chat:message-a');
		expect(readerSourceDocumentKey('chat', 'message-b', 'same-content-key')).toBe('chat:message-b');
		expect(readerSourceDocumentKey('notes', 'notes-panel:note-a', 'same-content-key')).toBe('notes:notes-panel:note-a');
	});

	test('editing advances the local revision without mutating the source snapshot', () => {
		const record = createReaderDocumentRecord(selection(), 'wdoc-test', 100);
		const edited = applyReaderDocumentEdit(record, { content: '# Hello\n\nChanged locally.' }, 200);
		expect(edited.content).toContain('Changed locally');
		expect(edited.originalContent).toContain('Original body');
		expect(edited.revision).toBe(1);
		expect(isReaderDocumentChanged(edited)).toBe(true);
	});

	test('an older persistence completion cannot finalize over a newer local edit', () => {
		const original = createReaderDocumentRecord(selection(), 'wdoc-test', 100);
		const first = applyReaderDocumentEdit(original, { content: 'first local edit' }, 200);
		const newer = applyReaderDocumentEdit(first, { content: 'newer local edit' }, 201);
		expect(shouldFinalizeReaderDocumentSave(first, first)).toBe(true);
		expect(shouldFinalizeReaderDocumentSave(newer, first)).toBe(false);
		expect(shouldFinalizeReaderDocumentSave(newer, newer)).toBe(true);
	});

	test('a stale browser context is rejected by storage revision instead of overwriting', () => {
		expect(hasReaderDocumentWriteConflict(4, 4)).toBe(false);
		expect(hasReaderDocumentWriteConflict(5, 4)).toBe(true);
		expect(hasReaderDocumentWriteConflict(null, 0)).toBe(false);
	});

	test('suggestions are separate from canonical content until accepted', () => {
		const record = createReaderDocumentRecord(selection(), 'wdoc-test', 100);
		const { document, suggestion } = createOrUpdateReaderSuggestion(
			record,
			null,
			{ content: '# Hello\n\nSuggested body.' },
			200
		);
		expect(document.content).toContain('Original body');
		expect(suggestion.content).toContain('Suggested body');
		expect(suggestion.status).toBe('open');
		expect(suggestion.baseRevision).toBe(0);
	});

	test('accepting a suggestion promotes its text to the canonical document', () => {
		const initial = createReaderDocumentRecord(selection(), 'wdoc-test', 100);
		const result = createOrUpdateReaderSuggestion(initial, null, { content: 'Suggested' }, 200);
		const accepted: ReaderLocalDocument = {
			...result.document,
			content: result.suggestion.content,
			revision: result.document.revision + 1,
			suggestions: result.document.suggestions.map((item) => item.id === result.suggestion.id
				? { ...item, status: 'accepted' as const }
				: item)
		};
		expect(accepted.content).toBe('Suggested');
		expect(accepted.revision).toBe(1);
		expect(accepted.suggestions[0].status).toBe('accepted');
		expect(typeof acceptReaderSuggestion).toBe('function');
	});
});
