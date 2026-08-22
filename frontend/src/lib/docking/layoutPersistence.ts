import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { getApiBase } from '$lib/api';
import { getAuthToken } from '$lib/authSession';
import { isTauriRuntime } from '$lib/tauri-platform';
import {
	createDefaultLayoutState,
	deserializeLayoutState,
	type LayoutStateV1,
	serializeLayoutState
} from './layoutSchema';

const STORAGE_KEY = 'wabi:dock-layout:v1';

// ─── Remote API persistence (server sync) ───────────────────────────────────

const API_LAYOUT_KEY = 'wabi:dock-layout:remote:v1';
const API_DEBOUNCE_MS = 2000;

let apiSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Resolve at call time so remote-server mode tracks getServerUrl(). */
function layoutApiUrl(): string {
	return `${getApiBase()}/api/user/layout`;
}

interface StoredLayout {
	state: LayoutStateV1;
	updatedAt: number;
}

function loadRemoteFromStorage(): StoredLayout | null {
	try {
		const raw = localStorage.getItem(API_LAYOUT_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return {
			state: parsed.state ?? parsed,
			updatedAt: parsed.updatedAt ?? Date.now()
		};
	} catch {
		return null;
	}
}

function saveRemoteToStorage(state: LayoutStateV1, updatedAt: number): void {
	localStorage.setItem(API_LAYOUT_KEY, JSON.stringify({ state, updatedAt }));
}

async function loadFromServer(token: string): Promise<{ layoutJson: string | null; updatedAt: number | null } | null> {
	try {
		const res = await fetch(layoutApiUrl(), {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/**
 * The server stores ONE keyed container per user
 * ({layout, theme, railDensity, railSide}) and rejects unknown top-level
 * keys — so every writer must GET-merge-PUT instead of blind-replacing,
 * or modules clobber each other and the whitelist 422s.
 */
export async function mergeIntoServerContainer(token: string, slot: string, value: unknown): Promise<boolean> {
	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`
	};
	let container: Record<string, unknown> = {};
	try {
		const res = await fetch(layoutApiUrl(), { headers });
		if (res.ok) {
			const body = (await res.json()) as { layoutJson?: string | null };
			if (body?.layoutJson) {
				const parsed = JSON.parse(body.layoutJson) as unknown;
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					container = parsed as Record<string, unknown>;
				}
			}
		}
	} catch {
		// start from an empty container; server tolerates partial containers
	}
	container[slot] = value;
	try {
		const res = await fetch(layoutApiUrl(), {
			method: 'PUT',
			headers,
			body: JSON.stringify({ layoutJson: JSON.stringify(container) })
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Load layout state with server merge.
 * Server wins only if its updatedAt > local's.
 * Never throws — returns null on any error.
 */
export async function loadLayoutState(): Promise<LayoutStateV1 | null> {
	const local = loadRemoteFromStorage();
	const token = getAuthToken();

	if (!token) {
		return local?.state ?? null;
	}

	const server = await loadFromServer(token);
	if (!server || server.layoutJson === null) {
		return local?.state ?? null;
	}

	const localUpdatedAt = local?.updatedAt ?? 0;
	if (server.updatedAt !== null && server.updatedAt > localUpdatedAt) {
		// Finding 25: never JSON.parse raw server layout outside a guard —
		// deserializeLayoutState validates/migrates and falls back to default.
		try {
			// Server stores the keyed container ({layout, ...}); legacy blobs
			// may hold the raw docking state — unwrap defensively.
			let rawLayout = server.layoutJson;
			try {
				const container = JSON.parse(server.layoutJson) as Record<string, unknown>;
				if (container && typeof container === 'object' && !Array.isArray(container) && 'layout' in container) {
					rawLayout = JSON.stringify(container.layout);
				}
			} catch {}
			const parsed = deserializeLayoutState(rawLayout);
			const now = server.updatedAt;
			saveRemoteToStorage(parsed, now);
			return parsed;
		} catch (err) {
			console.warn('[Docking] Server layoutJson invalid; using local/default:', err);
			return local?.state ?? null;
		}
	}

	return local?.state ?? null;
}

/**
 * Persist layout to server: localStorage instant, API debounced fire-and-forget.
 */
export function queuePersist(state: LayoutStateV1): void {
	const updatedAt = Date.now();

	// 1. LocalStorage — instant
	saveRemoteToStorage(state, updatedAt);

	// 2. API — debounced, fire-and-forget
	const token = getAuthToken();
	if (!token) return;

	if (apiSaveTimer) clearTimeout(apiSaveTimer);
	apiSaveTimer = setTimeout(async () => {
		// Serialize through the schema so the stored slot is always migrated/valid.
		const ok = await mergeIntoServerContainer(token, 'layout', JSON.parse(serializeLayoutState(state)));
		// Finding 27: surface failed layout saves (local already persisted)
		if (!ok) {
			console.warn('[Docking] Layout save failed: HTTP error');
		}
	}, API_DEBOUNCE_MS);
}

/**
 * Clear all persisted remote layout data (call on logout).
 */
export function clearPersistedRemoteLayout(): void {
	localStorage.removeItem(API_LAYOUT_KEY);
	if (apiSaveTimer) {
		clearTimeout(apiSaveTimer);
		apiSaveTimer = null;
	}
}

async function loadFromTauri(): Promise<LayoutStateV1 | null> {
	try {
		const serialized = await invoke<string | null>('load_layout_state');
		if (!serialized) return null;
		return deserializeLayoutState(serialized);
	} catch (error) {
		console.warn('[Docking] Failed to load layout from Tauri storage, falling back:', error);
		return null;
	}
}

async function saveToTauri(state: LayoutStateV1): Promise<boolean> {
	try {
		await invoke<string>('save_layout_state', {
			layoutJson: serializeLayoutState(state)
		});
		return true;
	} catch (error) {
		console.warn('[Docking] Failed to save layout via Tauri command:', error);
		return false;
	}
}

function loadFromLocalStorage(): LayoutStateV1 | null {
	if (!browser) return null;
	try {
		const serialized = localStorage.getItem(STORAGE_KEY);
		return deserializeLayoutState(serialized);
	} catch (error) {
		console.warn('[Docking] Failed to parse local layout state:', error);
		return null;
	}
}

function saveToLocalStorage(state: LayoutStateV1): boolean {
	if (!browser) return false;
	try {
		localStorage.setItem(STORAGE_KEY, serializeLayoutState(state));
		return true;
	} catch (error) {
		console.warn('[Docking] Failed to persist local layout state:', error);
		return false;
	}
}

export async function loadPersistedLayoutState(): Promise<LayoutStateV1> {
	if (!browser) return createDefaultLayoutState();

	if (isTauriRuntime()) {
		const tauriState = await loadFromTauri();
		if (tauriState) return tauriState;
	}

	return loadFromLocalStorage() || createDefaultLayoutState();
}

export async function persistLayoutState(state: LayoutStateV1): Promise<void> {
	if (!browser) return;

	const localSaved = saveToLocalStorage(state);
	if (isTauriRuntime()) {
		const tauriSaved = await saveToTauri(state);
		if (!tauriSaved && !localSaved) {
			console.warn('[Docking] Layout save failed for both localStorage and Tauri');
		}
	}
}

export async function clearPersistedLayoutState(): Promise<void> {
	if (!browser) return;
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch (error) {
		console.warn('[Docking] Failed to clear local layout state:', error);
	}

	if (isTauriRuntime()) {
		try {
			await invoke<string>('save_layout_state', {
				layoutJson: serializeLayoutState(createDefaultLayoutState())
			});
		} catch (error) {
			console.warn('[Docking] Failed to reset Tauri layout state:', error);
		}
	}
}
