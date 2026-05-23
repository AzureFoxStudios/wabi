import type { Emoji, User } from '$lib/socket';

export interface ProcessedText {
	text: string;
	blocked: boolean;
	reason?: string;
}

export interface SendBurstResult {
	allowed: boolean;
	updatedTimestamps: number[];
}

export function processOutgoingText(
	text: string,
	options: {
		writeUpperCaseEnabled: boolean;
		unicodeEmojisEnabled: boolean;
		emojis: Emoji[];
	}
): ProcessedText {
	let processed = text;
	if (options.writeUpperCaseEnabled) {
		processed = processed.charAt(0).toUpperCase() + processed.slice(1);
	}
	if (options.unicodeEmojisEnabled && options.emojis) {
		for (const emoji of options.emojis) {
			const pattern = new RegExp(`:${emoji.name}:`, 'g');
			processed = processed.replace(pattern, ((emoji as { unicode?: string }).unicode) || `:${emoji.name}:`);
		}
	}
	return { text: processed, blocked: false };
}

export function processAttachmentCaption(
	src: string,
	options: {
		maxLength: number;
		writeUpperCaseEnabled: boolean;
		unicodeEmojisEnabled: boolean;
		emojis: Emoji[];
	}
): string | null {
	if (!src.trim()) return '';
	let caption = src.trim();
	if (caption.length > options.maxLength) {
		caption = caption.slice(0, options.maxLength);
	}
	if (options.writeUpperCaseEnabled) {
		caption = caption.charAt(0).toUpperCase() + caption.slice(1);
	}
	if (options.unicodeEmojisEnabled && options.emojis) {
		for (const emoji of options.emojis) {
			const pattern = new RegExp(`:${emoji.name}:`, 'g');
			caption = caption.replace(pattern, ((emoji as { unicode?: string }).unicode) || `:${emoji.name}:`);
		}
	}
	return caption;
}

export function checkSendBurst(
	timestamps: number[],
	now: number,
	limit: number,
	windowMs: number
): SendBurstResult {
	const recent = timestamps.filter((t) => now - t < windowMs);
	if (recent.length >= limit) {
		return { allowed: false, updatedTimestamps: recent };
	}
	recent.push(now);
	return { allowed: true, updatedTimestamps: recent };
}

export function detectMessageKind(
	text: string,
	emojis: Emoji[]
): { type: 'text' } | { type: 'emoji'; emojiUrl?: string; emojiName?: string } {
	const trimmed = text.trim();
	const emojiMatch = trimmed.match(/^:(\w+):$/);
	if (emojiMatch) {
		const name = emojiMatch[1];
		const emoji = emojis.find((e) => e.name === name);
		if (emoji) {
			return { type: 'emoji', emojiUrl: emoji.url, emojiName: emoji.name };
		}
	}
	return { type: 'text' };
}

export function splitMessageForSending(text: string, chunkSize: number): string[] {
	if (text.length <= chunkSize) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= chunkSize) {
			chunks.push(remaining);
			break;
		}
		let splitAt = chunkSize;
		const lastSpace = remaining.lastIndexOf(' ', chunkSize);
		if (lastSpace > chunkSize * 0.5) {
			splitAt = lastSpace;
		}
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	return chunks;
}

export function splitEntitiesForChunks(
	fullText: string,
	chunks: string[],
	entities: Array<{ type: string; offset: number; length: number }>
): Array<Array<{ type: string; offset: number; length: number }>> {
	const result: Array<Array<{ type: string; offset: number; length: number }>> = [];
	let offset = 0;
	for (const chunk of chunks) {
		const chunkEnd = offset + chunk.length;
		const chunkEntities = entities
			.filter((e) => e.offset >= offset && e.offset + e.length <= chunkEnd)
			.map((e) => ({ ...e, offset: e.offset - offset }));
		result.push(chunkEntities);
		offset = chunkEnd + 1;
	}
	return result;
}

export function formatFileMb(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(2);
}

export function isAlbumEligibleFile(file: File): boolean {
	return file.type.startsWith('image/');
}

export function buildDefaultUploadAlbumName(channelName: string | undefined, messageInput: string): string {
	const base = channelName || 'upload';
	const snippet = messageInput.trim().slice(0, 40);
	return snippet ? `${base} - ${snippet}` : base;
}

export interface MediaAlbumScope {
	scopeType: string;
	scopeId: string | null;
}

export function getMediaAlbumScope(channel: { type: string; id: string } | undefined): MediaAlbumScope | null {
	if (!channel) return null;
	return {
		scopeType: channel.type === 'dm' ? 'dm' : 'channel',
		scopeId: channel.id
	};
}
