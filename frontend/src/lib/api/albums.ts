import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';

export type MediaAlbumScopeType = 'channel' | 'dm';

export interface MediaAlbum {
	id: number;
	scopeType: MediaAlbumScopeType;
	scopeId: string;
	name: string;
	createdBy: number;
	createdAt: number;
	updatedAt: number;
	isFeatured: boolean;
	itemCount: number;
}

export interface MediaAlbumItem {
	id: number;
	albumId: number;
	attachmentUrl: string;
	attachmentName: string;
	attachmentSize: number | null;
	attachmentMime: string | null;
	messageId: string | null;
	caption: string | null;
	sortOrder: number;
	uploadedBy: number;
	uploadedAt: number;
}

export type MediaAlbumErrorCode = 'ALBUM_UPLOAD_SIZE_LIMIT' | 'ALBUM_UPLOAD_RATE_LIMIT_USER' | 'ALBUM_UPLOAD_RATE_LIMIT_SCOPE';

export class MediaAlbumApiError extends Error {
	status: number;
	code: string | null;
	retryAfterSeconds: number | null;
	details: Record<string, any> | null;

	constructor(
		message: string,
		opts: {
			status: number;
			code?: string | null;
			retryAfterSeconds?: number | null;
			details?: Record<string, any> | null;
		}
	) {
		super(message);
		this.name = 'MediaAlbumApiError';
		this.status = opts.status;
		this.code = opts.code ?? null;
		this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
		this.details = opts.details ?? null;
	}
}

export async function listMediaAlbums(
	token: string,
	scopeType: MediaAlbumScopeType,
	scopeId: string,
	limit = 100
): Promise<MediaAlbum[]> {
	const params = new URLSearchParams({
		scopeType,
		scopeId,
		limit: String(limit)
	});
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums?${params.toString()}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to list media albums');
	}
	let data: unknown;
	try {
		data = await res.json();
	} catch (err) {
		const text = await res.text().catch(() => '<empty>');
		console.error('[listMediaAlbums] Server returned non-JSON:', res.status, text.slice(0, 500));
		throw new Error(`Server returned invalid JSON (${res.status}). Check console for details.`);
	}
	return Array.isArray((data as any)?.albums) ? ((data as any).albums as MediaAlbum[]) : [];
}

export async function createMediaAlbum(
	token: string,
	payload: { scopeType: MediaAlbumScopeType; scopeId: string; name: string }
): Promise<MediaAlbum> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to create media album');
	}
	try {
		const data = await res.json();
		return data.album as MediaAlbum;
	} catch {
		throw new Error('Invalid response from server while creating media album');
	}
}

export async function listMediaAlbumItems(
	token: string,
	albumId: number,
	limit = 300
): Promise<{ album: MediaAlbum; items: MediaAlbumItem[] }> {
	const params = new URLSearchParams({ limit: String(limit) });
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items?${params.toString()}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to list media album items');
	}
	try {
		const data = await res.json();
		return {
			album: data.album as MediaAlbum,
			items: Array.isArray(data.items) ? (data.items as MediaAlbumItem[]) : []
		};
	} catch {
		throw new Error('Invalid response from server while listing media album items');
	}
}

export async function addMediaAlbumItem(
	token: string,
	albumId: number,
	payload: {
		attachmentUrl: string;
		attachmentName: string;
		attachmentSize?: number | null;
		attachmentMime?: string | null;
		messageId?: string | null;
		caption?: string | null;
	}
): Promise<MediaAlbumItem> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		const payload = await res.json().catch(() => ({} as Record<string, any>));
		const code = typeof payload.code === 'string' ? payload.code : null;
		const retryAfterSeconds =
			typeof payload.retryAfterSeconds === 'number' && Number.isFinite(payload.retryAfterSeconds)
				? payload.retryAfterSeconds
				: null;
		const details =
			payload.details && typeof payload.details === 'object'
				? (payload.details as Record<string, any>)
				: null;
		let message = typeof payload.error === 'string' ? payload.error : 'Failed to add media album item';
		if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
			message = `${message} Try again in ${retryAfterSeconds}s.`;
		}
		throw new MediaAlbumApiError(message, {
			status: res.status,
			code,
			retryAfterSeconds,
			details
		});
	}
	const data = await res.json();
	return data.item as MediaAlbumItem;
}

export async function setMediaAlbumFeatured(token: string, albumId: number, featured: boolean): Promise<MediaAlbum> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/featured`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ featured })
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to update featured album state');
	}
	const data = await res.json();
	return data.album as MediaAlbum;
}

export async function reorderMediaAlbumItems(token: string, albumId: number, itemIds: number[]): Promise<MediaAlbumItem[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items/reorder`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ itemIds })
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to reorder media album items');
	}
	const data = await res.json();
	return Array.isArray(data.items) ? (data.items as MediaAlbumItem[]) : [];
}

export async function deleteMediaAlbum(token: string, albumId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to delete media album');
	}
}

export async function deleteMediaAlbumItem(token: string, albumId: number, itemId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/albums/${albumId}/items/${itemId}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to delete media album item');
	}
}
