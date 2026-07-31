import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';

export type UploadVideoCompressionMetadata = {
	scheme: 'wabi-video-compression-v1';
	runtime: string;
	preset: string;
	originalSize: number;
	compressedSize: number;
	codec: 'vp9' | 'vp8' | 'h264' | 'hevc' | 'av1' | 'unknown';
	mimeType: string;
	durationMs: number;
	estimatedOutputBytes?: number;
};

export type AttachmentStorageMetadata = {
	scheme: 'wabi-storage-v1';
	compressed: boolean;
	codec: 'identity' | 'gzip';
	originalSize: number;
	storedSize: number;
	atRestEncrypted: boolean;
};

export type UploadFileResumableResult = {
	fileUrl: string;
	fileName: string;
	fileSize: number;
	attachmentStorage?: AttachmentStorageMetadata;
};

const RESUMABLE_UPLOAD_CHUNK_SIZE = 1024 * 1024;
const RESUMABLE_UPLOAD_MAX_RETRIES = 4;

function getUploadAuthHeaders(includeJsonContentType = false): Record<string, string> {
	const headers: Record<string, string> = {};
	if (includeJsonContentType) {
		headers['Content-Type'] = 'application/json';
	}
	const authToken = getAuthToken();
	if (authToken) {
		headers['Authorization'] = `Bearer ${authToken}`;
		return headers;
	}
	const sessionId = getGuestSessionId();
	if (sessionId) {
		headers['X-Session-Id'] = sessionId;
	}
	return headers;
}

function getResumeStorageKey(channelId: string, file: File): string {
	return `upload-resume:${channelId}:${file.name}:${file.size}:${file.lastModified}`;
}

export async function uploadFileResumable(
	file: File,
	channelId: string,
	onProgress: (fileProgressPercent: number) => void,
	allowPersistentResume = true,
	videoCompression?: UploadVideoCompressionMetadata
): Promise<UploadFileResumableResult> {
	const serverUrl = getServerUrl();
	const resumeKey = getResumeStorageKey(channelId, file);
	const previousUploadId = allowPersistentResume ? localStorage.getItem(resumeKey) || undefined : undefined;

	const initResponse = await fetch(`${serverUrl}/api/upload/resumable/init`, {
		method: 'POST',
		headers: getUploadAuthHeaders(true),
		credentials: 'include',
		body: JSON.stringify({
			uploadId: previousUploadId,
			fileName: file.name,
			fileSize: file.size,
			mimeType: file.type || 'application/octet-stream',
			channelId,
			videoCompression: videoCompression || null
		})
	});
	if (!initResponse.ok) {
		throw new Error(`Resumable init failed (${initResponse.status})`);
	}

	const initResult = await initResponse.json();
	const uploadId = initResult.uploadId as string;
	let uploadToken = initResult.uploadToken as string;
	if (allowPersistentResume) {
		localStorage.setItem(resumeKey, uploadId);
	}

	if (initResult.completed && initResult.fileUrl) {
		if (allowPersistentResume) localStorage.removeItem(resumeKey);
		return {
			fileUrl: initResult.fileUrl as string,
			fileName: file.name,
			fileSize: file.size,
			attachmentStorage: initResult.attachmentStorage as AttachmentStorageMetadata | undefined
		};
	}

	let uploadedBytes = Number(initResult.uploadedBytes || 0);
	onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);

	while (uploadedBytes < file.size) {
		const chunkEnd = Math.min(uploadedBytes + RESUMABLE_UPLOAD_CHUNK_SIZE, file.size);
		const chunkBlob = file.slice(uploadedBytes, chunkEnd);

		let uploadedThisChunk = false;
		let attempt = 0;
		while (!uploadedThisChunk && attempt < RESUMABLE_UPLOAD_MAX_RETRIES) {
			attempt++;
			try {
				const chunkResponse = await fetch(
					`${serverUrl}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(uploadId)}&offset=${uploadedBytes}`,
					{
						method: 'PUT',
						headers: {
							...getUploadAuthHeaders(),
							'x-upload-token': uploadToken
						},
						credentials: 'include',
						body: chunkBlob
					}
				);
				if (chunkResponse.status === 403) {
					const refreshResponse = await fetch(`${serverUrl}/api/upload/resumable/init`, {
						method: 'POST',
						headers: getUploadAuthHeaders(true),
						credentials: 'include',
						body: JSON.stringify({
							uploadId,
							fileName: file.name,
							fileSize: file.size,
							mimeType: file.type || 'application/octet-stream',
							channelId,
							videoCompression: videoCompression || null
						})
					});
					if (!refreshResponse.ok) {
						throw new Error(`Upload token refresh failed (${refreshResponse.status})`);
					}
					const refresh = await refreshResponse.json();
					uploadToken = refresh.uploadToken as string;
					uploadedBytes = Number(refresh.uploadedBytes || uploadedBytes);
					onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);
					uploadedThisChunk = true;
					break;
				}

				if (chunkResponse.status === 409) {
					const conflict = await chunkResponse.json();
					const expectedOffset = Number(conflict.expectedOffset);
					if (Number.isFinite(expectedOffset) && expectedOffset >= 0) {
						uploadedBytes = expectedOffset;
						if (conflict.uploadToken) {
							uploadToken = conflict.uploadToken as string;
						}
						onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);
						uploadedThisChunk = true;
						break;
					}
				}

				if (!chunkResponse.ok) {
					throw new Error(`Chunk upload failed (${chunkResponse.status})`);
				}

				const chunkResult = await chunkResponse.json();
				uploadedBytes = Number(chunkResult.uploadedBytes || uploadedBytes);
				if (chunkResult.uploadToken) {
					uploadToken = chunkResult.uploadToken as string;
				}
				onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);
				uploadedThisChunk = true;
			} catch (error) {
				if (attempt >= RESUMABLE_UPLOAD_MAX_RETRIES) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, attempt * 400));
			}
		}
	}

	const completeResponse = await fetch(`${serverUrl}/api/upload/resumable/complete`, {
		method: 'POST',
		headers: getUploadAuthHeaders(true),
		credentials: 'include',
		body: JSON.stringify({ uploadId, uploadToken })
	});
	if (!completeResponse.ok) {
		throw new Error(`Resumable complete failed (${completeResponse.status})`);
	}

	const completeResult = await completeResponse.json();
	if (allowPersistentResume) localStorage.removeItem(resumeKey);

	return {
		fileUrl: completeResult.fileUrl as string,
		fileName: file.name,
		fileSize: file.size,
		attachmentStorage: completeResult.attachmentStorage as AttachmentStorageMetadata | undefined
	};
}
