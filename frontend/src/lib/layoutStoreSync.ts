/**
 * layoutStoreSync.ts
 * Layout loading, persistence, and synchronization
 */

import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { createDefaultLayoutState, migrateLayoutState, getWorkspace } from '$lib/docking/layoutSchema';
import { loadPersistedLayoutState, persistLayoutState, loadLayoutState as loadRemoteLayoutState, queuePersist as queueRemotePersist } from '$lib/docking/layoutPersistence';
import { layoutState, activeWorkspace, setLayoutLoaded, setPersistTimer, DEFAULT_CONSTANTS } from './layoutStoreStates';
import { applyWorkspaceToRuntime, syncWorkspaceFromRuntime } from './layoutStoreUtils';

export async function loadLayoutState(): Promise<void> {
	if (!browser) return;
	try {
		const remoteState = await loadRemoteLayoutState();
		const persisted = remoteState ?? await loadPersistedLayoutState();
		const migrated = migrateLayoutState(persisted);
		layoutState.set(migrated);
		activeWorkspace.set(migrated.activeWorkspace);
		applyWorkspaceToRuntime(getWorkspace(migrated));
	} catch (error) {
		console.warn('[Docking] Layout recovery fell back to defaults:', error);
		const fallback = createDefaultLayoutState();
		layoutState.set(fallback);
		activeWorkspace.set('default');
		applyWorkspaceToRuntime(getWorkspace(fallback));
		void persistLayoutState(fallback);
	} finally {
		setLayoutLoaded(true);
	}
}

export function queuePersist(): void {
	if (!browser || !get({ layoutLoaded: true })) return;
	const timer = get({ persistTimer: null });
	if (timer) {
		clearTimeout(timer);
	}
	setPersistTimer(
		setTimeout(() => {
			setPersistTimer(null);
			void persistLayoutState(get(layoutState));
			void queueRemotePersist(get(layoutState));
		}, 140)
	);
}

let syncScheduled = false;
export function scheduleSyncWorkspace(): void {
	if (syncScheduled) return;
	syncScheduled = true;
	queueMicrotask(() => {
		syncScheduled = false;
		syncWorkspaceFromRuntime();
	});
}

export async function resetAllLayouts(): Promise<void> {
	if (!browser) return;
	const defaultLayout = createDefaultLayoutState();
	layoutState.set(defaultLayout);
	activeWorkspace.set('default');
	applyWorkspaceToRuntime(getWorkspace(defaultLayout));
	await persistLayoutState(defaultLayout);
	console.log('Reset all layouts to defaults');
}

export function exportLayoutJson(): string {
	return JSON.stringify(get(layoutState), null, 2);
}

export function importLayoutJson(jsonText: string): boolean {
	try {
		const parsed = JSON.parse(jsonText);
		const migrated = migrateLayoutState(parsed);
		layoutState.set(migrated);
		activeWorkspace.set(migrated.activeWorkspace);
		applyWorkspaceToRuntime(getWorkspace(migrated));
		void persistLayoutState(migrated);
		return true;
	} catch (error) {
		console.error('Failed to import layout:', error);
		return false;
	}
}
