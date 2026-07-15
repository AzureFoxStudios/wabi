import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

import type { Message } from '$lib/socket-types';

export type TimestampDisplayMode = 'compact' | 'complete' | 'detailed';
export type RevealAllSpoilersMinRole = 'guest' | 'member' | 'mod' | 'admin' | 'owner';

/**
 * A message timestamp is only meaningful if it is a finite, positive number.
 * `new Date(undefined/NaN)` yields the literal "Invalid Date" string, which is
 * what produced the "U / Unknown user / Invalid Date" rows in chat.
 */
export function isValidMessageTimestamp(timestamp: unknown): boolean {
	return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0;
}

/**
 * A message is renderable only if it has a stable id, a valid timestamp, and
 * some notion of sender identity (or is a local/system card). Messages missing
 * any of these are corrupted/orphaned and should not be shown as chat rows.
 */
export function isRenderableMessage(message: Message | null | undefined): boolean {
	if (!message) return false;
	if (!message.id) return false;
	// Soft-deleted messages (orphaned/ghost rows) must never render as chat rows.
	if (message.isDeleted) return false;
	if (!isValidMessageTimestamp(message.timestamp)) return false;
	const hasIdentity = Boolean(
		message.userId || message.user || message.senderStableId || message.localCard
	);
	return hasIdentity;
}

export interface DisplayEnhancementSettings {
	clickableMentionsEnabled: boolean;
	timestampDisplayMode: TimestampDisplayMode;
	revealAllSpoilersEnabled: boolean;
	revealAllSpoilersMinRole: RevealAllSpoilersMinRole;
	betterSearchPageEnabled: boolean;
	googleSearchReplaceEnabled: boolean;
	hideMutedCategoriesEnabled: boolean;
	mutedChannelIds: string[];
	spotifyControlsEnabled: boolean;
	localNicknamesEnabled: boolean;
	readAllNotificationsButtonEnabled: boolean;
	serverCounterEnabled: boolean;
	betterNsfwTagEnabled: boolean;
	customStatusPresetsEnabled: boolean;
	quickMentionEnabled: boolean;
	personalPinsEnabled: boolean;
	lastMessageDateEnabled: boolean;
	showConnectionsEnabled: boolean;
	userNotesEnabled: boolean;
	friendNotificationsEnabled: boolean;
	friendNotificationsTrackedOnly: boolean;
	friendNotificationTrackedUserIds: string[];
	messageUtilitiesEnabled: boolean;
	betterFriendListEnabled: boolean;
	emojiStatisticsEnabled: boolean;
	removeNicknamesEnabled: boolean;
	staffTagEnabled: boolean;
	topRoleEverywhereEnabled: boolean;
}

const DISPLAY_ENHANCEMENT_SETTINGS_KEY = 'wabi.displayEnhancements.settings';

const DEFAULT_DISPLAY_ENHANCEMENT_SETTINGS: DisplayEnhancementSettings = {
	clickableMentionsEnabled: true,
	timestampDisplayMode: 'compact',
	revealAllSpoilersEnabled: true,
	revealAllSpoilersMinRole: 'member',
	betterSearchPageEnabled: true,
	googleSearchReplaceEnabled: true,
	hideMutedCategoriesEnabled: false,
	mutedChannelIds: [],
	spotifyControlsEnabled: true,
	localNicknamesEnabled: true,
	readAllNotificationsButtonEnabled: true,
	serverCounterEnabled: true,
	betterNsfwTagEnabled: true,
	customStatusPresetsEnabled: true,
	quickMentionEnabled: true,
	personalPinsEnabled: true,
	lastMessageDateEnabled: true,
	showConnectionsEnabled: true,
	userNotesEnabled: true,
	friendNotificationsEnabled: false,
	friendNotificationsTrackedOnly: true,
	friendNotificationTrackedUserIds: [],
	messageUtilitiesEnabled: true,
	betterFriendListEnabled: true,
	emojiStatisticsEnabled: true,
	removeNicknamesEnabled: false,
	staffTagEnabled: true,
	topRoleEverywhereEnabled: true
};

function normalizeTimestampDisplayMode(value: unknown): TimestampDisplayMode {
	if (value === 'complete' || value === 'detailed') return value;
	return 'compact';
}

function normalizeRevealRole(value: unknown): RevealAllSpoilersMinRole {
	if (
		value === 'guest' ||
		value === 'member' ||
		value === 'mod' ||
		value === 'admin' ||
		value === 'owner'
	) {
		return value;
	}
	return 'member';
}

