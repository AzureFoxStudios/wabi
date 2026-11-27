/**
 * "Add to gallery" for a message's attachments.
 *
 * The media is fetched (and decrypted on this device when it arrived encrypted), then uploaded to
 * the gallery as a new copy. The gallery never points at the conversation's own file, so a
 * private conversation's storage is not exposed and the copy does not depend on the message.
 */
import type { GalleryUploadResult } from './galleryStore';
import { guessGalleryMediaKind } from './galleryFilter';
import type { MessageAttachmentActionItem } from './components/message/messageAttachmentActions';

export type FetchAttachment = (item: MessageAttachmentActionItem) => Promise<Blob | null>;

/** The attachments a gallery can show (images, video and the other kinds it lists). */
export function galleryAttachmentItems(items: MessageAttachmentActionItem[]): MessageAttachmentActionItem[] {
	return items.filter((item) => guessGalleryMediaKind(item.attachmentEncryption?.mimeType ?? null, item.fileName) !== 'unknown');
}

/**
 * A `File` for the gallery upload. A decrypted or proxied blob often has no useful type; an empty
 * type lets the gallery resolve it from the file name instead of rejecting the file.
 */
export function galleryFileFrom(blob: Blob, item: MessageAttachmentActionItem): File {
	const declared = (item.attachmentEncryption?.mimeType || blob.type || '').trim().toLowerCase();
	const type = declared === 'application/octet-stream' ? '' : declared;
	return new File([blob], item.fileName, { type });
}

export async function addAttachmentsToGallery(options: {
	galleryChannelId: string;
	galleryName?: string;
	items: MessageAttachmentActionItem[];
	fetchAttachment: FetchAttachment;
	/** Injected in tests; the real one uploads through a gallery workspace of its own. */
	upload?: (channelId: string, files: File[], channelName?: string) => Promise<GalleryUploadResult>;
}): Promise<GalleryUploadResult> {
	const files: File[] = [];
	const unreadable: string[] = [];
	for (const item of options.items) {
		let blob: Blob | null = null;
		try {
			blob = await options.fetchAttachment(item);
		} catch {
			blob = null;
		}
		if (blob) files.push(galleryFileFrom(blob, item));
		else unreadable.push(item.fileName);
	}
	const failures = unreadable.map((fileName) => ({ fileName, message: 'Could not be read on this device' }));
	if (files.length === 0) {
		return { uploaded: 0, errors: failures.map((entry) => `${entry.fileName}: ${entry.message}`), perFileErrors: failures };
	}
	let result: GalleryUploadResult;
	if (options.upload) {
		result = await options.upload(options.galleryChannelId, files, options.galleryName);
	} else {
		// A workspace of its own: the shared one refuses an upload while it shows another gallery.
		// Loaded on use: the gallery store pulls in the app's stores, which this module's callers
		// (the message menu) do not need just to decide whether to show the row.
		const { createGalleryWorkspace } = await import('./galleryStore');
		const workspace = createGalleryWorkspace();
		try {
			result = await workspace.uploadGalleryImages(options.galleryChannelId, files, options.galleryName);
		} finally {
			workspace.dispose();
		}
	}
	return {
		uploaded: result.uploaded,
		errors: [...result.errors, ...failures.map((entry) => `${entry.fileName}: ${entry.message}`)],
		perFileErrors: [...result.perFileErrors, ...failures]
	};
}
