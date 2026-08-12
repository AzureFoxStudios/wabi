export type MessageMediaType = 'image' | 'video' | 'audio' | 'model';

const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];
const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'm4v'];
const audioExtensions = ['mp3', 'wav', 'ogg', 'weba', 'flac', 'm4a', 'aac', 'wma'];
const modelExtensions = ['glb', 'gltf', 'obj', 'stl'];

function getExtension(fileName?: string): string {
	if (!fileName) return '';
	return fileName.toLowerCase().split('.').pop() || '';
}

export function extractUrls(text: string): string[] {
	const urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
	const matches = text.match(urlRegex);
	return matches || [];
}

export function getMediaType(url: string): MessageMediaType | null {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname.toLowerCase();

		if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(pathname)) return 'image';
		if (/\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)(\?|#|$)/i.test(pathname)) return 'video';
		if (/\.(mp3|wav|ogg|weba|webm|m4a|flac|aac|wma)(\?|#|$)/i.test(pathname)) return 'audio';
		if (/\.(glb|gltf|obj|stl)(\?|#|$)/i.test(pathname)) return 'model';
	} catch {
		// Invalid URL
	}
	return null;
}

export function isMediaUrl(url: string): boolean {
	return getMediaType(url) !== null;
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

export function getFileIcon(fileName?: string): string {
	const ext = getExtension(fileName);
	if (!ext) return '📎';
	const iconMap: Record<string, string> = {
		jpg: '🖼️',
		jpeg: '🖼️',
		png: '🖼️',
		gif: '🖼️',
		bmp: '🖼️',
		svg: '🖼️',
		webp: '🖼️',
		mp4: '🎬',
		mov: '🎬',
		avi: '🎬',
		mkv: '🎬',
		webm: '🎬',
		flv: '🎬',
		mp3: '🎵',
		wav: '🎵',
		ogg: '🎵',
		flac: '🎵',
		pdf: '📄',
		doc: '📝',
		docx: '📝',
		txt: '📝',
		rtf: '📝',
		xls: '📊',
		xlsx: '📊',
		csv: '📊',
		ppt: '📽️',
		pptx: '📽️',
		zip: '📦',
		rar: '📦',
		'7z': '📦',
		tar: '📦',
		gz: '📦',
		js: '💻',
		ts: '💻',
		py: '💻',
		java: '💻',
		cpp: '💻',
		c: '💻',
		cs: '💻',
		html: '💻',
		css: '💻',
		json: '💻',
		blend: '🎨',
		fbx: '🎨',
		obj: '🎨',
		stl: '🎨',
		psd: '🎨',
		ai: '🎨',
		sketch: '🎨'
	};
	return iconMap[ext] || '📎';
}

export function isImage(fileName?: string): boolean {
	return imageExtensions.includes(getExtension(fileName));
}

export function isVideo(fileName?: string): boolean {
	return videoExtensions.includes(getExtension(fileName));
}

export function isAudio(fileName?: string): boolean {
	return audioExtensions.includes(getExtension(fileName));
}

export function isModelFile(fileName?: string): boolean {
	return modelExtensions.includes(getExtension(fileName));
}

export function isBlendFile(fileName?: string): boolean {
	return Boolean(fileName?.toLowerCase().endsWith('.blend'));
}

export function isZipFile(fileName?: string): boolean {
	return Boolean(fileName?.toLowerCase().endsWith('.zip'));
}
