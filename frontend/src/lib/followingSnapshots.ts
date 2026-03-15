import { browser } from '$app/environment';
import { derived, writable, type Readable } from 'svelte/store';
import type { Channel, Message } from './socket-types';
import { followingPreferences } from './following';
import { normalizeServerUrl } from './serverUrl';

const FOLLOW_SNAPSHOTS_STORAGE_KEY = 'wabi.followingSnapshots.v1';
const MAX_PREVIEW_MESSAGES = 4;
const MAX_PREVIEW_TEXT_LENGTH = 240;

export interface FollowPreviewMessage {
	id: string;
	user: string;
	text: string;
	timestamp: number;
	type: Message['type'];
}

export interface FollowedChannelSnapshot {
	serverUrl: string;
	serverName: string | null;
	channelId: string;
	channelName: string;
	channelType: Channel['type'] | undefined;
	lastMessageId: string | null;
	unreadCount: number;
	lastActivityAt: number;
	updatedAt: number;
	previewMessages: FollowPreviewMessage[];
}

type FollowSnapshotState = Record<string, Record<string, FollowedChannelSnapshot>>;

const DEFAULT_STATE: FollowSnapshotState = {};

function summarizeMessage(message: Message): string {
	const text = String(message.text || '').trim();
	if (text) {
		return text.slice(0, MAX_PREVIEW_TEXT_LENGTH);
	}
	if (message.type === 'gif') return 'Shared a GIF';
	if (message.type === 'emoji') return `Reacted with ${message.emojiName || 'an emoji'}`;
	if (message.type === 'file') {
		if (message.files?.length) {
			return `Shared ${message.files.length} files`;
		}
		return `Shared ${message.fileName || 'a file'}`;
	}
	if (message.type === 'role_gate') return 'Updated channel access';
	return 'Sent a message';
}

function toPreviewMessage(message: Message): FollowPreviewMessage {
	return {
		id: message.id,
		user: message.user,
		text: summarizeMessage(message),
		timestamp: message.timestamp,
		type: message.type
	};
}

function sanitizePreviewMessage(raw: unknown): FollowPreviewMessage | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const id = typeof candidate.id === 'string' ? candidate.id : '';
	const user = typeof candidate.user === 'string' ? candidate.user : '';
	const text = typeof candidate.text === 'string' ? candidate.text : '';
	const timestamp =
		typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
			? candidate.timestamp
			: 0;
	const type =
		candidate.type === 'gif' ||
		candidate.type === 'file' ||
		candidate.type === 'emoji' ||
		candidate.type === 'role_gate'
			? candidate.type
			: 'text';

	if (!id || !user || !timestamp) return null;

	return { id, user, text, timestamp, type };
}

function sanitizeSnapshot(raw: unknown, serverUrl: string, channelId: string): FollowedChannelSnapshot | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const previewMessages = Array.isArray(candidate.previewMessages)
		? candidate.previewMessages
				.map((entry) => sanitizePreviewMessage(entry))
				.filter(Boolean)
				.slice(-MAX_PREVIEW_MESSAGES) as FollowPreviewMessage[]
		: [];

	return {
		serverUrl,
		serverName: typeof candidate.serverName === 'string' && candidate.serverName.trim() ? candidate.serverName.trim() : null,
		channelId,
		channelName: typeof candidate.channelName === 'string' ? candidate.channelName : channelId,
		channelType:
			candidate.channelType === 'group' ||
			candidate.channelType === 'dm' ||
			candidate.channelType === 'voice' ||
			candidate.channelType === 'public' ||
			candidate.channelType === 'thread_public' ||
			candidate.channelType === 'thread_private'
				? candidate.channelType
				: 'text',
		lastMessageId:
			typeof candidate.lastMessageId === 'string' && candidate.lastMessageId.trim()
				? candidate.lastMessageId.trim()
				: previewMessages[previewMessages.length - 1]?.id || null,
		unreadCount:
			typeof candidate.unreadCount === 'number' && Number.isFinite(candidate.unreadCount)
				? Math.max(0, Math.floor(candidate.unreadCount))
				: 0,
		lastActivityAt:
			typeof candidate.lastActivityAt === 'number' && Number.isFinite(candidate.lastActivityAt)
				? candidate.lastActivityAt
				: 0,
		updatedAt:
			typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
				? candidate.updatedAt
				: 0,
		previewMessages
	};
}

function sanitizeState(raw: unknown): FollowSnapshotState {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return DEFAULT_STATE;
	}

	const next: FollowSnapshotState = {};
	for (const [serverUrl, value] of Object.entries(raw as Record<string, unknown>)) {
		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl || !value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}

		const channelMap: Record<string, FollowedChannelSnapshot> = {};
		for (const [channelId, channelValue] of Object.entries(value as Record<string, unknown>)) {
			if (!channelId) continue;
			const snapshot = sanitizeSnapshot(channelValue, normalizedServerUrl, channelId);
			if (snapshot) {
				channelMap[channelId] = snapshot;
			}
		}

		if (Object.keys(channelMap).length > 0) {
			next[normalizedServerUrl] = channelMap;
		}
	}

	return next;
}

function loadState(): FollowSnapshotState {
	if (!browser) return DEFAULT_STATE;
	try {
		const raw = localStorage.getItem(FOLLOW_SNAPSHOTS_STORAGE_KEY);
		if (!raw) return DEFAULT_STATE;
		return sanitizeState(JSON.parse(raw));
	} catch {
		return DEFAULT_STATE;
	}
}

