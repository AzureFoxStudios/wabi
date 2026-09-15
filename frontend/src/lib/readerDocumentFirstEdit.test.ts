import { describe, expect, test } from 'bun:test';
import { createReaderDocumentRecord } from './readerDocuments';
import type { ReaderDocumentSelection } from './readerWorkspace';

const base: ReaderDocumentSelection = {
	id: 'reader-source',
	docKey: 'content-derived',
	sourceDocKey: 'chat:message-42',
	title: 'Same content',
	content: 'identical body',
	format: 'markdown',
	updatedAt: 1,
	source: 'chat',
	contentType: 'text'
};

describe('Reader first-edit contract', () => {
	test('working copies retain stable source identity independently of content', () => {
		const first = createReaderDocumentRecord(base, 'draft-a', 10, 'server-a|user:1');
		const second = createReaderDocumentRecord(
			{ ...base, sourceDocKey: 'chat:message-43' },
			'draft-b',
			10,
			'server-a|user:1'
		);
		expect(first.sourceDocKey).toBe('chat:message-42');
		expect(second.sourceDocKey).toBe('chat:message-43');
		expect(first.sourceDocKey).not.toBe(second.sourceDocKey);
	});
});
