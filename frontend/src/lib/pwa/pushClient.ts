/**
 * Web Push subscription client (PWA / browser delivery path).
 *
 * Native mobile clients use platform delivery integrations, but this remains
 * the shared server-side push contract and the browser/PWA implementation.
 */
import { browser } from '$app/environment';
import { getApiBase } from '$lib/api/utils';
import { getAuthToken } from '$lib/authSession';
import { fetchVapidKeyResult } from './pushDiagnostics';

const DEVICE_ID_KEY = 'wabi.deviceId';
// Explicit per-device push opt-out. Distinct from the desktop-notification
// master flag: a user may keep local toasts while refusing background push.
const PUSH_OPT_OUT_KEY = 'wabi.pushOptOut';

export function setPushOptOut(optedOut: boolean): void {
	try {
		if (optedOut) localStorage.setItem(PUSH_OPT_OUT_KEY, 'true');
		else localStorage.removeItem(PUSH_OPT_OUT_KEY);
	} catch {
		// Storage unavailable: the flag just can't persist this session.
	}
}

function isPushOptedOut(): boolean {
	try {
		return localStorage.getItem(PUSH_OPT_OUT_KEY) === 'true';
	} catch {
		// No readable storage means we cannot honor an opt-out — do not
		// auto-subscribe; the settings toggle still works.
		return true;
	}
}

export type PushSubscribeResult =
	| { ok: true; endpoint: string }
	| { ok: false; reason: string };

export type TestPushServerResult = {
	ok?: boolean;
	sent?: number;
	failed?: number;
};

export function interpretTestPushResult(payload: TestPushServerResult): { ok: boolean; reason?: string } {
	const sent = Number.isFinite(payload.sent) ? Math.max(0, Math.floor(payload.sent ?? 0)) : 0;
	const failed = Number.isFinite(payload.failed) ? Math.max(0, Math.floor(payload.failed ?? 0)) : 0;
	if (payload.ok === true && sent > 0) return { ok: true };
	if (sent === 0 && failed === 0) return { ok: false, reason: 'no_registered_delivery_target' };
	if (sent === 0 && failed > 0) return { ok: false, reason: `delivery_failed:${failed}` };
	return { ok: false, reason: 'server_reported_no_delivery' };
}

