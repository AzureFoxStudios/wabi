import { describe, expect, test } from 'bun:test';
import { makeReaderDocumentScope, normalizeReaderDocumentServerScope } from './readerDocumentScope';

describe('Reader document storage scope', () => {
	test('normalizes equivalent server URLs', () => {
		expect(normalizeReaderDocumentServerScope('HTTPS://Example.COM/')).toBe('https://example.com');
		expect(normalizeReaderDocumentServerScope('example.com')).toBe('https://example.com');
	});

	test('account and server both participate in the privacy boundary', () => {
		expect(makeReaderDocumentScope('https://example.com', 'user:1'))
			.not.toBe(makeReaderDocumentScope('https://example.com', 'user:2'));
		expect(makeReaderDocumentScope('https://example.com', 'user:1'))
			.not.toBe(makeReaderDocumentScope('https://elsewhere.example', 'user:1'));
	});
});
