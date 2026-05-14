import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import type { WhiteboardViewport } from './boardTypes';
import type { ImageElement } from './elementTypes';
import { generateElementId } from './elementTypes';

export interface UploadedWhiteboardImage {
	fileId: string;
	fileUrl: string;
	fileName: string;
	fileSize: number;
	mimeType: string;
	naturalWidth: number;
	naturalHeight: number;
}

async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
	const objectUrl = URL.createObjectURL(file);
	const img = new Image();
	img.src = objectUrl;
	return await new Promise((resolve) => {
		img.onload = () => {
			URL.revokeObjectURL(objectUrl);
			resolve({
				width: img.naturalWidth || 300,
				height: img.naturalHeight || 200
			});
		};
		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			resolve({ width: 300, height: 200 });
		};
		setTimeout(() => {
			URL.revokeObjectURL(objectUrl);
			resolve({ width: 300, height: 200 });
		}, 5000);
	});
}

export async function uploadWhiteboardImage(boardId: string, file: File): Promise<UploadedWhiteboardImage> {
	const formData = new FormData();
	formData.append('file', file, file.name);
	const token = getAuthToken();
	const sessionId = token ? null : getGuestSessionId();
	const headers: HeadersInit = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (!token && sessionId) {
		headers['X-Session-Id'] = sessionId;
	}

	const response = await fetch(
		`${getServerUrl()}/api/whiteboard/boards/${encodeURIComponent(boardId)}/images`,
		{
		method: 'POST',
		headers,
		body: formData
		}
	);
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

	const dims = await readImageDimensions(file);
	return {
		fileId:
			typeof payload?.fileId === 'string' && payload.fileId.trim().length > 0
				? payload.fileId
				: '',
		fileUrl,
		fileName:
			typeof payload?.fileName === 'string' && payload.fileName.trim().length > 0
				? payload.fileName
				: file.name,
		fileSize:
			typeof payload?.fileSize === 'number' && Number.isFinite(payload.fileSize)
				? payload.fileSize
				: file.size,
		mimeType:
			typeof payload?.mimeType === 'string' && payload.mimeType.trim().length > 0
				? payload.mimeType
				: file.type || 'application/octet-stream',
		naturalWidth: dims.width,
		naturalHeight: dims.height
	};
}

export function createWhiteboardImageElement(
	upload: UploadedWhiteboardImage,
	viewport: WhiteboardViewport,
	visibleWidth: number,
	visibleHeight: number,
	maxZ: number,
	layerId = ''
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
		layerId,
		opacity: 1,
		strokeColor: '#cbd5e1',
		strokeWidth: 0,
		fillColor: 'transparent',
		createdBy: '',
		updatedAt: Date.now(),
		locked: false,
		src: upload.fileUrl,
		assetId: upload.fileId,
		fileName: upload.fileName,
		mimeType: upload.mimeType,
		naturalWidth: upload.naturalWidth,
		naturalHeight: upload.naturalHeight
	};
}
