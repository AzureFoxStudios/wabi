import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { getAuthToken, getGuestSessionId, getStoredDbUserId, getStoredUsername } from './authSession';
import { pollFollowedChannelActivity, type FollowedChannelPollChannelResult } from './api';
import { followingPreferences, type FollowAlertLevel, type FollowedChannelPreference } from './following';
import {
	followSnapshots,
	recordFollowedMessageActivity,
	syncFollowedChannelSnapshot,
	type FollowedChannelSnapshot
} from './followingSnapshots';
import { messageMentionsUser, showNotification } from './notifications';
import { savedServers, switchToSavedServerChannel } from './savedServers';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';
import type { Channel, Message } from './socket-types';

const VISIBLE_POLL_INTERVAL_MS = 45_000;
const HIDDEN_POLL_INTERVAL_MS = 25_000;
const STARTUP_DELAY_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const AUTH_BACKOFF_MS = 5 * 60_000;

let started = false;
let pollInFlight = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const serverCooldownUntil = new Map<string, number>();

function clearPollTimer(): void {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
}

function getNextDelay(): number {
	if (!browser) return VISIBLE_POLL_INTERVAL_MS;
	return document.hidden ? HIDDEN_POLL_INTERVAL_MS : VISIBLE_POLL_INTERVAL_MS;
}

function schedulePoll(delay = getNextDelay()): void {
	clearPollTimer();
	if (!started) return;
	pollTimer = setTimeout(() => {
		void runPollCycle();
	}, Math.max(1_000, delay));
}

function getActiveServerUrl(): string | null {
	return normalizeServerUrl(resolveServerUrl().url);
}

function buildChannelSummary(result: FollowedChannelPollChannelResult): Pick<Channel, 'id' | 'name' | 'type'> {
	return {
		id: result.channelId,
		name: result.channelName,
		type: result.channelType as Channel['type']
	};
}

function isOwnMessageForServer(serverUrl: string, message: Message): boolean {
	const storedDbUserId = getStoredDbUserId(serverUrl);
	if (typeof storedDbUserId === 'number' && message.userId === `user-${storedDbUserId}`) {
		return true;
	}

	const storedUsername = getStoredUsername(serverUrl);
	return Boolean(storedUsername && message.user === storedUsername);
}

function shouldNotifyForAlertLevel(
	alertLevel: FollowAlertLevel,
	message: Message,
	storedUsername: string | null
): boolean {
	if (alertLevel === 'off') return false;
	if (alertLevel === 'all') return true;
	return messageMentionsUser(message, storedUsername);
}

function getSnapshot(
	serverUrl: string,
	channelId: string
): FollowedChannelSnapshot | null {
	const state = get(followSnapshots);
	return state[serverUrl]?.[channelId] || null;
}

function getSavedServerMeta(serverUrl: string): {
	serverName: string | null;
	iconUrl: string | null;
} {
	const server = get(savedServers).find((entry) => entry.url === serverUrl) || null;
	return {
		serverName: server?.effectiveName || null,
		iconUrl: server?.effectiveIconUrl || null
	};
}

function applyBootstrapSnapshot(
	serverUrl: string,
	channel: Pick<Channel, 'id' | 'name' | 'type'>,
	messages: Message[],
	serverName: string | null
): void {
	const existingUnreadCount = getSnapshot(serverUrl, channel.id)?.unreadCount || 0;
	syncFollowedChannelSnapshot(serverUrl, serverName, channel, messages, existingUnreadCount);
}

function applyMessageDelta(
	serverUrl: string,
	channel: Pick<Channel, 'id' | 'name' | 'type'>,
	message: Message,
	serverName: string | null
): boolean {
	const isOwnMessage = isOwnMessageForServer(serverUrl, message);
	recordFollowedMessageActivity({
		serverUrl,
		serverName,
		channel,
		message,
		incrementUnread: !isOwnMessage
	});
	return isOwnMessage;
}

