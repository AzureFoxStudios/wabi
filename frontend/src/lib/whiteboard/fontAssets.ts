import { writable } from 'svelte/store';
import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';

/**
 * Board-scoped custom fonts. Fonts are uploaded per board (privacy model: no
 * global font registry), listed so every collaborator can discover + load the
 * fonts a board's text elements reference.
 *
 * Loading follows the protected-image pattern from boardRenderer: whiteboard
 * file URLs require auth headers, so bytes are fetched via fetch() and handed
 * to FontFace as an ArrayBuffer (a FontFace src URL could not send auth).
 */

export interface WhiteboardFont {
	fontId: string;
	family: string;
	fileName: string;
	fileUrl: string;
	mimeType: string;
}

interface FontRecord extends WhiteboardFont {
	status: 'pending' | 'loaded' | 'error';
}

const fontsByBoard = new Map<string, Map<string, FontRecord>>();
const listeners = new Set<() => void>();

/**
 * Fonts loaded for the board currently on screen. The render path is
 * boardless (renderText gets ctx + element only), so it resolves fontIds
 * against this scope; the canvas component sets it on board open.
 */
let activeFontScope = '';

export function setActiveFontScope(boardId: string): void {
	activeFontScope = boardId || '';
}

export function getActiveFontScope(): string {
	return activeFontScope;
}

/**
 * Bumped every time a font finishes loading. Baked into the renderer's
 * per-layer content cache key so async font loads invalidate cached layer
 * bitmaps (element updatedAt alone would keep the fallback-font raster).
 */
let fontEpoch = 0;

export function getFontEpoch(): number {
	return fontEpoch;
}

export const whiteboardFonts = writable<Record<string, WhiteboardFont[]>>({});

function publish(): void {
	const snapshot: Record<string, WhiteboardFont[]> = {};
	for (const [boardId, records] of fontsByBoard) {
		snapshot[boardId] = [...records.values()].map(({ status: _status, ...font }) => font);
	}
	whiteboardFonts.set(snapshot);
}

export function onFontsLoaded(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function notifyLoaded(): void {
	for (const cb of listeners) {
		try {
			cb();
		} catch {
			// A broken listener must not break font loading for others.
		}
	}
}

function resolveUrl(fileUrl: string): string {
	try {
		return new URL(fileUrl, getServerUrl()).toString();
	} catch {
		return fileUrl;
	}
}

function authHeaders(): HeadersInit {
	const token = getAuthToken();
	const sessionId = token ? null : getGuestSessionId();
	const headers: HeadersInit = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (!token && sessionId) headers['X-Session-Id'] = sessionId;
	return headers;
}

async function ensureFontLoaded(boardId: string, record: FontRecord): Promise<void> {
	if (record.status !== 'pending') return;
	record.status = 'loading' as FontRecord['status'];
	try {
		if (typeof document === 'undefined' || typeof FontFace === 'undefined') {
			record.status = 'error';
			return;
		}
		const response = await fetch(resolveUrl(record.fileUrl), { headers: authHeaders() });
		if (!response.ok) throw new Error(`font fetch failed (${response.status})`);
		const buffer = await response.arrayBuffer();
		const face = new FontFace(record.family, buffer);
		await face.load();
		document.fonts.add(face);
		record.status = 'loaded';
		fontEpoch += 1;
		notifyLoaded();
	} catch (error) {
		console.warn('[Whiteboard] Failed to load custom font:', record.fileName, error);
		record.status = 'error';
	}
}

function upsertFont(boardId: string, font: WhiteboardFont): void {
	let records = fontsByBoard.get(boardId);
	if (!records) {
		records = new Map();
		fontsByBoard.set(boardId, records);
	}
	const existing = records.get(font.fontId);
	if (existing) {
		Object.assign(existing, font);
		return;
	}
	const record: FontRecord = { ...font, status: 'pending' };
	records.set(font.fontId, record);
	void ensureFontLoaded(boardId, record);
}

export async function loadFontsForBoard(boardId: string): Promise<void> {
	if (!boardId) return;
	try {
		const response = await fetch(`${getServerUrl()}/api/whiteboard/boards/${encodeURIComponent(boardId)}/fonts`, {
			headers: authHeaders()
		});
		if (!response.ok) return;
		const payload = await response.json().catch(() => null);
		const fonts: unknown = payload?.fonts;
		if (!Array.isArray(fonts)) return;
		for (const candidate of fonts) {
			if (!candidate || typeof candidate !== 'object') continue;
			const fontId = (candidate as Record<string, unknown>).fontId;
			const family = (candidate as Record<string, unknown>).family;
			const fileUrl = (candidate as Record<string, unknown>).fileUrl;
			if (typeof fontId !== 'string' || typeof family !== 'string' || typeof fileUrl !== 'string') continue;
			upsertFont(boardId, {
				fontId,
				family,
				fileName: typeof (candidate as Record<string, unknown>).fileName === 'string' ? (candidate as Record<string, unknown>).fileName as string : fontId,
				fileUrl,
				mimeType: typeof (candidate as Record<string, unknown>).mimeType === 'string' ? (candidate as Record<string, unknown>).mimeType as string : ''
			});
		}
		publish();
	} catch (error) {
		console.warn('[Whiteboard] Failed to list board fonts:', error);
	}
}

/**
 * Kick loading for fonts referenced by elements that joined via a live patch
 * or snapshot after the initial list fetch. Unknown ids are ignored (font not
 * uploaded yet / deleted).
 */
export function ensureBoardFont(boardId: string, fontId: string): void {
	if (!boardId || !fontId) return;
	const record = fontsByBoard.get(boardId)?.get(fontId);
	if (record && record.status === 'pending') void ensureFontLoaded(boardId, record);
}

/** Sync lookup for the render loop: fontId → usable CSS family. */
export function resolveFontFamily(boardId: string | undefined | null, fontId: string | undefined | null, fallback: string): string {
	if (!fontId) return fallback;
	const record = fontsByBoard.get(boardId || activeFontScope)?.get(fontId);
	if (!record) return fallback;
	// Quote custom families so multi-word names survive the canvas font string.
	return record.status === 'loaded' ? `"${record.family}", ${fallback}` : fallback;
}

export async function uploadWhiteboardFont(boardId: string, file: File): Promise<WhiteboardFont> {
	const formData = new FormData();
	formData.append('file', file, file.name);
	const response = await fetch(`${getServerUrl()}/api/whiteboard/boards/${encodeURIComponent(boardId)}/fonts`, {
		method: 'POST',
		headers: authHeaders(),
		body: formData
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || !payload?.success) {
		throw new Error(
			typeof payload?.error === 'string' && payload.error.trim().length > 0
				? payload.error
				: `Font upload failed (${response.status})`
		);
	}
	const font: WhiteboardFont = {
		fontId: String(payload.fontId || ''),
		family: String(payload.family || file.name.replace(/\.[^.]+$/, '')),
		fileName: String(payload.fileName || file.name),
		fileUrl: String(payload.fileUrl || ''),
		mimeType: String(payload.mimeType || file.type || '')
	};
	if (!font.fontId || !font.fileUrl) throw new Error('Font upload did not return a file reference.');
	upsertFont(boardId, font);
	publish();
	return font;
}
