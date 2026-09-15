import { describe, expect, test } from 'bun:test';
import { hasReaderDocumentWriteConflict } from './readerDocuments';

describe('Reader document cross-window CAS', () => {
	test('equal durable revision may save and stale durable revision may not', () => {
		expect(hasReaderDocumentWriteConflict(3, 3)).toBe(false);
		expect(hasReaderDocumentWriteConflict(4, 3)).toBe(true);
	});
});
