/**
 * notificationSettings.ts
 * Notification and audio settings management
 */

import { browser } from '$app/environment';
import type { CallRingtoneMode, CustomSynthRingtonePreset } from './notificationAudio';
import { getDefaultCustomSynthRingtonePreset, sanitizeCustomSynthRingtonePreset } from './notificationAudio';

const DEFAULT_NOTIFICATION_SOUND = '/sounds/ProjectSound.ogg';
const DEFAULT_NOTIFICATION_VOLUME = 0.5;
const DEFAULT_CALL_RINGTONE_MODE: CallRingtoneMode = 'classic-bell';
const DEFAULT_CALL_RINGTONE_VOLUME = 0.65;

export function getNotificationSound(): string {
	if (!browser) return DEFAULT_NOTIFICATION_SOUND;
	return localStorage.getItem('notificationSound') || DEFAULT_NOTIFICATION_SOUND;
}

export function getNotificationVolume(): number {
	if (!browser) return DEFAULT_NOTIFICATION_VOLUME;
	const volume = localStorage.getItem('notificationVolume');
	return volume ? parseFloat(volume) : DEFAULT_NOTIFICATION_VOLUME;
}

export function getCallRingtoneMode(): CallRingtoneMode {
	if (!browser) return DEFAULT_CALL_RINGTONE_MODE;
	const storedMode = localStorage.getItem('callRingtoneMode');
	const CALL_RINGTONE_MODES: CallRingtoneMode[] = ['classic-bell', 'soft-chime', 'pulse', 'custom-synth', 'custom-audio'];
	if (storedMode && CALL_RINGTONE_MODES.includes(storedMode as CallRingtoneMode)) {
		return storedMode as CallRingtoneMode;
	}
	return DEFAULT_CALL_RINGTONE_MODE;
}

export function getCallRingtoneCustomAudio(): string | null {
	if (!browser) return null;
	const value = localStorage.getItem('callRingtoneCustomAudio');
	return value && value.startsWith('data:audio') ? value : null;
}

export function getStoredCustomSynthRingtonePreset(): CustomSynthRingtonePreset {
	if (!browser) return getDefaultCustomSynthRingtonePreset();
	const raw = localStorage.getItem('callRingtoneCustomSynth');
	if (!raw) return getDefaultCustomSynthRingtonePreset();
	try {
		return sanitizeCustomSynthRingtonePreset(JSON.parse(raw));
	} catch (error) {
		console.warn('Failed to parse custom synth ringtone preset:', error);
		return getDefaultCustomSynthRingtonePreset();
	}
}

export function getCallRingtoneVolume(): number {
	if (!browser) return DEFAULT_CALL_RINGTONE_VOLUME;
	const stored = localStorage.getItem('callRingtoneVolume');
	const parsed = stored ? parseFloat(stored) : DEFAULT_CALL_RINGTONE_VOLUME;
	if (!Number.isFinite(parsed)) {
		return DEFAULT_CALL_RINGTONE_VOLUME;
	}
	return Math.min(1, Math.max(0, parsed));
}

export function getNotificationSquelchSettings() {
	if (!browser) {
		return {
			suppressEveryoneHere: false,
			suppressRoleMentions: false
		};
	}

	return {
		suppressEveryoneHere: localStorage.getItem('suppressEveryoneHereMentions') === 'true',
		suppressRoleMentions: localStorage.getItem('suppressRoleMentions') === 'true'
	};
}

export function areNotificationsEnabled(): boolean {
	if (!browser) return true;
	return localStorage.getItem('notificationsEnabled') !== 'false';
}

export function isNotificationPreviewEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem('notificationPreviewEnabled') === 'true';
}
