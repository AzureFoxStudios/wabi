/**
 * notificationDisplay.ts
 * Notification display and message handling
 */

import { browser } from '$app/environment';
import { brandName } from '$lib/branding';
import type { Message } from '$lib/socket-types';
import { isDesktopTauri } from '$lib/tauri-platform';
import { sendTauriDesktopNotification } from '$lib/tauri-notifications';
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

	const isMention = options?.isMention ?? false;
	const isCurrentChannelActive = options?.isCurrentChannelActive ?? false;
	const forceDesktop = options?.forceDesktop === true;
	const shouldPlaySound = forceDesktop || document.hidden || !isCurrentChannelActive || isMention;

	if (Notification.permission !== 'granted') {
		console.log('Notification permission not granted:', Notification.permission);
		return;
	}

	if (shouldPlaySound) {
		playNotificationSoundAudio(getNotificationSound(), getNotificationVolume());
	}

	if (!document.hidden && !forceDesktop) {
		console.log('Page is visible, skipping desktop notification');
		return;
	}

	let title = '';
	let body = '';
	let icon = options?.iconUrl?.trim() || '/icon-192.png';

	if ('title' in message && 'body' in message && !('user' in message)) {
		title = message.title;
		body = message.body;

		if (isDesktopTauri()) {
			void sendTauriDesktopNotification(title, body);
			return;
		}

		if (Notification.permission !== 'granted') {
			console.log('Notification permission not granted:', Notification.permission);
			return;
		}

		if (!document.hidden && !forceDesktop) {
			console.log('Page is visible, skipping desktop notification');
			return;
		}

		const notification = new Notification(title, { body, icon });
		if (options?.onClick) {
			notification.addEventListener('click', options.onClick);
		}
		setTimeout(() => {
			notification.close();
		}, 5000);
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

	if (isDesktopTauri()) {
		void sendTauriDesktopNotification(title, body);
		return;
	}

	const notification = new Notification(title, {
		body,
		icon,
		badge: icon,
		tag: `${options?.tagPrefix || 'message'}-${msg.id || fallbackTitle || 'activity'}`,
		requireInteraction: false,
		silent: false
	});

	notification.onclick = () => {
		window.focus();
		options?.onClick?.();
		notification.close();
	};

	setTimeout(() => {
		notification.close();
	}, 5000);
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

	if (Notification.permission !== 'granted') {
		console.log('Notification permission not granted');
		return null;
	}

	const title = `Incoming ${isVideoCall ? 'Video' : 'Voice'} Call`;
	const body = `${callerName} is calling...`;
	const icon = '/icon-192.png';

	if (isDesktopTauri()) {
		void sendTauriDesktopNotification(title, body);
		return null;
	}

	const notification = new Notification(title, {
		body,
		icon,
		badge: icon,
		tag: `call-${callerName}`,
		requireInteraction: false,
		silent: false
	});

	notification.onclick = () => {
		window.focus();
		if (onAnswer) onAnswer();
		notification.close();
	};

	return notification;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!browser) return 'denied';

	if (isDesktopTauri()) {
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
