/**
 * Web Push subscription client (PWA).
 */
import { browser } from '$app/environment';
import { getApiBase } from '$lib/api/utils';
import { getAuthToken } from '$lib/authSession';

const DEVICE_ID_KEY = 'wabi.deviceId';

export type PushSubscribeResult =
	| { ok: true; endpoint: string }
	| { ok: false; reason: string };

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
	try {
		const res = await fetch(`${getApiBase()}/api/push/vapid-public-key`, {
			credentials: 'same-origin'
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { publicKey?: string };
		return typeof data.publicKey === 'string' && data.publicKey.length > 0 ? data.publicKey : null;
	} catch {
		return null;
	}
}

export async function subscribeWebPush(): Promise<PushSubscribeResult> {
	if (!browser) return { ok: false, reason: 'not_browser' };
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
		return { ok: false, reason: 'push_unsupported' };
	}
	if (!('Notification' in window)) return { ok: false, reason: 'notification_unsupported' };

	let permission = Notification.permission;
	if (permission === 'default') {
		permission = await Notification.requestPermission();
	}
	if (permission !== 'granted') return { ok: false, reason: 'permission_denied' };

	const reg = await navigator.serviceWorker.ready;
	const publicKey = await fetchVapidPublicKey();
	if (!publicKey) return { ok: false, reason: 'no_vapid_key' };

	let sub = await reg.pushManager.getSubscription();
	if (!sub) {
		sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource
		});
	}

	const json = sub.toJSON();
	const token = getAuthToken();
	if (!token) return { ok: false, reason: 'not_authenticated' };

	const res = await fetch(`${getApiBase()}/api/push/subscribe`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({
			endpoint: json.endpoint,
			keys: json.keys,
			deviceId: getOrCreateDeviceId(),
			platform: 'web',
			userAgent: navigator.userAgent
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, reason: `server_${res.status}:${text.slice(0, 120)}` };
	}

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
			await sub.unsubscribe().catch(() => {});
			if (token) {
				await fetch(`${getApiBase()}/api/push/subscribe`, {
					method: 'DELETE',
					credentials: 'same-origin',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${token}`
					},
					body: JSON.stringify({ endpoint, deviceId: getOrCreateDeviceId() })
				}).catch(() => {});
			}
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
		return { ok: true };
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