function sanitizeDisplayEnhancementSettings(
	input: Partial<DisplayEnhancementSettings> | null | undefined
): DisplayEnhancementSettings {
	const base = input || {};
	const trackedUsers = Array.isArray(base.friendNotificationTrackedUserIds)
		? base.friendNotificationTrackedUserIds
			.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
			.filter(Boolean)
			.filter((entry, index, array) => array.indexOf(entry) === index)
		: [];
	const mutedChannelIds = Array.isArray(base.mutedChannelIds)
		? base.mutedChannelIds
			.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
			.filter(Boolean)
			.filter((entry, index, array) => array.indexOf(entry) === index)
		: [];
	return {
		clickableMentionsEnabled: base.clickableMentionsEnabled !== false,
		timestampDisplayMode: normalizeTimestampDisplayMode(base.timestampDisplayMode),
		revealAllSpoilersEnabled: base.revealAllSpoilersEnabled !== false,
		revealAllSpoilersMinRole: normalizeRevealRole(base.revealAllSpoilersMinRole),
		betterSearchPageEnabled: base.betterSearchPageEnabled !== false,
		googleSearchReplaceEnabled: base.googleSearchReplaceEnabled !== false,
		hideMutedCategoriesEnabled: base.hideMutedCategoriesEnabled === true,
		mutedChannelIds,
		spotifyControlsEnabled: base.spotifyControlsEnabled !== false,
		localNicknamesEnabled: base.localNicknamesEnabled !== false,
		readAllNotificationsButtonEnabled: base.readAllNotificationsButtonEnabled !== false,
		serverCounterEnabled: base.serverCounterEnabled !== false,
		betterNsfwTagEnabled: base.betterNsfwTagEnabled !== false,
		customStatusPresetsEnabled: base.customStatusPresetsEnabled !== false,
		quickMentionEnabled: base.quickMentionEnabled !== false,
		personalPinsEnabled: base.personalPinsEnabled !== false,
		lastMessageDateEnabled: base.lastMessageDateEnabled !== false,
		showConnectionsEnabled: base.showConnectionsEnabled !== false,
		userNotesEnabled: base.userNotesEnabled !== false,
		friendNotificationsEnabled: base.friendNotificationsEnabled === true,
		friendNotificationsTrackedOnly: base.friendNotificationsTrackedOnly !== false,
		friendNotificationTrackedUserIds: trackedUsers,
		messageUtilitiesEnabled: base.messageUtilitiesEnabled !== false,
		betterFriendListEnabled: base.betterFriendListEnabled !== false,
		emojiStatisticsEnabled: base.emojiStatisticsEnabled !== false,
		removeNicknamesEnabled: base.removeNicknamesEnabled === true,
		staffTagEnabled: base.staffTagEnabled !== false,
		topRoleEverywhereEnabled: base.topRoleEverywhereEnabled !== false
	};
}

function safeReadSettings(): DisplayEnhancementSettings {
	if (!browser) return { ...DEFAULT_DISPLAY_ENHANCEMENT_SETTINGS };
	try {
		const raw = localStorage.getItem(DISPLAY_ENHANCEMENT_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_DISPLAY_ENHANCEMENT_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<DisplayEnhancementSettings>;
		return sanitizeDisplayEnhancementSettings(parsed);
	} catch {
		return { ...DEFAULT_DISPLAY_ENHANCEMENT_SETTINGS };
	}
}

function safeWriteSettings(settings: DisplayEnhancementSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(DISPLAY_ENHANCEMENT_SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// best-effort persistence
	}
}

export const displayEnhancementSettingsStore = writable<DisplayEnhancementSettings>(
	safeReadSettings()
);

if (browser) {
	displayEnhancementSettingsStore.subscribe((settings) => {
		safeWriteSettings(sanitizeDisplayEnhancementSettings(settings));
	});
}

export function getDisplayEnhancementSettings(): DisplayEnhancementSettings {
	return get(displayEnhancementSettingsStore);
}

export function setClickableMentionsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			clickableMentionsEnabled: enabled
		})
	);
}

export function setTimestampDisplayMode(mode: TimestampDisplayMode): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			timestampDisplayMode: mode
		})
	);
}

export function setRevealAllSpoilersEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			revealAllSpoilersEnabled: enabled
		})
	);
}

export function setRevealAllSpoilersMinRole(role: RevealAllSpoilersMinRole): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			revealAllSpoilersMinRole: role
		})
	);
}