function getOrCreateDeviceId(): string {
	if (!browser) return 'server';
	try {
		const existing = localStorage.getItem(DEVICE_ID_KEY);
		if (existing && existing.length >= 8) return existing;
		const id =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID()
				: `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		localStorage.setItem(DEVICE_ID_KEY, id);
		return id;
	} catch {
		return `dev_${Date.now()}`;
	}
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

export async function fetchVapidPublicKey(): Promise<string | null> {
    const result = await fetchVapidKeyResult(`${getApiBase()}/api/push/vapid-public-key`);
    return result.ok ? result.publicKey : null;
}

export async function subscribeWebPush(): Promise<PushSubscribeResult> {
	if (!browser) return { ok: false, reason: 'not_browser' };
	const token = getAuthToken();
	if (!token) return { ok: false, reason: 'not_authenticated' };
	const apiBase = getApiBase();
	const current = () => getAuthToken() === token && getApiBase() === apiBase;
	if (!window.isSecureContext) return { ok: false, reason: 'insecure_context' };
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false, reason: 'push_unsupported' };
	if (!('Notification' in window)) return { ok: false, reason: 'notification_unsupported' };

	let sub: PushSubscription | null;
	try {
		let permission = Notification.permission;
		if (permission === 'default') permission = await Notification.requestPermission();
		if (!current()) return { ok: false, reason: 'account_changed' };
		if (permission !== 'granted') return { ok: false, reason: 'permission_denied' };
		const reg = await navigator.serviceWorker.ready;
		if (!current()) return { ok: false, reason: 'account_changed' };
		const key = await fetchVapidKeyResult(`${apiBase}/api/push/vapid-public-key`);
		if (!current()) return { ok: false, reason: 'account_changed' };
		// `=== false` (not `!key.ok`): the project's non-strict tsconfig does not
		// narrow a negated boolean discriminant.
		if (key.ok === false) return { ok: false, reason: key.reason };
		sub = await reg.pushManager.getSubscription();
		if (!current()) return { ok: false, reason: 'account_changed' };
		if (!sub) sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(key.publicKey) as BufferSource
		});
	} catch (error) {
		// Only structured DOMException names leave this block: raw vendor
		// messages stay console-side (see pushSubscription.test.ts) but the
		// reason still tells the user which class of failure they hit.
		console.warn('[pwa] push subscription failed', error);
		const name = error instanceof Error ? error.name : '';
		return {
			ok: false,
			reason:
				name === 'NotAllowedError'
					? 'browser_subscription_denied'
					: name === 'InvalidStateError'
						? 'browser_subscription_conflict'
						: name === 'AbortError'
							? 'browser_subscription_network'
							: name === 'NotSupportedError'
								? 'browser_subscription_unsupported'
								: 'browser_subscription_failed'
		};
	}
	if (!current()) return { ok: false, reason: 'account_changed' };
	const json = sub.toJSON();
	const body = JSON.stringify({ endpoint: json.endpoint, keys: json.keys, deviceId: getOrCreateDeviceId(), platform: 'web', userAgent: navigator.userAgent });
	const post = (bearer: string) => fetch(`${apiBase}/api/push/subscribe`, {
		method: 'POST', credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
		body
	});
	let res: Response;
	let usedToken = token;
	try {
		res = await post(token);
		// The 15-minute access token may have lapsed while the user was in the
		// permission prompt or the app was backgrounded: renew once and retry.
		if (res.status === 401) {
			const { tryRefresh } = await import('$lib/api/authRefresh');
			if (await tryRefresh(apiBase)) {
				const renewed = getAuthToken();
				if (renewed) { usedToken = renewed; res = await post(renewed); }
			}
		}
	} catch { return { ok: false, reason: 'subscription_network_error' }; }
	// A refresh legitimately rotates the token; a different account or server
	// (anything but the credential this request actually used) still aborts.
	if (getAuthToken() !== usedToken || getApiBase() !== apiBase) return { ok: false, reason: 'account_changed' };
	// Response bodies can contain operator diagnostics. Expose only the status.
	if (!res.ok) return { ok: false, reason: `subscription_http_${res.status}` };
	return { ok: true, endpoint: json.endpoint || sub.endpoint };
}

export async function unsubscribeWebPush(explicitToken?: string | null): Promise<void> {
	if (!browser || !('serviceWorker' in navigator)) return;
	// Logout captures the bearer before clearing the session: by the time this
	// dynamic import resolves, getAuthToken() would already be null and the
	// server binding would survive the logout it is supposed to remove.
	const token = explicitToken !== undefined ? explicitToken : getAuthToken();
	try {
		const reg = await navigator.serviceWorker.ready;
		const sub = await reg.pushManager.getSubscription();
		if (sub) {
			const endpoint = sub.endpoint;
			if (token) {
				// Tell the server first. If the account does not own this endpoint,
				// do not silently erase the local subscription and hide the mismatch.
				const res = await fetch(`${getApiBase()}/api/push/subscribe`, {
					method: 'DELETE',
					credentials: 'same-origin',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${token}`
					},
					body: JSON.stringify({ endpoint, deviceId: getOrCreateDeviceId() })
				});
				if (!res.ok) {
					console.warn('[pwa] server rejected push unsubscribe', res.status);
					return;
				}
			}
			await sub.unsubscribe().catch(() => {});
		}
	} catch (err) {
		console.warn('[pwa] unsubscribe failed', err);
	}
}

