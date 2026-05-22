import type { Emoji } from '$lib/socket';

export interface FilePreview {
	file: File;
	preview: string;
}

export function buildPreviewEntries(files: File[]): FilePreview[] {
	return files.map((file) => ({
		file,
		preview: URL.createObjectURL(file)
	}));
}

export function revokePreviewUrl(url: string): void {
	if (url) {
		try {
			URL.revokeObjectURL(url);
		} catch {
			// no-op
		}
	}
}

export function enforcePreviewBudget(
	previews: FilePreview[],
	files: File[],
	maxImages: number
): { previews: FilePreview[]; files: File[] } {
	const imagePreviews = previews.filter((p) => p.file.type.startsWith('image/'));
	const nonImagePreviews = previews.filter((p) => !p.file.type.startsWith('image/'));
	if (imagePreviews.length > maxImages) {
		const excess = imagePreviews.slice(maxImages);
		for (const item of excess) {
			revokePreviewUrl(item.preview);
		}
		return {
			previews: [...imagePreviews.slice(0, maxImages), ...nonImagePreviews],
			files: [...imagePreviews.slice(0, maxImages), ...nonImagePreviews].map((p) => p.file)
		};
	}
	return { previews, files };
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