function persistState(state: FollowSnapshotState): void {
	if (!browser) return;
	try {
		localStorage.setItem(FOLLOW_SNAPSHOTS_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// best effort only
	}
}

function pruneStateToPreferences(state: FollowSnapshotState, preferenceState: Record<string, Record<string, unknown>>): FollowSnapshotState {
	const next: FollowSnapshotState = {};
	for (const [serverUrl, channels] of Object.entries(state)) {
		const allowed = preferenceState[serverUrl];
		if (!allowed) continue;

		const channelMap: Record<string, FollowedChannelSnapshot> = {};
		for (const [channelId, snapshot] of Object.entries(channels)) {
			if (allowed[channelId]) {
				channelMap[channelId] = snapshot;
			}
		}

		if (Object.keys(channelMap).length > 0) {
			next[serverUrl] = channelMap;
		}
	}
	return next;
}

function updateSnapshot(
	state: FollowSnapshotState,
	serverUrl: string,
	channelId: string,
	mutator: (current: FollowedChannelSnapshot | null) => FollowedChannelSnapshot | null
): FollowSnapshotState {
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl || !channelId.trim()) return state;

	const currentServerState = state[normalizedServerUrl] || {};
	const currentSnapshot = currentServerState[channelId] || null;
	const nextSnapshot = mutator(currentSnapshot);
	const nextState: FollowSnapshotState = {
		...state,
		[normalizedServerUrl]: { ...currentServerState }
	};

	if (!nextSnapshot) {
		delete nextState[normalizedServerUrl][channelId];
		if (Object.keys(nextState[normalizedServerUrl]).length === 0) {
			delete nextState[normalizedServerUrl];
		}
		return nextState;
	}

	nextState[normalizedServerUrl][channelId] = nextSnapshot;
	return nextState;
}

export const followSnapshots = writable<FollowSnapshotState>(loadState());

if (browser) {
	followSnapshots.subscribe((value) => {
		persistState(value);
	});

	followingPreferences.subscribe((value) => {
		followSnapshots.update((current) => pruneStateToPreferences(current, value));
	});
}

export const followedChannelSnapshots: Readable<FollowedChannelSnapshot[]> = derived(
	followSnapshots,
	($followSnapshots) =>
		Object.values($followSnapshots)
			.flatMap((channels) => Object.values(channels))
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
);

export const followUnreadCountsByServer: Readable<Record<string, number>> = derived(
	followSnapshots,
	($followSnapshots) => {
		const next: Record<string, number> = {};
		for (const [serverUrl, channels] of Object.entries($followSnapshots)) {
			next[serverUrl] = Object.values(channels).reduce((sum, snapshot) => sum + snapshot.unreadCount, 0);
		}
		return next;
	}
);

export function syncFollowedChannelSnapshot(
	serverUrl: string,
	serverName: string | null,
	channel: Pick<Channel, 'id' | 'name' | 'type'>,
	messages: Message[],
	unreadCount = 0
): void {
	const previewMessages = messages
		.slice(-MAX_PREVIEW_MESSAGES)
		.map((message) => toPreviewMessage(message));
	const lastMessage = messages[messages.length - 1];

	followSnapshots.update((state) =>
		updateSnapshot(state, serverUrl, channel.id, (current) => ({
			serverUrl: normalizeServerUrl(serverUrl) || serverUrl,
			serverName,
			channelId: channel.id,
			channelName: channel.name,
			channelType: channel.type,
			lastMessageId: lastMessage?.id || current?.lastMessageId || null,
			unreadCount,
			lastActivityAt: lastMessage?.timestamp || current?.lastActivityAt || Date.now(),
			updatedAt: Date.now(),
			previewMessages: previewMessages.length > 0 ? previewMessages : current?.previewMessages || []
		}))
	);
}

export function recordFollowedMessageActivity(options: {
	serverUrl: string;
	serverName: string | null;
	channel: Pick<Channel, 'id' | 'name' | 'type'>;
	message: Message;
	incrementUnread?: boolean;
}): void {
	const { serverUrl, serverName, channel, message, incrementUnread = false } = options;
	const previewMessage = toPreviewMessage(message);

	followSnapshots.update((state) =>
		updateSnapshot(state, serverUrl, channel.id, (current) => {
			const merged = [...(current?.previewMessages || []).filter((entry) => entry.id !== previewMessage.id), previewMessage]
				.sort((a, b) => a.timestamp - b.timestamp)
				.slice(-MAX_PREVIEW_MESSAGES);

			return {
				serverUrl: normalizeServerUrl(serverUrl) || serverUrl,
				serverName,
				channelId: channel.id,
				channelName: channel.name,
				channelType: channel.type,
				lastMessageId: message.id,
				unreadCount: Math.max(0, (current?.unreadCount || 0) + (incrementUnread ? 1 : 0)),
				lastActivityAt: message.timestamp,
				updatedAt: Date.now(),
				previewMessages: merged
			};
		})
	);
}

export function markFollowedChannelRead(serverUrl: string, channelId: string): void {
	followSnapshots.update((state) =>
		updateSnapshot(state, serverUrl, channelId, (current) =>
			current
				? {
						...current,
						unreadCount: 0,
						updatedAt: Date.now()
					}
				: null
		)
	);
}
