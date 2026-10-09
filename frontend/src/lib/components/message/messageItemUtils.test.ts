import { describe, expect, test } from 'bun:test';
import { isEncryptedAttachment, isEncryptedImageAttachment } from './messageItemUtils';

describe('isEncryptedAttachment', () => {
	test('recognises a dm-e2ee-v1 attachment with an IV', () => {
		expect(
			isEncryptedAttachment({
				attachmentEncryption: { scheme: 'dm-e2ee-v1', iv: 'abcd' }
			})
		).toBe(true);
	});

	test('ignores plaintext and incomplete metadata', () => {
		expect(isEncryptedAttachment({})).toBe(false);
		expect(isEncryptedAttachment({ attachmentEncryption: undefined })).toBe(false);
		expect(
			isEncryptedAttachment({
				// @ts-expect-error deliberately wrong scheme
				attachmentEncryption: { scheme: 'other', iv: 'abcd' }
			})
		).toBe(false);
		expect(
			isEncryptedAttachment({
				attachmentEncryption: { scheme: 'dm-e2ee-v1', iv: '' }
			})
		).toBe(false);
	});
});

describe('isEncryptedImageAttachment', () => {
	const base = { scheme: 'dm-e2ee-v1', iv: 'abcd' };

	test('is true only when the metadata MIME type is an image', () => {
		expect(
			isEncryptedImageAttachment({
				attachmentEncryption: { ...base, mimeType: 'image/png' }
			})
		).toBe(true);
		expect(
			isEncryptedImageAttachment({
				attachmentEncryption: { ...base, mimeType: 'IMAGE/JPEG' }
			})
		).toBe(true);
		expect(
			isEncryptedImageAttachment({
				attachmentEncryption: { ...base, mimeType: 'application/pdf' }
			})
		).toBe(false);
		expect(
			isEncryptedImageAttachment({
				attachmentEncryption: { ...base, mimeType: null }
			})
		).toBe(false);
		expect(
			isEncryptedImageAttachment({
				attachmentEncryption: { scheme: 'dm-e2ee-v1', iv: '', mimeType: 'image/png' }
			})
		).toBe(false);
		expect(isEncryptedImageAttachment({})).toBe(false);
		expect(
			isEncryptedImageAttachment({
				// Wrong scheme: the helper checks it even though any string
				// type-checks here.
				attachmentEncryption: { scheme: 'other', iv: 'abcd', mimeType: 'image/png' }
			})
		).toBe(false);
	});

	test('the extension of the stored name is irrelevant', () => {
		// Encrypted uploads are always stored as e2ee-<uuid>.wabi, so the
		// check must come from metadata, never from the file name.
		expect(
			isEncryptedImageAttachment({
				attachmentEncryption: { ...base, mimeType: 'image/webp' }
			})
		).toBe(true);
	});
});
