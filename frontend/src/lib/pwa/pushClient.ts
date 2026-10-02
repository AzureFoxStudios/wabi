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
		if (!key.ok) return key;
		sub = await reg.pushManager.getSubscription();
		if (!current()) return { ok: false, reason: 'account_changed' };
		if (!sub) sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(key.publicKey) as BufferSource
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : '';
		return { ok: false, reason: name === 'NotAllowedError' ? 'browser_subscription_denied' : name === 'InvalidStateError' ? 'browser_subscription_conflict' : 'browser_subscription_failed' };
	}
	if (!current()) return { ok: false, reason: 'account_changed' };
	const json = sub.toJSON();
	let res: Response;
	try {
		res = await fetch(`${apiBase}/api/push/subscribe`, {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, deviceId: getOrCreateDeviceId(), platform: 'web', userAgent: navigator.userAgent })
		});
	} catch { return { ok: false, reason: 'subscription_network_error' }; }
	if (!current()) return { ok: false, reason: 'account_changed' };
	// Response bodies can contain operator diagnostics. Expose only the status.
	if (!res.ok) return { ok: false, reason: `subscription_http_${res.status}` };
	return { ok: true, endpoint: json.endpoint || sub.endpoint };
}

export async function unsubscribeWebPush(): Promise<void> {
	if (!browser || !('serviceWorker' in navigator)) return;
	const token = getAuthToken();
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
