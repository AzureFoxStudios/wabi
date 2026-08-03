// Steam addon frontend store (opt-in).
//
// Polls GET /api/steam/status for the current user's Steam status once a
// minute. The whole feature is opt-in: the user must store their Steam id in
// localStorage (`wabi.steam.steamId`) and the server must have a
// STEAM_API_KEY configured. When either is missing the store stays disabled
// and never errors out the UI.
//
// Follows the safeReadSettings() localStorage pattern from customStatusPresets.ts
// and the `$currentUser` store pattern used by ProfileCard.svelte.

import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { currentUser } from '$lib/socket';
import { getApiBase } from '$lib/api/utils';
import { getAuthToken } from '$lib/authSession';
import type { SteamStatus } from '../../../../packages/wabi-protocol/src/index';

/** localStorage key holding the user's Steam 64-bit id (opt-in). */
const STEAM_ID_KEY = 'wabi.steam.steamId';

/** Poll cadence: 60s, mirroring the server-side 60s cache. */
const POLL_INTERVAL_MS = 60 * 1000;

export interface SteamStatusState {
	/** True when the user has provided a Steam id (opted in). */
	enabled: boolean;
	loading: boolean;
	error: string | null;
	steamId: string | null;
	/** Current game status; null when offline, private, or not in a game. */
	status: SteamStatus | null;
}

const INITIAL_STATE: SteamStatusState = {
	enabled: false,
	loading: false,
	error: null,
	steamId: null,
	status: null
};

function safeReadSteamId(): string | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(STEAM_ID_KEY);
		if (!raw) return null;
		const trimmed = raw.trim();
		return /^\d{6,}$/.test(trimmed) ? trimmed : null;
	} catch {
		return null;
	}
}

function safeWriteSteamId(id: string | null): void {
	if (!browser) return;
	try {
		if (id) {
			localStorage.setItem(STEAM_ID_KEY, id.trim());
		} else {
			localStorage.removeItem(STEAM_ID_KEY);
		}
	} catch {
		// best-effort persistence
	}
}

export const steamStatusStore = writable<SteamStatusState>({ ...INITIAL_STATE });

function normalizeSteamStatus(payload: unknown): SteamStatus | null {
	if (!payload || typeof payload !== 'object') return null;
	const value = payload as Partial<SteamStatus>;
	if (typeof value.steamId !== 'string') return null;
	return {
		steamId: value.steamId,
		personaName: value.personaName ?? '',
		profileUrl: value.profileUrl ?? '',
		avatar: value.avatar ?? '',
		inGame: value.inGame === true,
		gameId: typeof value.gameId === 'string' ? value.gameId : null,
		gameName: typeof value.gameName === 'string' ? value.gameName : null,
		updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now() / 1000,
		richPresence: typeof value.richPresence === 'string' ? value.richPresence : null
	};
}

/** Single-flight fetch guard so overlapping polls never race. */
let inflight: Promise<void> | null = null;

async function fetchSteamStatus(steamId: string): Promise<SteamStatusState> {
	try {
		const token = getAuthToken();
		const url = `${getApiBase()}/api/steam/status?steamId=${encodeURIComponent(steamId)}`;
		const res = await fetch(url, {
			credentials: 'include',
			headers: token ? { Authorization: `Bearer ${token}` } : undefined
		});

		if (res.status === 404) {
			// Server has no STEAM_API_KEY — feature gracefully disabled.
			return { ...INITIAL_STATE, enabled: false, steamId };
		}
		if (!res.ok) {
			return {
				enabled: true,
				loading: false,
				error: `Steam status request failed (${res.status})`,
				steamId,
				status: null
			};
		}

		const body: unknown = await res.json();
		const payload = (body ?? {}) as { enabled?: boolean; status?: unknown };
		return {
			enabled: payload.enabled !== false,
			loading: false,
			error: null,
			steamId,
			status: normalizeSteamStatus(payload.status)
		};
	} catch (err) {
		return {
			enabled: true,
			loading: false,
			error: err instanceof Error ? err.message : 'Steam status unavailable',
			steamId,
			status: null
		};
	}
}

async function refreshSteamStatus(): Promise<void> {
	const steamId = safeReadSteamId();
	if (!steamId) {
		steamStatusStore.set({ ...INITIAL_STATE, enabled: false });
		return;
	}
	steamStatusStore.update((current) => ({ ...current, enabled: true, loading: true }));
	const next = await fetchSteamStatus(steamId);
	steamStatusStore.set({ ...next, loading: false });
}

/** Public refresh — used by the badge/store and available for manual re-poll. */
export function refreshSteamStatusNow(): Promise<void> {
	if (inflight) return inflight;
	inflight = refreshSteamStatus().finally(() => {
		inflight = null;
	});
	return inflight;
}

/** Set (or clear) the current user's Steam id and re-poll immediately. */
export function setSteamId(id: string | null): void {
	const normalized = id && id.trim() ? id.trim() : null;
	safeWriteSteamId(normalized);
	steamStatusStore.update((current) => ({ ...current, steamId: normalized }));
	if (normalized) {
		void refreshSteamStatusNow();
	} else {
		steamStatusStore.set({ ...INITIAL_STATE, enabled: false });
	}
}

/** Read the stored Steam id without triggering a poll. */
export function getSteamId(): string | null {
	return get(steamStatusStore).steamId ?? safeReadSteamId();
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
// Starts polling when a user is logged in; idles when not. Returns an
// unsubscribe function for callers that want explicit control.

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let currentUserIdRef: string | null = null;

function stopPolling(): void {
	if (pollingTimer) {
		clearInterval(pollingTimer);
		pollingTimer = null;
	}
}

function startPolling(): void {
	if (pollingTimer) return;
	pollingTimer = setInterval(() => {
		void refreshSteamStatusNow();
	}, POLL_INTERVAL_MS);
}

function syncPollingLifecycle(): void {
	const user = get(currentUser);
	const userId = user ? (user.id ?? (user.dbUserId != null ? `user-${user.dbUserId}` : null)) : null;
	if (userId !== currentUserIdRef) {
		currentUserIdRef = userId;
		stopPolling();
		if (userId) {
			void refreshSteamStatusNow();
			startPolling();
		} else {
			steamStatusStore.set({ ...INITIAL_STATE, enabled: false });
		}
	}
}

let lifecycleStarted = false;

/** Kick off the currentUser-driven polling lifecycle. Idempotent. */
export function startSteamStatusPolling(): () => void {
	if (!browser || lifecycleStarted) return () => {};
	lifecycleStarted = true;
	const unsubscribe = currentUser.subscribe(() => syncPollingLifecycle());
	syncPollingLifecycle();
	return () => {
		unsubscribe();
		stopPolling();
		lifecycleStarted = false;
	};
}

if (browser) {
	// Self-start so the badge works without an explicit mount call.
	startSteamStatusPolling();
}
