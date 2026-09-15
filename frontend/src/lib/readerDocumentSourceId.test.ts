import { describe, expect, test } from 'bun:test';
import { readerSourceDocumentKey } from './readerWorkspace';

describe('Reader source identities', () => {
	test('stable source ids override content-derived Reader keys', () => {
		expect(readerSourceDocumentKey('chat', 'msg-1', 'rdoc-same')).toBe('chat:msg-1');
		expect(readerSourceDocumentKey('chat', 'msg-2', 'rdoc-same')).toBe('chat:msg-2');
		expect(readerSourceDocumentKey('notes', 'sidebar:note-1', 'rdoc-same')).toBe('notes:sidebar:note-1');
	});

	test('sources without an entity id keep legacy Reader identity', () => {
		expect(readerSourceDocumentKey('pasted', undefined, 'rdoc-legacy')).toBe('rdoc-legacy');
	});
});
