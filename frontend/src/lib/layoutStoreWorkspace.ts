/**
 * layoutStoreWorkspace.ts
 * Workspace management operations
 */

import { get } from 'svelte/store';
import { createDefaultWorkspaceLayout, cloneWorkspace, getWorkspace, type WorkspaceLayoutV1 } from '$lib/docking/layoutSchema';
import { layoutState, activeWorkspace } from './layoutStoreStates';
import { applyWorkspaceToRuntime } from './layoutStoreUtils';
import { queuePersist } from './layoutStoreSync';

export function setActiveWorkspace(name: string): void {
	const trimmed = name.trim();
	if (!trimmed) return;
	layoutState.update((state) => {
		if (!state.workspaces[trimmed]) return state;
		return {
			...state,
			activeWorkspace: trimmed,
			updatedAt: Date.now()
		};
	});

	const workspace = get(layoutState).workspaces[trimmed];
	if (workspace) {
		applyWorkspaceToRuntime(workspace);
		queuePersist();
	}
}

export function saveWorkspace(name: string): void {
	const trimmed = name.trim();
	if (!trimmed) return;
	const state = get(layoutState);
	const current = getWorkspace(state);
	const nextWorkspace = cloneWorkspace(current, trimmed);
	layoutState.update((prev) => ({
		...prev,
		activeWorkspace: trimmed,
		workspaces: {
			...prev.workspaces,
			[trimmed]: nextWorkspace
		},
		updatedAt: Date.now()
	}));
	applyWorkspaceToRuntime(nextWorkspace);
	queuePersist();
}

export function renameWorkspace(oldName: string, nextName: string): void {
	const source = oldName.trim();
	const target = nextName.trim();
	if (!source || !target || source === target) return;
	layoutState.update((state) => {
		const existing = state.workspaces[source];
		if (!existing) return state;

		const workspaces = { ...state.workspaces };
		delete workspaces[source];
		workspaces[target] = cloneWorkspace(existing, target);

		return {
			...state,
			workspaces,
			activeWorkspace: state.activeWorkspace === source ? target : state.activeWorkspace,
			updatedAt: Date.now()
		};
	});

	const maybeActive = get(layoutState).workspaces[target];
	if (maybeActive && get(activeWorkspace) === target) {
		applyWorkspaceToRuntime(maybeActive);
	}
	queuePersist();
}

export function resetWorkspace(name?: string): void {
	const target = (name || get(activeWorkspace) || 'default').trim();
	const isKnownPreset =
		target === 'default' ||
		target === 'classic' ||
		target === 'focus' ||
		target === 'media-review' ||
		target === 'admin' ||
		target === 'creator' ||
		target === 'mod';
	const fallbackName = isKnownPreset ? target : 'default';
	const reset = createDefaultWorkspaceLayout(fallbackName);

	layoutState.update((state) => ({
		...state,
		activeWorkspace: target,
		workspaces: {
			...state.workspaces,
			[target]: {
				...reset,
				name: target
			}
		},
		updatedAt: Date.now()
	}));

	const workspace = get(layoutState).workspaces[target];
	if (workspace) {
		applyWorkspaceToRuntime(workspace);
	}
	queuePersist();
}