function maybeNotifyForResult(
	serverUrl: string,
	preference: FollowedChannelPreference,
	result: FollowedChannelPollChannelResult,
	serverName: string | null,
	iconUrl: string | null
): void {
	const storedUsername = getStoredUsername(serverUrl);
	const qualifying = result.messages.filter((message) => {
		if (isOwnMessageForServer(serverUrl, message)) return false;
		return shouldNotifyForAlertLevel(preference.alertLevel, message, storedUsername);
	});
	if (qualifying.length === 0) return;

	const latest = qualifying[qualifying.length - 1];
	const isMention = messageMentionsUser(latest, storedUsername);
	showNotification(latest, false, result.channelName, {
		isMention,
		isCurrentChannelActive: false,
		forceDesktop: true,
		serverName,
		iconUrl,
		tagPrefix: `follow:${encodeURIComponent(serverUrl)}`,
		onClick: () => {
			switchToSavedServerChannel(serverUrl, result.channelId);
		}
	});
}

async function pollServer(
	serverUrl: string,
	serverPreferences: Record<string, FollowedChannelPreference>
): Promise<void> {
	const token = getAuthToken(serverUrl);
	const guestSessionId = token ? null : getGuestSessionId(serverUrl);
	if (!token && !guestSessionId) return;

	const now = Date.now();
	const cooldownUntil = serverCooldownUntil.get(serverUrl) || 0;
	if (cooldownUntil > now) return;

	const activeServerUrl = getActiveServerUrl();
	if (activeServerUrl && activeServerUrl === serverUrl) return;

	const requests = Object.values(serverPreferences).map((preference) => {
		const snapshot = getSnapshot(serverUrl, preference.channelId);
		return {
			channelId: preference.channelId,
			afterMessageId: snapshot?.lastMessageId || null,
			limit: snapshot?.lastMessageId ? 6 : 1
		};
	});
	if (requests.length === 0) return;

	const { serverName, iconUrl } = getSavedServerMeta(serverUrl);

	try {
		const response = await pollFollowedChannelActivity(serverUrl, token, guestSessionId, requests);
		serverCooldownUntil.delete(serverUrl);

		for (const result of response.channels) {
			const preference = serverPreferences[result.channelId];
			if (!preference || result.messages.length === 0) continue;

			const channel = buildChannelSummary(result);
			const snapshot = getSnapshot(serverUrl, result.channelId);
			if (result.cursorReset || !snapshot?.lastMessageId) {
				applyBootstrapSnapshot(serverUrl, channel, result.messages, serverName);
				continue;
			}

			for (const message of result.messages) {
				applyMessageDelta(serverUrl, channel, message, serverName);
			}

			maybeNotifyForResult(serverUrl, preference, result, serverName, iconUrl);
		}
	} catch (error) {
		const status = typeof error === 'object' && error !== null && 'status' in error
			? Number((error as { status?: number }).status)
			: null;
		serverCooldownUntil.set(
			serverUrl,
			now + ((status === 401 || status === 403) ? AUTH_BACKOFF_MS : ERROR_BACKOFF_MS)
		);
		console.warn(`[FollowNotifier] Poll failed for ${serverUrl}:`, error);
	}
}

async function runPollCycle(): Promise<void> {
	if (!started || pollInFlight || !browser) {
		schedulePoll();
		return;
	}

	pollInFlight = true;
	try {
		const preferenceState = get(followingPreferences);
		const tasks = Object.entries(preferenceState).map(([serverUrl, serverPreferences]) =>
			pollServer(serverUrl, serverPreferences)
		);
		await Promise.allSettled(tasks);
	} finally {
		pollInFlight = false;
		schedulePoll();
	}
}

function handleVisibilityChange(): void {
	if (!started) return;
	schedulePoll(2_000);
}

export function startFollowNotificationPoller(): () => void {
	if (!browser || started) {
		return () => {};
	}

	started = true;
	document.addEventListener('visibilitychange', handleVisibilityChange);
	schedulePoll(STARTUP_DELAY_MS);

	return () => {
		started = false;
		clearPollTimer();
		document.removeEventListener('visibilitychange', handleVisibilityChange);
	};
}