export function setBetterSearchPageEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			betterSearchPageEnabled: enabled
		})
	);
}

export function setGoogleSearchReplaceEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			googleSearchReplaceEnabled: enabled
		})
	);
}

export function setHideMutedCategoriesEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			hideMutedCategoriesEnabled: enabled
		})
	);
}

export function setMutedChannelIds(channelIds: string[]): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			mutedChannelIds: channelIds
		})
	);
}

export function setSpotifyControlsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			spotifyControlsEnabled: enabled
		})
	);
}

export function setLocalNicknamesEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			localNicknamesEnabled: enabled
		})
	);
}

export function toggleMutedChannelId(channelId: string): void {
	const normalized = channelId.trim();
	if (!normalized) return;
	displayEnhancementSettingsStore.update((current) => {
		const next = current.mutedChannelIds.includes(normalized)
			? current.mutedChannelIds.filter((id) => id !== normalized)
			: [...current.mutedChannelIds, normalized];
		return sanitizeDisplayEnhancementSettings({
			...current,
			mutedChannelIds: next
		});
	});
}

export function clearMutedChannelIds(): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			mutedChannelIds: []
		})
	);
}

export function setReadAllNotificationsButtonEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			readAllNotificationsButtonEnabled: enabled
		})
	);
}

export function setServerCounterEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			serverCounterEnabled: enabled
		})
	);
}

export function setBetterNsfwTagEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			betterNsfwTagEnabled: enabled
		})
	);
}

export function setCustomStatusPresetsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			customStatusPresetsEnabled: enabled
		})
	);
}

export function setQuickMentionEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			quickMentionEnabled: enabled
		})
	);
}

export function setPersonalPinsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			personalPinsEnabled: enabled
		})
	);
}

export function setLastMessageDateEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			lastMessageDateEnabled: enabled
		})
	);
}

export function setShowConnectionsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			showConnectionsEnabled: enabled
		})
	);
}

export function setUserNotesEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			userNotesEnabled: enabled
		})
	);
}

export function setFriendNotificationsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			friendNotificationsEnabled: enabled
		})
	);
}

export function setFriendNotificationsTrackedOnly(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			friendNotificationsTrackedOnly: enabled
		})
	);
}

export function setFriendNotificationTrackedUserIds(userIds: string[]): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			friendNotificationTrackedUserIds: userIds
		})
	);
}

export function toggleFriendNotificationTrackedUserId(userId: string): void {
	const normalized = userId.trim();
	if (!normalized) return;
	displayEnhancementSettingsStore.update((current) => {
		const next = current.friendNotificationTrackedUserIds.includes(normalized)
			? current.friendNotificationTrackedUserIds.filter((id) => id !== normalized)
			: [...current.friendNotificationTrackedUserIds, normalized];
		return sanitizeDisplayEnhancementSettings({
			...current,
			friendNotificationTrackedUserIds: next
		});
	});
}

export function clearFriendNotificationTrackedUserIds(): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			friendNotificationTrackedUserIds: []
		})
	);
}

export function setMessageUtilitiesEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			messageUtilitiesEnabled: enabled
		})
	);
}

export function setBetterFriendListEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			betterFriendListEnabled: enabled
		})
	);
}

export function setEmojiStatisticsEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			emojiStatisticsEnabled: enabled
		})
	);
}

export function setRemoveNicknamesEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			removeNicknamesEnabled: enabled
		})
	);
}

export function setStaffTagEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			staffTagEnabled: enabled
		})
	);
}

export function setTopRoleEverywhereEnabled(enabled: boolean): void {
	displayEnhancementSettingsStore.update((current) =>
		sanitizeDisplayEnhancementSettings({
			...current,
			topRoleEverywhereEnabled: enabled
		})
	);
}

export function formatTimestampForDisplay(
	timestamp: number,
	mode: TimestampDisplayMode,
	locale = 'en-US'
): string {
	const date = new Date(timestamp);
	if (mode === 'detailed') {
		return date.toLocaleString(locale, {
			weekday: 'short',
			month: 'short',
			day: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}
	if (mode === 'complete') {
		return date.toLocaleString(locale, {
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
	return date.toLocaleTimeString(locale, {
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function isLikelyNsfwChannel(channelName: string, channelDescription?: string): boolean {
	const token = /(^|[^a-z0-9])nsfw([^a-z0-9]|$)/i;
	if (token.test(channelName || '')) return true;
	if (channelDescription && token.test(channelDescription)) return true;
	return false;
}
