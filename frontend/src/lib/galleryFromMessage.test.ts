import { describe, expect, test } from 'bun:test';
import { addAttachmentsToGallery, galleryAttachmentItems, galleryFileFrom } from './galleryFromMessage';
import { serverReadableActionBlock } from './components/message/messageListGuards';
import { buildMessageMenu } from './components/messageContextMenuItems';

const item = (fileName: string, mimeType?: string) => ({
	fileUrl: `/uploads/${fileName}`,
	fileName,
	fileSize: 3,
	attachmentEncryption: mimeType ? { scheme: 'dm-e2ee-v1' as const, iv: 'iv', mimeType } : undefined
});

describe('Add to gallery: which attachments and files', () => {
	test('only media a gallery can show is offered', () => {
		const names = galleryAttachmentItems([item('a.png'), item('notes.zip'), item('clip.mp4')]).map((entry) => entry.fileName);
		expect(names).toEqual(['a.png', 'clip.mp4']);
	});

	test('a decrypted blob with no useful type keeps its name so the gallery can type it', () => {
		const file = galleryFileFrom(new Blob(['x'], { type: 'application/octet-stream' }), item('photo.jpg'));
		expect(file.name).toBe('photo.jpg');
		expect(file.type).toBe('');
		expect(galleryFileFrom(new Blob(['x']), item('photo.bin', 'image/webp')).type).toBe('image/webp');
	});

	test('uploads copies of what could be read and reports what could not', async () => {
		const sent: string[] = [];
		const result = await addAttachmentsToGallery({
			galleryChannelId: 'g1',
			galleryName: 'Site photos',
			items: [item('a.png'), item('b.png')],
			fetchAttachment: async (entry) => (entry.fileName === 'a.png' ? new Blob(['x'], { type: 'image/png' }) : null),
			upload: async (channelId, files) => {
				sent.push(channelId, ...files.map((file) => file.name));
				return { uploaded: files.length, errors: [], perFileErrors: [] };
			}
		});
		expect(sent).toEqual(['g1', 'a.png']);
		expect(result.uploaded).toBe(1);
		expect(result.perFileErrors.map((entry) => entry.fileName)).toEqual(['b.png']);
	});

	test('nothing is uploaded when nothing could be read', async () => {
		let called = false;
		const result = await addAttachmentsToGallery({
			galleryChannelId: 'g1',
			items: [item('a.png')],
			fetchAttachment: async () => { throw new Error('decrypt failed'); },
			upload: async () => { called = true; return { uploaded: 0, errors: [], perFileErrors: [] }; }
		});
		expect(called).toBe(false);
		expect(result.uploaded).toBe(0);
		expect(result.errors.length).toBe(1);
	});
});

describe('Add to gallery: the privacy gate', () => {
	const reasons = ['experimental-encryption', 'encryption-pending', 'checking', 'status-unavailable'] as const;

	test('kept content is blocked by default, and the hint names the setting', () => {
		for (const reason of reasons) {
			const hint = serverReadableActionBlock('gallery', { text: 'hi' }, reason);
			expect(hint).toContain('Galleries are server-readable');
			expect(hint).toContain('Add to gallery from private conversations');
		}
	});

	test('the setting lifts the block for every reason, and for the gallery action only', () => {
		for (const reason of reasons) {
			expect(serverReadableActionBlock('gallery', { text: 'hi' }, reason, true)).toBeNull();
			expect(serverReadableActionBlock('album', { text: 'hi' }, reason, true)).not.toBeNull();
			expect(serverReadableActionBlock('forward', { text: 'hi' }, reason, true)).not.toBeNull();
		}
	});

	test('a server-readable room needs no setting', () => {
		expect(serverReadableActionBlock('gallery', { text: 'hi' }, null)).toBeNull();
	});
});

describe('Add to gallery: the message menu row', () => {
	const noop = () => {};
	const menu = (extra: Record<string, unknown>) =>
		buildMessageMenu({
			t: (key) => key, isOwn: true, canEdit: true, canDelete: true, hasFile: true, canCopyText: false,
			isPinned: false, isPersonalPinned: false, translatorEnabled: false, quickMentionEnabled: false,
			personalPinsEnabled: false, onReply: noop, onCopyText: noop, onEdit: noop, onPin: noop, onDelete: noop,
			...extra
		} as Parameters<typeof buildMessageMenu>[0]).find((entry) => entry.id === 'add-to-gallery') as
			| { disabled?: boolean; hint?: string }
			| undefined;

	test('absent without gallery media, enabled in a server-readable room', () => {
		expect(menu({})).toBeUndefined();
		expect(menu({ onAddToGallery: noop })?.disabled).toBeFalsy();
	});

	test('disabled with the reason in a private conversation, enabled once the setting is on', () => {
		const off = menu({ onAddToGallery: noop, keepReason: 'experimental-encryption' });
		expect(off?.disabled).toBe(true);
		expect(off?.hint).toContain('Add to gallery from private conversations');
		expect(menu({ onAddToGallery: noop, keepReason: 'experimental-encryption', privateMediaToGallery: true })?.disabled).toBeFalsy();
	});
});
