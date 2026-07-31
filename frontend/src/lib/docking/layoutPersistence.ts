import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
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
const API_BASE = '/api/user/layout';
const API_DEBOUNCE_MS = 2000;

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
		const res = await fetch(API_BASE, {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
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
		const parsed = JSON.parse(server.layoutJson);
		const now = server.updatedAt;
		saveRemoteToStorage(parsed, now);
		return parsed;
	}

	return local?.state ?? null;
}

// ─── Remote save ─────────────────────────────────────────────────────────────

let apiSaveTimer: ReturnType<typeof setTimeout> | null = null;

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
		try {
			await fetch(API_BASE, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ layoutJson: JSON.stringify(state) })
			});
		} catch {
			// Silent fail — localStorage already saved
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
