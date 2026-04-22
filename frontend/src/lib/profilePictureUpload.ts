import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';

const PROFILE_PICTURE_FETCH_TIMEOUT_MS = 10000;
const PROFILE_PICTURE_UPLOAD_TIMEOUT_MS = 10000;

function resolveProfilePictureSourceUrl(rawUrl: string, sourceServerUrl?: string | null): string {
	const trimmed = rawUrl.trim();
	if (!trimmed) {
		throw new Error('No profile picture URL is available to import.');
	}

	try {
		return new URL(trimmed).toString();
	} catch {
		// Fall back to resolving server-relative uploads against the source server.
	}

	const trimmedServerUrl = (sourceServerUrl || '').trim();
	if (!trimmedServerUrl) {
		throw new Error('Cannot resolve the source server for that profile picture.');
	}

	try {
		return new URL(trimmed, `${trimmedServerUrl.replace(/\/+$/, '')}/`).toString();
	} catch {
		throw new Error('Profile picture URL is invalid.');
	}
}

function inferFileExtension(contentType: string): string {
	const normalized = contentType.trim().toLowerCase();
	if (normalized === 'image/jpeg') return 'jpg';
	if (normalized === 'image/png') return 'png';
	if (normalized === 'image/gif') return 'gif';
	if (normalized === 'image/webp') return 'webp';
	if (normalized === 'image/svg+xml') return 'svg';
	if (normalized === 'image/bmp') return 'bmp';
	if (normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon') return 'ico';
	const match = normalized.match(/^image\/([a-z0-9.+-]+)$/);
	if (!match) return 'png';
	return match[1].replace(/[^a-z0-9]+/g, '') || 'png';
}

function sanitizeFileNameSegment(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function inferProfilePictureFileName(sourceUrl: string, contentType: string): string {
	let parsed: URL | null = null;
	try {
		parsed = new URL(sourceUrl);
	} catch {
		parsed = null;
	}

	const lastSegment = sanitizeFileNameSegment(parsed?.pathname.split('/').pop() || '');
	if (lastSegment && /\.[a-z0-9]{2,8}$/i.test(lastSegment)) {
		return lastSegment;
	}

	const extension = inferFileExtension(contentType);
	if (lastSegment) {
		return `${lastSegment}.${extension}`;
	}

	return `profile-picture.${extension}`;
}

async function fetchBlobWithTimeout(url: string): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = window.setTimeout(() => controller.abort(), PROFILE_PICTURE_FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, {
			mode: 'cors',
			signal: controller.signal
		});
	} finally {
		window.clearTimeout(timeoutId);
	}
}

async function fetchRemoteProfilePictureBlob(sourceUrl: string): Promise<Blob> {
	const directResponse = await fetchBlobWithTimeout(sourceUrl);
	if (!directResponse.ok) {
		throw new Error(`Failed to fetch source profile picture (${directResponse.status}).`);
	}

	const contentType = (directResponse.headers.get('content-type') || '').toLowerCase();
	if (!contentType.startsWith('image/')) {
		throw new Error('Source profile picture is not an image.');
	}

	return await directResponse.blob();
}

async function fetchProfilePictureBlobViaProxy(sourceUrl: string): Promise<Blob> {
	const serverUrl = getServerUrl();
	const proxyUrl = `${serverUrl}/api/image-proxy?url=${encodeURIComponent(sourceUrl)}`;
	const response = await fetchBlobWithTimeout(proxyUrl);
	const payload = await response
		.clone()
		.json()
		.catch(() => null);

	if (!response.ok) {
		throw new Error(
			typeof payload?.error === 'string' && payload.error.trim().length > 0
				? payload.error
				: `Failed to proxy source profile picture (${response.status}).`
		);
	}

	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	if (!contentType.startsWith('image/')) {
		throw new Error('Profile picture proxy returned a non-image response.');
	}

	return await response.blob();
}

export async function uploadProfilePictureFile(file: File): Promise<string> {
	const token = getAuthToken();
	if (!token) {
		throw new Error('You must be signed in to update your profile picture.');
	}

	const serverUrl = getServerUrl();
	const formData = new FormData();
	formData.append('profilePicture', file, file.name || 'profile-picture.png');

	const controller = new AbortController();
	const timeoutId = window.setTimeout(() => controller.abort(), PROFILE_PICTURE_UPLOAD_TIMEOUT_MS);
	try {
		const response = await fetch(`${serverUrl}/api/upload-profile-picture`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`
			},
			body: formData,
			signal: controller.signal
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(
				typeof payload?.error === 'string' && payload.error.trim().length > 0
					? payload.error
					: `Profile picture upload failed (${response.status}).`
			);
		}

		const profilePictureUrl =
			typeof payload?.profilePictureUrl === 'string' ? payload.profilePictureUrl.trim() : '';
		if (!profilePictureUrl) {
			throw new Error('Upload did not return a profile picture URL.');
		}

		return profilePictureUrl;
	} finally {
		window.clearTimeout(timeoutId);
	}
}

export async function importProfilePictureToCurrentServer(
	sourceProfilePictureUrl: string,
	sourceServerUrl?: string | null
): Promise<string> {
	const resolvedSourceUrl = resolveProfilePictureSourceUrl(sourceProfilePictureUrl, sourceServerUrl);

	let blob: Blob;
	try {
		blob = await fetchRemoteProfilePictureBlob(resolvedSourceUrl);
	} catch (directError) {
		if (!/^https?:\/\//i.test(resolvedSourceUrl)) {
			throw directError;
		}
		blob = await fetchProfilePictureBlobViaProxy(resolvedSourceUrl);
	}

	const file = new File([blob], inferProfilePictureFileName(resolvedSourceUrl, blob.type), {
		type: blob.type || 'image/png'
	});
	return await uploadProfilePictureFile(file);
}
