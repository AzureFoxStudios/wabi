import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { currentUser } from '$lib/socket';
import { getAuthToken } from '$lib/authSession';
import {
	heartbeatDesktopHelper,
	offlineDesktopHelper,
	registerDesktopHelper,
	type DesktopHelperRegistrationPayload
} from '$lib/api';
import { isDesktopTauri } from '$lib/tauri-platform';

export type DesktopHelperProfileMode = 'off' | 'files-only' | 'desktop-assist';

interface DesktopHelperProfile {
	name: string;
	mode: DesktopHelperProfileMode;
}

export interface DesktopHelperState {
	enabled: boolean;
	active: boolean;
	mode: DesktopHelperProfileMode;
	name: string;
	helperId: string | null;
	relayId: number | null;
	message: string;
	lastHeartbeatAt: number | null;
}

export const DESKTOP_HELPER_PROFILE_KEY = 'wabi_desktop_helper_profile';
const DESKTOP_HELPER_ID_KEY = 'wabi_desktop_helper_id';
const HEARTBEAT_INTERVAL_MS = 45_000;

const initialState: DesktopHelperState = {
	enabled: false,
	active: false,
	mode: 'off',
	name: '',
	helperId: null,
	relayId: null,
	message: 'Desktop helper is off.',
	lastHeartbeatAt: null
};

export const desktopHelperState = writable<DesktopHelperState>(initialState);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let currentRelayId: number | null = null;
let started = false;
let unsubscribeCurrentUser: (() => void) | null = null;

function loadProfile(): DesktopHelperProfile {
	if (!browser) return { name: '', mode: 'off' };
	try {
		const raw = localStorage.getItem(DESKTOP_HELPER_PROFILE_KEY);
		if (!raw) return { name: '', mode: 'off' };
		const parsed = JSON.parse(raw);
		const name = typeof parsed?.name === 'string' ? parsed.name.trim().slice(0, 120) : '';
		const mode: DesktopHelperProfileMode =
			parsed?.mode === 'files-only' || parsed?.mode === 'desktop-assist' ? parsed.mode : 'off';
		return { name, mode };
	} catch {
		return { name: '', mode: 'off' };
	}
}

function ensureHelperId(): string | null {
	if (!browser) return null;
	try {
		const existing = localStorage.getItem(DESKTOP_HELPER_ID_KEY);
		if (existing && /^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
		const generated =
			typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
				? crypto.randomUUID()
				: `helper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		localStorage.setItem(DESKTOP_HELPER_ID_KEY, generated);
		return generated;
	} catch {
		return null;
	}
}

function clearHeartbeatTimer(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

function setState(patch: Partial<DesktopHelperState>): void {
	desktopHelperState.update((state) => ({ ...state, ...patch }));
}

function buildPayload(): DesktopHelperRegistrationPayload | null {
	if (!browser || !isDesktopTauri()) return null;
	const token = getAuthToken();
	const me = get(currentUser);
	const profile = loadProfile();
	if (!token || !me?.dbUserId || profile.mode === 'off' || !profile.name) return null;
	const helperId = ensureHelperId();
	if (!helperId) return null;
	return {
		helperId,
		name: profile.name,
		mode: profile.mode
	};
}

async function registerAndHeartbeat(): Promise<void> {
	const token = getAuthToken();
	const payload = buildPayload();
	if (!token || !payload) {
		clearHeartbeatTimer();
		const profile = loadProfile();
		setState({
			enabled: false,
			active: false,
			name: profile.name,
			mode: profile.mode,
			helperId: browser ? localStorage.getItem(DESKTOP_HELPER_ID_KEY) : null,
			message:
				profile.mode === 'off'
					? 'Desktop helper is off.'
					: !profile.name
						? 'Pick a helper name before using helper mode.'
						: 'Sign in on desktop to activate helper mode.'
		});
		return;
	}

	try {
		setState({
			enabled: true,
			active: false,
			name: payload.name,
			mode: payload.mode,
			helperId: payload.helperId,
			message: 'Registering desktop helper...'
		});
		const registration = await registerDesktopHelper(token, payload);
		currentRelayId = registration.relayId || null;
		setState({
			enabled: true,
			active: true,
			name: payload.name,
			mode: payload.mode,
			helperId: payload.helperId,
			relayId: currentRelayId,
			message:
				payload.mode === 'files-only'
					? 'Desktop helper is active in Files Only mode.'
					: 'Desktop helper is active in Desktop Assist mode.',
			lastHeartbeatAt: Date.now()
		});
		clearHeartbeatTimer();
		heartbeatTimer = setInterval(() => {
			void heartbeatOnce();
		}, HEARTBEAT_INTERVAL_MS);
	} catch (error) {
		clearHeartbeatTimer();
		setState({
			enabled: true,
			active: false,
			name: payload.name,
			mode: payload.mode,
			helperId: payload.helperId,
			message: error instanceof Error ? error.message : 'Failed to activate desktop helper.'
		});
	}
}

async function heartbeatOnce(): Promise<void> {
	const token = getAuthToken();
	const payload = buildPayload();
	if (!token || !payload) {
		await stopDesktopHelperService(false);
		return;
	}
	try {
		await heartbeatDesktopHelper(token, payload);
		setState({
			enabled: true,
			active: true,
			name: payload.name,
			mode: payload.mode,
			helperId: payload.helperId,
			relayId: currentRelayId,
			message:
				payload.mode === 'files-only'
					? 'Desktop helper is active in Files Only mode.'
					: 'Desktop helper is active in Desktop Assist mode.',
			lastHeartbeatAt: Date.now()
		});
	} catch (error) {
		setState({
			active: false,
			message: error instanceof Error ? error.message : 'Desktop helper heartbeat failed.'
		});
	}
}

export async function syncDesktopHelperService(): Promise<void> {
	if (!browser || !isDesktopTauri()) {
		clearHeartbeatTimer();
		setState({
			enabled: false,
			active: false,
			message: 'Desktop helper is only available in the desktop app.'
		});
		return;
	}
	const payload = buildPayload();
	if (!payload) {
		await stopDesktopHelperService(Boolean(getAuthToken()));
		return;
	}
	await registerAndHeartbeat();
}

export async function stopDesktopHelperService(markOffline = true): Promise<void> {
	clearHeartbeatTimer();
	const helperId = browser ? localStorage.getItem(DESKTOP_HELPER_ID_KEY) : null;
	const token = getAuthToken();
	if (markOffline && token && helperId) {
		try {
			await offlineDesktopHelper(token, helperId, 'Desktop helper stopped.');
		} catch {
			// Ignore shutdown failures; stale nodes time out server-side.
		}
	}
	const profile = loadProfile();
	currentRelayId = null;
	setState({
		enabled: profile.mode !== 'off',
		active: false,
		name: profile.name,
		mode: profile.mode,
		helperId,
		relayId: null,
		lastHeartbeatAt: null,
		message:
			profile.mode === 'off'
				? 'Desktop helper is off.'
				: 'Desktop helper is configured but not currently active.'
	});
}

export function startDesktopHelperLifecycle(): () => void {
	if (!browser || !isDesktopTauri() || started) {
		return () => {};
	}
	started = true;
	unsubscribeCurrentUser = currentUser.subscribe(() => {
		void syncDesktopHelperService();
	});
	void syncDesktopHelperService();
	return () => {
		started = false;
		unsubscribeCurrentUser?.();
		unsubscribeCurrentUser = null;
		void stopDesktopHelperService(false);
	};
}
