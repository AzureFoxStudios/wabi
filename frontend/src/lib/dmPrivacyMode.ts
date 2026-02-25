import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type DMPrivacyMode = 'open' | 'sealed' | 'private';

const STORAGE_KEY = 'wabi:dm-privacy-modes:v1';
const DEFAULT_DM_PRIVACY_MODE: DMPrivacyMode = 'sealed';
const VALID_MODES = new Set<DMPrivacyMode>(['open', 'sealed', 'private']);

function loadStoredModes(): Record<string, DMPrivacyMode> {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const out: Record<string, DMPrivacyMode> = {};
		for (const [channelId, mode] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof channelId !== 'string') continue;
			if (typeof mode === 'string' && VALID_MODES.has(mode as DMPrivacyMode)) {
				out[channelId] = mode as DMPrivacyMode;
			}
		}
		return out;
	} catch {
		return {};
	}
}

export const dmPrivacyModes = writable<Record<string, DMPrivacyMode>>(loadStoredModes());

if (browser) {
	dmPrivacyModes.subscribe((value) => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		} catch {
			// Ignore storage failures.
		}
	});
}

export function getDMPrivacyMode(channelId: string): DMPrivacyMode {
	if (!channelId) return DEFAULT_DM_PRIVACY_MODE;
	return get(dmPrivacyModes)[channelId] ?? DEFAULT_DM_PRIVACY_MODE;
}

export function setDMPrivacyMode(channelId: string, mode: DMPrivacyMode): void {
	if (!channelId || !VALID_MODES.has(mode)) return;
	dmPrivacyModes.update((state) => ({ ...state, [channelId]: mode }));
}

