import type { FileAttachment, Message } from '$lib/socket';

export type MessageAttachmentActionItem = Pick<
	FileAttachment,
	'fileUrl' | 'fileName' | 'fileSize' | 'attachmentEncryption'
>;

export function getMessageAttachmentActionItems(message: Message): MessageAttachmentActionItem[] {
	const multi = (message.files || [])
		.filter((entry) => Boolean(entry?.fileUrl && entry?.fileName))
		.map((entry) => ({
			fileUrl: entry.fileUrl,
			fileName: entry.fileName,
			fileSize: typeof entry.fileSize === 'number' ? entry.fileSize : 0,
			attachmentEncryption: entry.attachmentEncryption
		}));
	if (multi.length > 0) return multi;
	if (!message.fileUrl || !message.fileName) return [];
	return [
		{
			fileUrl: message.fileUrl,
			fileName: message.fileName,
			fileSize: typeof message.fileSize === 'number' ? message.fileSize : 0,
			attachmentEncryption: message.attachmentEncryption
		}
	];
}

export function countMessageAttachments(message: Message | null): number {
	if (!message) return 0;
	if (Array.isArray(message.files) && message.files.length > 0) {
		return message.files.filter((entry) => Boolean(entry?.fileUrl)).length;
	}
	return message.fileUrl ? 1 : 0;
}

export function selectAttachmentActionItems(items: MessageAttachmentActionItem[]): MessageAttachmentActionItem[] | null {
	if (items.length <= 1) return items;
	const choices = items
		.map((item, index) => `${index + 1}. ${item.fileName}`)
		.slice(0, 20)
		.join('\n');
	const raw = prompt(
		`Select file to use:\n${choices}${items.length > 20 ? '\n...more files not listed' : ''}\n\nEnter a number (1-${items.length}) or "all".`,
		'all'
	);
	if (raw === null) return null;
	const value = raw.trim().toLowerCase();
	if (!value || value === 'all' || value === '*') return items;
	const index = Number.parseInt(value, 10);
	if (!Number.isInteger(index) || index < 1 || index > items.length) {
		alert(`Invalid selection. Enter a number between 1 and ${items.length}, or "all".`);
		return null;
	}
	return [items[index - 1]];
}

export type AlbumAddOutcome =
	/** Under experimental encryption: albums are server-readable. Nothing was sent. */
	| { status: 'blocked' }
	| { status: 'cancelled' }
	| { status: 'added'; count: number; albumName: string };

/**
 * "Add to album" for a message's attachments. The album index is server-readable: it stores the
 * attachment's file name and the message id. For a message or room under experimental
 * encryption (`keepOnDevice`, from privacy/contentEgress.ts) nothing is resolved or sent, and the
 * caller explains why (ALBUMS_SERVER_READABLE_HINT).
 */
export async function addMessageAttachmentsToAlbum(options: {
	keepOnDevice: boolean;
	messageId: string;
	items: MessageAttachmentActionItem[];
	resolveAlbum: () => Promise<{ id: number; name: string } | null>;
	addItem: (
		albumId: number,
		payload: { attachmentUrl: string; attachmentName: string; attachmentSize: number; messageId: string }
	) => Promise<unknown>;
}): Promise<AlbumAddOutcome> {
	if (options.keepOnDevice) return { status: 'blocked' };
	if (options.items.length === 0) return { status: 'cancelled' };
	const album = await options.resolveAlbum();
	if (!album) return { status: 'cancelled' };
	let count = 0;
	for (const item of options.items) {
		await options.addItem(album.id, {
			attachmentUrl: item.fileUrl,
			attachmentName: item.fileName,
			attachmentSize: item.fileSize,
			messageId: options.messageId
		});
		count += 1;
	}
	return { status: 'added', count, albumName: album.name };
}
