import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/tauri-platform';
import {
	createDefaultLayoutState,
	deserializeLayoutState,
	type LayoutStateV1,
	serializeLayoutState
} from './layoutSchema';

const STORAGE_KEY = 'wabi:dock-layout:v1';

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
