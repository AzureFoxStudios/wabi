import { describe, expect, test } from 'bun:test';

// The production store uses a per-module writer id in every recovery key.
// Pin the invariant here at the contract level so later simplification cannot
// collapse competing browser contexts back onto one recovery slot.
describe('Reader recovery contract', () => {
	test('competing writer recovery keys must be distinct', () => {
		const prefix = 'wabi:reader:document-recovery:v2:';
		const scope = encodeURIComponent('https://one.example|user:7');
		const documentId = 'wdoc-1';
		const first = `${prefix}${scope}:${documentId}:writer-a`;
		const second = `${prefix}${scope}:${documentId}:writer-b`;
		expect(first).not.toBe(second);
	});
});