export async function sendTestPush(): Promise<{ ok: boolean; reason?: string }> {
	const token = getAuthToken();
	if (!token) return { ok: false, reason: 'not_authenticated' };
	try {
		const res = await fetch(`${getApiBase()}/api/push/test`, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return { ok: false, reason: `${res.status}:${text.slice(0, 120)}` };
		}
		const payload = (await res.json().catch(() => null)) as TestPushServerResult | null;
		if (!payload) return { ok: false, reason: 'invalid_server_response' };
		return interpretTestPushResult(payload);
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : 'network' };
	}
}

export async function getPushSubscriptionState(): Promise<{
	permission: NotificationPermission | 'unsupported';
	subscribed: boolean;
}> {
	if (!browser || !('Notification' in window)) {
		return { permission: 'unsupported', subscribed: false };
	}
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
		return { permission: Notification.permission, subscribed: false };
	}
	try {
		const reg = await navigator.serviceWorker.ready;
		const sub = await reg.pushManager.getSubscription();
		return { permission: Notification.permission, subscribed: Boolean(sub) };
	} catch {
		return { permission: Notification.permission, subscribed: false };
	}
}

export type PushPreferences = {
	directMessages: boolean;
	calls: boolean;
};

export async function getPushPreferences(): Promise<PushPreferences> {
	const token = getAuthToken();
	if (!token) return { directMessages: true, calls: true };
	try {
		const res = await fetch(`${getApiBase()}/api/push/preferences`, {
			credentials: 'same-origin',
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) return { directMessages: true, calls: true };
		const data = await res.json();
		return {
			directMessages: data.directMessages !== false,
			calls: data.calls !== false
		};
	} catch {
		return { directMessages: true, calls: true };
	}
}

export async function setPushPreferences(prefs: PushPreferences): Promise<boolean> {
	const token = getAuthToken();
	if (!token) return false;
	try {
		const res = await fetch(`${getApiBase()}/api/push/preferences`, {
			method: 'PUT',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify(prefs)
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Server channels the account switched message push on for (opt-in list).
 * DMs never appear here; they follow the account-level switch.
 *
 * `null` means the read failed — callers must NOT render that as "all off",
 * because a wrong all-off state would let one save silently drop choices the
 * server still holds.
 */
export async function getPushChannelPrefs(): Promise<string[] | null> {
	const token = getAuthToken();
	if (!token) return null;
	try {
		const res = await fetch(`${getApiBase()}/api/push/channels`, {
			credentials: 'same-origin',
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) return null;
		const data = await res.json();
		if (!Array.isArray(data?.enabled)) return null;
		return data.enabled.filter((value: unknown): value is string => typeof value === 'string');
	} catch {
		return null;
	}
}

/**
 * Replace the account's opt-in list (the settings screen owns the whole
 * list, so the server takes one atomic snapshot rather than toggles).
 */
export async function setPushChannelPrefs(enabled: string[]): Promise<boolean> {
	const token = getAuthToken();
	if (!token) return false;
	try {
		const res = await fetch(`${getApiBase()}/api/push/channels`, {
			method: 'PUT',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ enabled })
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Auto-subscribe to push after login. Best-effort: if the user hasn't granted
 * notification permission yet, or the browser doesn't support push, this is a
 * no-op. The settings tab can retry later.
 */
export async function autoSubscribePush(): Promise<void> {
	if (!browser || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
	if (!('Notification' in window)) return;
	if (Notification.permission !== 'granted') return;
	// Opt-out must stick: turning push off in settings is a durable choice,
	// not something the next login silently reverses.
	if (isPushOptedOut()) return;
	try {
		// Re-registering on every login is intentional, not churn: the push
		// subscription lives in the browser, but its server binding is per
		// account. Re-posting the existing endpoint is an idempotent upsert
		// that rebinds it to the account that just signed in — skipping this
		// because "already subscribed" leaves the PREVIOUS account delivering
		// into this browser (your own message buzzing a device now signed in
		// as someone else).
		await subscribeWebPush();
	} catch {
		// Best-effort: user can retry from settings
	}
}
