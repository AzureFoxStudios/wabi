import type { Message } from '$lib/socket';
import { get } from 'svelte/store';
import { _ } from '$lib/i18n';

export type AlbumAnnouncement = { name: string; kind: 'opened' | 'shared' };

export function parseAlbumAnnouncement(text?: string): AlbumAnnouncement | null {
	const normalized = text?.trim();
	if (!normalized) return null;
	const openedMatch = normalized.match(/^Opened album "(.+?)"/i);
	if (openedMatch?.[1]) return { name: openedMatch[1], kind: 'opened' };
	const sharedMatch = normalized.match(/^Shared \d+ photos in album "(.+?)"/i);
	if (sharedMatch?.[1]) return { name: sharedMatch[1], kind: 'shared' };
	return null;
}

export function isLocalDirectionsMessage(message: Message): boolean {
	return message.userId === 'local-directions' && message.localCard?.kind === 'directions';
}

export function getDirectionsMeta(message: Message) {
	return message.localCard?.kind === 'directions' ? message.localCard : null;
}

export function formatDirectionsExpiry(expiresAt?: number): string {
	if (!expiresAt) return 'Temporary';
	const remainingMs = Math.max(0, expiresAt - Date.now());
	const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
	return `Temporary | expires in ${remainingMinutes} min`;
}

export function parseRoleGateText(text: string): { title: string; description: string } {
	const normalized = (text || '').trim();
	if (!normalized) return { title: get(_)('messages.role_gate.title'), description: '' };
	const [firstLine, ...rest] = normalized.split('\n');
	return {
		title: firstLine.trim() || get(_)('messages.role_gate.title'),
		description: rest.join('\n').trim()
	};
}

export function isImage(fileName?: string): boolean {
	if (!fileName) return false;
	const ext = fileName.toLowerCase().split('.').pop() || '';
	return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext);
}

export function isVideo(fileName?: string): boolean {
	if (!fileName) return false;
	const ext = fileName.toLowerCase().split('.').pop() || '';
	return ['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'm4v'].includes(ext);
}

export function isAudio(fileName?: string): boolean {
	if (!fileName) return false;
	const ext = fileName.toLowerCase().split('.').pop() || '';
	return ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'].includes(ext);
}

export function getMediaMimeType(fileName?: string): string | null {
	if (!fileName) return null;
	const ext = fileName.toLowerCase().split('.').pop() || '';
	const mimeByExtension: Record<string, string> = {
		mp3: 'audio/mpeg',
		wav: 'audio/wav',
		ogg: 'audio/ogg',
		flac: 'audio/flac',
		m4a: 'audio/mp4',
		aac: 'audio/aac',
		wma: 'audio/x-ms-wma',
		mp4: 'video/mp4',
		webm: 'video/webm',
		mov: 'video/quicktime',
		avi: 'video/x-msvideo',
		mkv: 'video/x-matroska',
		flv: 'video/x-flv',
		wmv: 'video/x-ms-wmv',
		m4v: 'video/x-m4v'
	};
	return mimeByExtension[ext] || null;
}

export function isModelFile(fileName?: string): boolean {
	if (!fileName) return false;
	const ext = fileName.toLowerCase().split('.').pop() || '';
	return ['glb', 'gltf', 'obj', 'stl'].includes(ext);
}

export function isBlendFile(fileName?: string): boolean {
	return Boolean(fileName?.toLowerCase().endsWith('.blend'));
}

export function isZipFile(fileName?: string): boolean {
	return Boolean(fileName?.toLowerCase().endsWith('.zip'));
}

export function isEncryptedAttachment(attachment: { attachmentEncryption?: { scheme: 'dm-e2ee-v1'; iv: string } }): boolean {
	return attachment?.attachmentEncryption?.scheme === 'dm-e2ee-v1' && !!attachment?.attachmentEncryption?.iv;
}

export function getFileIcon(fileName?: string): string {
	if (!fileName) return '📎';
	const ext = fileName.toLowerCase().split('.').pop() || '';
	const iconMap: Record<string, string> = {
		jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', svg: '🖼️', webp: '🖼️',
		mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬', flv: '🎬',
		mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
		pdf: '📄', doc: '📝', docx: '📝', txt: '📝', rtf: '📝',
		xls: '📊', xlsx: '📊', csv: '📊',
		ppt: '📽️', pptx: '📽️',
		zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
		js: '💻', ts: '💻', py: '💻', java: '💻', cpp: '💻', c: '💻', cs: '💻', html: '💻', css: '💻', json: '💻',
		blend: '🎨', fbx: '🎨', obj: '🎨', stl: '🎨', psd: '🎨', ai: '🎨', sketch: '🎨'
	};
	return iconMap[ext] || '📎';
}

export function formatFileSize(bytes?: number): string {
	if (!bytes) return '';
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function getMediaType(url: string): 'image' | 'video' | 'audio' | 'model' | null {
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(pathname)) return 'image';
		if (/\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)(\?|#|$)/i.test(pathname)) return 'video';
		if (/\.(mp3|wav|ogg|m4a|flac|aac|wma)(\?|#|$)/i.test(pathname)) return 'audio';
		if (/\.(glb|gltf|obj|stl)(\?|#|$)/i.test(pathname)) return 'model';
	} catch {
		return null;
	}
	return null;
}

export function isYouTubeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		return hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be';
	} catch {
		return false;
	}
}

export function extractUrls(text: string): string[] {
	return text.match(/(https?:\/\/[^\s<>"]+)/gi) || [];
}
