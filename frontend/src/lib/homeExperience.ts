import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { activeRightTab, pinnedPanelId, rightPanelMode } from './layoutStoreStates';
import { openRightPanel } from './layoutStoreRightPanel';

export type HomeExperienceMode = 'community' | 'conversations';

const STORAGE_KEY = 'wabi.home_experience';

export function normalizeHomeExperienceMode(value: unknown): HomeExperienceMode {
	return value === 'conversations' ? 'conversations' : 'community';
}

export function getStoredHomeExperienceMode(): HomeExperienceMode {
	if (!browser) return 'community';
	try {
		return normalizeHomeExperienceMode(localStorage.getItem(STORAGE_KEY));
	} catch {
		return 'community';
	}
}

export function setStoredHomeExperienceMode(mode: HomeExperienceMode): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {
		// Best effort only.
	}
}

/** Apply an explicit registration/Settings choice, never an automatic refresh. */
export function applyHomeExperienceMode(mode: HomeExperienceMode): void {
	const panel = mode === 'conversations' ? 'dms' : 'users';
	// openRightPanel uses toggle semantics for stub clicks. A preference command
	// is idempotent: choosing the current mode must not close the pinned panel.
	if (get(rightPanelMode) !== 'pinned' || get(pinnedPanelId) !== panel) {
		openRightPanel(panel);
	}
	activeRightTab.set(panel);
}
