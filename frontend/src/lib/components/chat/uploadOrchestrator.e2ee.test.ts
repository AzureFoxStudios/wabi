import { beforeEach, describe, expect, mock, test } from 'bun:test';

let encryptCalls = 0;
let uploadedNames: string[] = [];

mock.module('$lib/e2ee', () => ({
	encryptAttachmentForChannel: async (_channelId: string, file: File) => {
		encryptCalls += 1;
		return {
			file: new File(['ciphertext'], 'opaque.wabi', { type: 'application/octet-stream' }),
			metadata: {
				scheme: 'dm-e2ee-v1', iv: 'iv', mimeType: file.type, originalSize: file.size,
				epoch: 1, chunkSize: 1024, noncePrefix: 'nonce', fileId: 'file-1'
			}
		};
	}
}));
mock.module('$lib/api', () => ({
	createMediaAlbum: async () => ({ id: 1, name: 'Album' }),
	addMediaAlbumItem: async () => {}
}));
mock.module('$lib/i18n', () => ({ _: { subscribe: () => () => {} } }));
mock.module('./uploadResumable', () => ({
	uploadFileResumable: async (file: File) => {
		uploadedNames.push(file.name);
		return { fileUrl: '/uploads/test', attachmentStorage: undefined };
	}
}));

const { orchestrateUpload } = await import('./uploadOrchestrator');

function context(channelType: string) {
	return {
		files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })],
		channelId: 'ch_test',
		channelType,
		dmChannelId: undefined,
		dmOtherDbUserId: null,
		authToken: null,
		messageInput: '',
		replyToId: undefined,
		markAsSpoiler: false,
		captionEntities: [],
		createAlbum: false,
		albumName: '',
		albumScopeType: null,
		albumScopeId: null,
		targetAlbumId: null,
		getCompressionMetadata: () => undefined,
		onProgress: () => {}
	};
}

describe('upload E2EE boundary', () => {
	beforeEach(() => {
		encryptCalls = 0;
		uploadedNames = [];
	});

	test('shared-channel upload never probes or encrypts through private-room E2EE', async () => {
		const result = await orchestrateUpload(context('text'));
		expect(encryptCalls).toBe(0);
		expect(uploadedNames).toEqual(['hello.txt']);
		expect(result.options.attachmentEncryption).toBeUndefined();
	});

	test('DM upload still encrypts before upload', async () => {
		const result = await orchestrateUpload(context('dm'));
		expect(encryptCalls).toBe(1);
		expect(uploadedNames).toEqual(['opaque.wabi']);
		expect(result.options.attachmentEncryption).toBeTruthy();
	});

	test('private group upload still encrypts before upload', async () => {
		await orchestrateUpload(context('group'));
		expect(encryptCalls).toBe(1);
		expect(uploadedNames).toEqual(['opaque.wabi']);
	});
});
