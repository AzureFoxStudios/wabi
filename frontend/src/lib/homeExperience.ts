import { browser } from '$app/environment';
import { layoutStore } from '$lib/layoutStore';

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

export function applyHomeExperienceMode(mode: HomeExperienceMode): void {
	if (mode === 'conversations') {
		layoutStore.showDMsTab();
		return;
	}
	layoutStore.showUsersTab();
}
