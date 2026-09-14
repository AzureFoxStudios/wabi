import { describe, expect, test } from 'bun:test';
import {
	hasCompleteE2eeAttachmentMetadata,
	isE2eeAttachmentMetadata,
	resolveAttachmentDownloadBlob
} from './attachmentDownload';

const complete = {
	scheme: 'dm-e2ee-v1' as const,
	iv: 'nonce-prefix',
	mimeType: 'text/plain',
	originalSize: 5,
	epoch: 2,
	chunkSize: 1024,
	noncePrefix: 'nonce-prefix',
	fileId: 'file-123'
};

describe('attachment download boundary', () => {
	test('recognizes complete E2EE attachment metadata', () => {
		expect(isE2eeAttachmentMetadata(complete)).toBe(true);
		expect(hasCompleteE2eeAttachmentMetadata(complete)).toBe(true);
	});

	test('rejects legacy/incomplete metadata instead of returning ciphertext as the file', () => {
		expect(hasCompleteE2eeAttachmentMetadata({
			scheme: 'dm-e2ee-v1',
			iv: 'old-iv',
			originalSize: 5
		})).toBe(false);
	});

	test('plain attachments return the downloaded blob unchanged', async () => {
		const response = new Response(new Blob(['hello'], { type: 'text/plain' }), { status: 200 });
		const blob = await resolveAttachmentDownloadBlob('shared', response, undefined);
		expect(await blob.text()).toBe('hello');
		expect(blob.type).toBe('text/plain');
	});

	test('failed HTTP responses are surfaced before attempting decryption', async () => {
		const response = new Response('missing', { status: 404 });
		expect(resolveAttachmentDownloadBlob('dm', response, complete)).rejects.toThrow('404');
	});
});
