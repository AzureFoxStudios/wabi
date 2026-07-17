import { browser } from '$app/environment';
import { derived, writable, type Readable } from 'svelte/store';

import { normalizeServerUrl, resolveServerUrl } from '$lib/serverUrl';

/**
 * Unified, device-local per-server settings. These never touch the server and
 * only affect the person who set them. Everything that is meaningfully
 * "per community" (rather than global to the device, or per-channel) lives
 * here, keyed by normalized server URL — mirroring the existing `following.ts`
 * per-server local state pattern.
 *
 * Layers, most specific wins except where noted:
 *   - message.isSpoiler        (per message)
 *   - channel.forceSpoiler     (per channel)
 *   - ServerSettings.unspoilAll (per server — overrides everything on the server)
 *   - ServerSettings.spoilAll   (per server)
 *   - global Spoiler All        (device-wide)
 */
export interface ServerSettings {
	/** Hide every message on this server behind a spoiler veil. */
	spoilAll: boolean;
	/** Force-reveal every message on this server, even spoilers ("server is king"). */
	unspoilAll: boolean;
}

export type ServerSettingsState = Record<string, ServerSettings>;

const SERVER_SETTINGS_KEY = 'wabi.serverSettings';

const DEFAULT_SERVER_SETTINGS: ServerSettings = {
	spoilAll: false,
	unspoilAll: false
};

const DEFAULT_STATE: ServerSettingsState = {};

function sanitizeServerSettings(value: unknown): ServerSettings {
	const candidate = (value ?? {}) as Record<string, unknown>;
	return {
		spoilAll: candidate.spoilAll === true,
		unspoilAll: candidate.unspoilAll === true
	};
}

function sanitizeServerSettingsState(value: unknown): ServerSettingsState {
	const candidate = (value ?? {}) as Record<string, unknown>;
	const nextState: ServerSettingsState = {};
	for (const [serverUrl, settings] of Object.entries(candidate)) {
		if (!serverUrl || typeof settings !== 'object' || Array.isArray(settings)) {
			continue;
		}
		const normalized = normalizeServerUrl(serverUrl);
		if (!normalized) continue;
		nextState[normalized] = sanitizeServerSettings(settings);
	}
	return nextState;
}

function loadServerSettingsState(): ServerSettingsState {
	if (!browser) return DEFAULT_STATE;
	try {
		const raw = localStorage.getItem(SERVER_SETTINGS_KEY);
		if (!raw) return DEFAULT_STATE;
		return sanitizeServerSettingsState(JSON.parse(raw));
	} catch {
		return DEFAULT_STATE;
	}
}

function persistServerSettingsState(state: ServerSettingsState): void {
	if (!browser) return;
	try {
		localStorage.setItem(SERVER_SETTINGS_KEY, JSON.stringify(state));
	} catch {
		// Best effort only.
	}
}

export function getActiveServerUrl(): string {
	return normalizeServerUrl(resolveServerUrl().url) || resolveServerUrl().url;
}

export const serverSettings = writable<ServerSettingsState>(loadServerSettingsState());

if (browser) {
	serverSettings.subscribe((value) => {
		persistServerSettingsState(value);
	});
}

/** Read the merged settings for a server (falls back to defaults). */
export function getServerSettings(serverUrl: string = getActiveServerUrl()): ServerSettings {
	const normalized = normalizeServerUrl(serverUrl);
	if (!normalized) return { ...DEFAULT_SERVER_SETTINGS };
	const stored = serverSettings[normalized];
	return { ...DEFAULT_SERVER_SETTINGS, ...(stored ?? {}) };
}

/** True if the server has any non-default (user-set) settings. */
export function serverHasSettings(serverUrl: string = getActiveServerUrl()): boolean {
	const normalized = normalizeServerUrl(serverUrl);
	if (!normalized) return false;
	const settings = serverSettings[normalized];
	if (!settings) return false;
	return settings.spoilAll !== false || settings.unspoilAll !== false;
}

/**
 * Update a single key on a server's settings. Empty (all-default) entries are
 * dropped so we don't leave dead keys around.
 */
export function updateServerSetting<K extends keyof ServerSettings>(
	key: K,
	value: ServerSettings[K],
	serverUrl: string = getActiveServerUrl()
): void {
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl) return;

	serverSettings.update((state) => {
		const current = state[normalizedServerUrl] ?? { ...DEFAULT_SERVER_SETTINGS };
		const next: ServerSettings = { ...current, [key]: value };

		if (next.spoilAll === false && next.unspoilAll === false) {
			const nextState = { ...state };
			delete nextState[normalizedServerUrl];
			return nextState;
		}
		return { ...state, [normalizedServerUrl]: next };
	});
}

// --- Spoiler convenience helpers (backwards-compatible surface) ---

export function setServerSpoilAll(enabled: boolean, serverUrl: string = getActiveServerUrl()): void {
	updateServerSetting('spoilAll', enabled, serverUrl);
}

export function setServerUnspoilAll(enabled: boolean, serverUrl: string = getActiveServerUrl()): void {
	updateServerSetting('unspoilAll', enabled, serverUrl);
}

export function toggleServerSpoilAll(serverUrl: string = getActiveServerUrl()): void {
	setServerSpoilAll(!getServerSettings(serverUrl).spoilAll, serverUrl);
}

export function toggleServerUnspoilAll(serverUrl: string = getActiveServerUrl()): void {
	setServerUnspoilAll(!getServerSettings(serverUrl).unspoilAll, serverUrl);
}

export const activeServerSettings: Readable<ServerSettings> = derived(
	serverSettings,
	($serverSettings): ServerSettings => {
		const serverUrl = getActiveServerUrl();
		return $serverSettings[serverUrl] ?? { ...DEFAULT_SERVER_SETTINGS };
	}
);

export const activeServerSpoilAll: Readable<boolean> = derived(
	activeServerSettings,
	($activeServerSettings): boolean => $activeServerSettings.spoilAll === true
);

export const activeServerUnspoilAll: Readable<boolean> = derived(
	activeServerSettings,
	($activeServerSettings): boolean => $activeServerSettings.unspoilAll === true
);
