import type { Channel } from '$lib/socket';
import type { MediaAlbumScopeType } from '$lib/api';
import type { FilePreview } from './types';

export function revokePreviewUrl(preview?: string): void {
	if (!preview || !preview.startsWith('blob:')) return;
	URL.revokeObjectURL(preview);
}

export function buildPreviewEntries(files: File[]): FilePreview[] {
	return files.map((file) => {
		if (file.type.startsWith('image/')) {
			return { file, preview: URL.createObjectURL(file) };
		}
		return { file };
	});
}

export function enforcePreviewBudget(
	previews: FilePreview[],
	files: File[],
	max: number
): { previews: FilePreview[]; files: File[] } {
	if (previews.length <= max) return { previews, files };
	const overflow = previews.slice(0, previews.length - max);
	for (const item of overflow) revokePreviewUrl(item.preview);
	return { previews: previews.slice(-max), files: files.slice(-max) };
}

export function formatFileMb(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

export function isAlbumEligibleFile(file: File): boolean {
	return file.type.startsWith('image/');
}

export function getMediaAlbumScope(
	channel: Channel | undefined
): { scopeType: MediaAlbumScopeType; scopeId: string } | null {
	if (!channel?.id) return null;
	const scopeType: MediaAlbumScopeType =
		channel.type === 'dm' || channel.type === 'group' ? 'dm' : 'channel';
	return { scopeType, scopeId: channel.id };
}

export function buildDefaultUploadAlbumName(
	channelDisplayName: string,
	messageInput: string
): string {
	const trimmed = messageInput.trim();
	if (trimmed) return trimmed.slice(0, 60);
	const label = channelDisplayName?.trim() || 'Album';
	const stamp = new Date().toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
	return `${label} ${stamp}`;
}
