import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import type { WhiteboardViewport } from './boardTypes';
import type { ImageElement } from './elementTypes';
import { generateElementId } from './elementTypes';

export interface UploadedWhiteboardImage {
	fileUrl: string;
	fileName: string;
	fileSize: number;
	naturalWidth: number;
	naturalHeight: number;
}

async function readImageDimensions(src: string): Promise<{ width: number; height: number }> {
	const img = new Image();
	img.crossOrigin = 'anonymous';
	img.src = src;
	return await new Promise((resolve) => {
		img.onload = () => {
			resolve({
				width: img.naturalWidth || 300,
				height: img.naturalHeight || 200
			});
		};
		img.onerror = () => resolve({ width: 300, height: 200 });
		setTimeout(() => resolve({ width: 300, height: 200 }), 5000);
	});
}

export async function uploadWhiteboardImage(file: File): Promise<UploadedWhiteboardImage> {
	const formData = new FormData();
	formData.append('file', file, file.name);
	const token = getAuthToken();
	const headers: HeadersInit = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(`${getServerUrl()}/api/upload`, {
		method: 'POST',
		headers,
		body: formData
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(
			typeof payload?.error === 'string' && payload.error.trim().length > 0
				? payload.error
				: `Upload failed (${response.status})`
		);
	}

	const fileUrl =
		typeof payload?.fileUrl === 'string'
			? payload.fileUrl
			: typeof payload?.url === 'string'
				? payload.url
				: '';
	if (!fileUrl) {
		throw new Error('Upload did not return a file URL.');
	}

	const dims = await readImageDimensions(fileUrl);
	return {
		fileUrl,
		fileName:
			typeof payload?.fileName === 'string' && payload.fileName.trim().length > 0
				? payload.fileName
				: file.name,
		fileSize:
			typeof payload?.fileSize === 'number' && Number.isFinite(payload.fileSize)
				? payload.fileSize
				: file.size,
		naturalWidth: dims.width,
		naturalHeight: dims.height
	};
}

export function createWhiteboardImageElement(
	upload: UploadedWhiteboardImage,
	viewport: WhiteboardViewport,
	visibleWidth: number,
	visibleHeight: number,
	maxZ: number
): ImageElement {
	const maxDim = 480;
	const scale = Math.min(1, maxDim / Math.max(upload.naturalWidth, upload.naturalHeight));
	const width = Math.max(48, upload.naturalWidth * scale);
	const height = Math.max(48, upload.naturalHeight * scale);
	const centerX = viewport.x + visibleWidth / viewport.zoom / 2;
	const centerY = viewport.y + visibleHeight / viewport.zoom / 2;

	return {
		id: generateElementId(),
		type: 'image',
		x: centerX - width / 2,
		y: centerY - height / 2,
		width,
		height,
		rotation: 0,
		zIndex: maxZ + 1,
		opacity: 1,
		strokeColor: '#cbd5e1',
		strokeWidth: 0,
		fillColor: 'transparent',
		createdBy: '',
		updatedAt: Date.now(),
		locked: false,
		src: upload.fileUrl,
		naturalWidth: upload.naturalWidth,
		naturalHeight: upload.naturalHeight
	};
}
