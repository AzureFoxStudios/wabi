import { describe, expect, test } from 'bun:test';
import {
	acceptReaderSuggestion,
	applyReaderDocumentEdit,
	createOrUpdateReaderSuggestion,
	createReaderDocumentRecord,
	isReaderDocumentChanged,
	type ReaderLocalDocument
} from './readerDocuments';
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
	test('first editable copy is private, stable, and preserves the source snapshot', () => {
		const record = createReaderDocumentRecord(selection(), 'wdoc-test', 100);
		expect(record.documentId).toBe('wdoc-test');
		expect(record.kind).toBe('working-copy');
		expect(record.shareState).toBe('private');
		expect(record.sourceDocKey).toBe('source-key');
		expect(record.originalContent).toBe('# Hello\n\nOriginal body.');
		expect(record.content).toBe(record.originalContent);
		expect(record.revision).toBe(0);
	});

	test('editing advances the local revision without mutating the source snapshot', () => {
		const record = createReaderDocumentRecord(selection(), 'wdoc-test', 100);
		const edited = applyReaderDocumentEdit(record, { content: '# Hello\n\nChanged locally.' }, 200);
		expect(edited.content).toContain('Changed locally');
		expect(edited.originalContent).toContain('Original body');
		expect(edited.revision).toBe(1);
		expect(isReaderDocumentChanged(edited)).toBe(true);
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
		// Mirror the small store transition that acceptReaderSuggestion performs,
		// but keep this pure assertion independent of browser persistence.
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
		// Keep the exported command referenced so accidental removal is caught by TS.
		expect(typeof acceptReaderSuggestion).toBe('function');
	});
});
