import { getServerUrl } from '$lib/serverUrl';

export interface UploadedAlbumFile {
	fileUrl: string;
	fileName: string;
	fileSize: number;
}

export async function uploadAlbumFile(token: string, file: File): Promise<UploadedAlbumFile> {
	const formData = new FormData();
	formData.append('file', file, file.name);

	const response = await fetch(`${getServerUrl()}/api/upload`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`
		},
		body: formData
	});

	if (!response.ok) {
		let detail = '';
		try {
			const payload = await response.json();
			detail = payload?.error || '';
		} catch {
			detail = await response.text();
		}
		throw new Error(detail || `Upload failed (${response.status})`);
	}

	const payload = await response.json();
	const fileUrl = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
	if (!fileUrl) {
		throw new Error('Upload did not return a file URL.');
	}

	return {
		fileUrl,
		fileName: typeof payload?.fileName === 'string' ? payload.fileName : file.name,
		fileSize:
			typeof payload?.fileSize === 'number' && Number.isFinite(payload.fileSize)
				? payload.fileSize
				: file.size
	};
}
