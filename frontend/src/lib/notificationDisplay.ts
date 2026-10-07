/**
 * notificationDisplay.ts
 * Notification display and message handling
 */

import { browser } from '$app/environment';
import { brandName } from '$lib/branding';
import type { Message } from '$lib/socket-types';
import { isTauriRuntime } from '$lib/tauri-platform';
import { sendTauriNotification } from '$lib/tauri-notifications';
import {
	getNotificationSound,
	getNotificationVolume,
	getNotificationSquelchSettings,
	areNotificationsEnabled,
	isNotificationPreviewEnabled,
	getCallRingtoneMode,
	getCallRingtoneCustomAudio,
	getStoredCustomSynthRingtonePreset,
	getCallRingtoneVolume
} from './notificationSettings';
import { playNotificationSound as playNotificationSoundAudio, playCallRingtone as playCallRingtoneAudio } from './notificationAudio';

interface SimpleNotification {
	title: string;
	body: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldSquelchNotification(message: Message | SimpleNotification): boolean {
	const text = String(('text' in message ? message.text : message.body) || '');
	if (!text) return false;

	const { suppressEveryoneHere, suppressRoleMentions } = getNotificationSquelchSettings();

	if (suppressEveryoneHere && /\B@(everyone|here|all)\b/i.test(text)) {
		return true;
	}

	if (suppressRoleMentions && (/<@&\d+>/.test(text) || /\B@&[\w-]+\b/.test(text))) {
		return true;
	}

	return false;
}

function browserNotificationPermissionGranted(): boolean {
	return browser && 'Notification' in window && Notification.permission === 'granted';
}

export function messageMentionsUser(message: Message, username?: string | null): boolean {
	const text = String(message?.text || '');
	if (!text) return false;

	if (/\B@(everyone|here|all)\b/i.test(text)) {
		return true;
	}

	if (!username) return false;
	const userPattern = new RegExp(`(^|[\\s(])@${escapeRegExp(username)}\\b`, 'i');
	return userPattern.test(text);
}

type BrowserNotificationInit = NotificationOptions & { renotify?: boolean };

/**
 * Android Chrome (and installed PWAs) forbid `new Notification()` and throw
 * "Illegal constructor": notifications there must come from the service worker
 * registration. Use the constructor where it works (desktop, tests) and fall
 * back to the registration, so a phone is never silently left without alerts.
 * The service worker's `notificationclick` handler routes taps from `data`.
 */
function showBrowserNotification(title: string, options: BrowserNotificationInit): Notification | null {
	try {
		return new Notification(title, options);
	} catch {
		void showViaServiceWorker(title, options);
		return null;
	}
}

async function showViaServiceWorker(title: string, options: BrowserNotificationInit): Promise<void> {
	try {
		if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
		const registration = await navigator.serviceWorker.ready;
		await registration.showNotification(title, options);
	} catch (error) {
		console.warn('[notifications] service worker notification failed:', error);
	}
}

export function showNotification(
	message: Message | SimpleNotification,
	isCurrentUser: boolean,
	channelName?: string,
	options?: {
		isMention?: boolean;
		isCurrentChannelActive?: boolean;
		onClick?: () => void;
		serverName?: string | null;
		iconUrl?: string | null;
		forceDesktop?: boolean;
		tagPrefix?: string;
	}
) {
	if (!browser) return;

	if (isCurrentUser) return;

	if (!areNotificationsEnabled()) {
		console.log('Notifications disabled in settings');
		return;
	}

	if (shouldSquelchNotification(message)) {
		return;
	}

	const nativeTauri = isTauriRuntime();
	const isMention = options?.isMention ?? false;
	const isCurrentChannelActive = options?.isCurrentChannelActive ?? false;
	const forceDesktop = options?.forceDesktop === true;
	const shouldPlaySound = forceDesktop || document.hidden || !isCurrentChannelActive || isMention;

	// Installed Tauri clients use the native notification plugin. Do not touch
	// the browser Notification global first: Android/iOS WebViews are not normal
	// browser tabs and may not expose it at all.
	if (!nativeTauri && !browserNotificationPermissionGranted()) {
		console.log('Notification permission not granted');
		return;
	}

	if (shouldPlaySound) {
		playNotificationSoundAudio(getNotificationSound(), getNotificationVolume());
	}

	if (!document.hidden && !forceDesktop) {
		console.log('Page is visible, skipping system notification');
		return;
	}

	let title = '';
	let body = '';
	const icon = options?.iconUrl?.trim() || '/icon-192.png';

	if ('title' in message && 'body' in message && !('user' in message)) {
		title = message.title;
		body = message.body;

		if (nativeTauri) {
			void sendTauriNotification(title, body);
			return;
		}

		// No auto-close: a notification the user looks at after a few seconds
		// must still be there. The OS (or the user) dismisses it.
		const notification = showBrowserNotification(title, { body, icon, badge: icon });
		if (notification && options?.onClick) {
			notification.addEventListener('click', options.onClick);
		}
		return;
	}

	const msg = message as Message;
	const showMessagePreview = isNotificationPreviewEnabled();
	const rawText = typeof msg.text === 'string' ? msg.text.trim() : '';
	const looksLikeCiphertext =
		rawText.length >= 48 &&
		!/[\s]/.test(rawText) &&
		/^[A-Za-z0-9+/=_-]+$/.test(rawText);
	const shouldHidePreview = Boolean(msg.encrypted || msg.iv || looksLikeCiphertext);
	const fallbackTitle = typeof (msg as unknown as { title?: string }).title === 'string'
		? String((msg as unknown as { title?: string }).title).trim()
		: '';
	const fallbackBody = typeof (msg as unknown as { body?: string }).body === 'string'
		? String((msg as unknown as { body?: string }).body).trim()
		: '';

	const locationParts: string[] = [];
	if (channelName) locationParts.push(`#${channelName}`);
	if (options?.serverName) locationParts.push(options.serverName);
	const locationSuffix =
		locationParts.length > 0
			? ` in ${locationParts[0]}${locationParts.length > 1 ? ` · ${locationParts.slice(1).join(' · ')}` : ''}`
			: options?.serverName
				? ` · ${options.serverName}`
				: '';
	const userPrefix = `${msg.user || 'Someone'}${locationSuffix}`;

	switch (msg.type) {
		case 'text':
			title = isMention ? `Mention from ${userPrefix}` : userPrefix;
			body = showMessagePreview && !shouldHidePreview ? msg.text : 'New message';
			break;
		case 'gif':
			title = userPrefix;
			body = showMessagePreview && !shouldHidePreview ? 'Sent a GIF' : 'New message';
			break;
		case 'file':
			title = userPrefix;
			body = showMessagePreview && !shouldHidePreview ? `Sent a file: ${msg.fileName}` : 'New message';
			break;
	}

	if (!title) {
		title = fallbackTitle || userPrefix || brandName;
	}
	if (!body) {
		body = fallbackBody || 'New activity';
	}

	if (nativeTauri) {
		void sendTauriNotification(title, body);
		return;
	}

	const rawChannelId = (msg as unknown as { channelId?: unknown }).channelId;
	const channelId = typeof rawChannelId === 'string' ? rawChannelId : '';
	const messageId = typeof msg.id === 'string' ? msg.id : '';
	const notification = showBrowserNotification(title, {
		body,
		icon,
		badge: icon,
		// One notification per conversation, updated (and re-announced) by each
		// new message, instead of a growing stack of per-message entries.
		tag: `${options?.tagPrefix || 'message'}-${channelId || messageId || fallbackTitle || 'activity'}`,
		renotify: true,
		// Mentions stay until acted on (desktop honours this; Android ignores it).
		requireInteraction: isMention,
		silent: false,
		data: {
			...(channelId ? { wabiNav: 'channel', channelId } : {}),
			...(messageId ? { messageId } : {})
		}
	});
	if (!notification) return;

	notification.onclick = () => {
		window.focus();
		options?.onClick?.();
		notification.close();
	};
	// Deliberately no auto-close timer: notifications that vanish after five
	// seconds are not "sticking". The OS or the user dismisses them.
}

export function showCallNotification(
	callerName: string,
	isVideoCall: boolean,
	onAnswer?: () => void,
	onReject?: () => void
) {
	if (!browser) return null;

	if (!areNotificationsEnabled()) {
		console.log('Notifications disabled in settings');
		return null;
	}

	const title = `Incoming ${isVideoCall ? 'Video' : 'Voice'} Call`;
	const body = `${callerName} is calling...`;
	const icon = '/icon-192.png';

	if (isTauriRuntime()) {
		void sendTauriNotification(title, body);
		return null;
	}

	if (!browserNotificationPermissionGranted()) {
		console.log('Notification permission not granted');
		return null;
	}

	// A ringing call must persist until answered or declined. CallModal closes
	// the returned notification when the call ends or is answered.
	const notification = showBrowserNotification(title, {
		body,
		icon,
		badge: icon,
		tag: `call-${callerName}`,
		renotify: true,
		requireInteraction: true,
		silent: false,
		data: { wabiNav: 'messages' }
	});
	if (!notification) return null;

	notification.onclick = () => {
		window.focus();
		if (onAnswer) onAnswer();
		notification.close();
	};

	return notification;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!browser) return 'denied';

	if (isTauriRuntime()) {
		const { requestTauriNotificationPermission } = await import('$lib/tauri-notifications');
		const granted = await requestTauriNotificationPermission();
		return granted ? 'granted' : 'denied';
	}

	if (!('Notification' in window)) return 'denied';
	if (Notification.permission === 'granted') return 'granted';
	return Notification.requestPermission();
}

export function playNotificationSound() {
	playNotificationSoundAudio(getNotificationSound(), getNotificationVolume());
}

export function playCallRingtone() {
	const mode = getCallRingtoneMode();
	const volume = getCallRingtoneVolume();
	const customAudio = getCallRingtoneCustomAudio();
	const customSynthPreset = getStoredCustomSynthRingtonePreset();
	playCallRingtoneAudio(mode, volume, customAudio, customSynthPreset);
}
