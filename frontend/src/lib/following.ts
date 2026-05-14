import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';

const FOLLOWING_STORAGE_KEY = 'wabi.following.v1';

export type FollowAlertLevel = 'off' | 'mentions' | 'all' | 'priority';

export interface FollowedChannelPreference {
	channelId: string;
	followedAt: number;
	alertLevel: FollowAlertLevel;
}

type FollowingState = Record<string, Record<string, FollowedChannelPreference>>;

const DEFAULT_STATE: FollowingState = {};

export const FOLLOW_ALERT_LEVEL_LABELS: Record<FollowAlertLevel, string> = {
	off: 'Silent',
	mentions: 'Mentions',
	all: 'All Posts',
	priority: 'Priority'
};

const ALERT_LEVEL_CYCLE: FollowAlertLevel[] = ['off', 'mentions', 'all', 'priority'];

function sanitizeAlertLevel(value: unknown): FollowAlertLevel {
	return value === 'mentions' || value === 'all' || value === 'priority' ? value : 'off';
}

function sanitizeFollowingState(raw: unknown): FollowingState {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return DEFAULT_STATE;
	}

	const nextState: FollowingState = {};
	for (const [serverUrl, value] of Object.entries(raw as Record<string, unknown>)) {
		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl || !value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}

		const channelMap: Record<string, FollowedChannelPreference> = {};
		for (const [channelId, channelValue] of Object.entries(value as Record<string, unknown>)) {
			if (!channelId || !channelValue || typeof channelValue !== 'object' || Array.isArray(channelValue)) {
				continue;
			}
			const candidate = channelValue as Record<string, unknown>;
			channelMap[channelId] = {
				channelId,
				followedAt:
					typeof candidate.followedAt === 'number' && Number.isFinite(candidate.followedAt)
						? candidate.followedAt
						: Date.now(),
				alertLevel: sanitizeAlertLevel(candidate.alertLevel)
			};
		}

		if (Object.keys(channelMap).length > 0) {
			nextState[normalizedServerUrl] = channelMap;
		}
	}

	return nextState;
}

function loadFollowingState(): FollowingState {
	if (!browser) return DEFAULT_STATE;
	try {
		const raw = localStorage.getItem(FOLLOWING_STORAGE_KEY);
		if (!raw) return DEFAULT_STATE;
		return sanitizeFollowingState(JSON.parse(raw));
	} catch {
		return DEFAULT_STATE;
	}
}

function persistFollowingState(state: FollowingState): void {
	if (!browser) return;
	try {
		localStorage.setItem(FOLLOWING_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Best effort only.
	}
}

function getActiveServerUrl(): string {
	return normalizeServerUrl(resolveServerUrl().url) || resolveServerUrl().url;
}

export function getCurrentFollowServerUrl(): string {
	return getActiveServerUrl();
}

function updateServerPreferences(
	state: FollowingState,
	serverUrl: string,
	mutator: (current: Record<string, FollowedChannelPreference>) => Record<string, FollowedChannelPreference>
): FollowingState {
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl) return state;

	const current = state[normalizedServerUrl] || {};
	const nextChannelMap = mutator(current);
	const nextState = { ...state };

	if (Object.keys(nextChannelMap).length === 0) {
		delete nextState[normalizedServerUrl];
		return nextState;
	}

	nextState[normalizedServerUrl] = nextChannelMap;
	return nextState;
}

export const followingPreferences = writable<FollowingState>(loadFollowingState());

if (browser) {
	followingPreferences.subscribe((value) => {
		persistFollowingState(value);
	});
}

export const currentServerFollowedChannels = derived(
	followingPreferences,
	($followingPreferences): FollowedChannelPreference[] => {
		const serverUrl = getActiveServerUrl();
		return Object.values($followingPreferences[serverUrl] || {}).sort(
			(a, b) => a.followedAt - b.followedAt
		);
	}
);

export const allServerFollowedChannels = derived(
	followingPreferences,
	($followingPreferences) =>
		Object.entries($followingPreferences).flatMap(([serverUrl, channels]) =>
			Object.values(channels).map((preference) => ({
				serverUrl,
				preference
			}))
		)
);

export function isChannelFollowed(channelId: string, serverUrl = getActiveServerUrl()): boolean {
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl) return false;
	const state = get(followingPreferences);
	return Boolean(state[normalizedServerUrl]?.[channelId]);
}

export function getChannelFollowPreference(
	channelId: string,
	serverUrl = getActiveServerUrl()
): FollowedChannelPreference | null {
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl) return null;
	const state = get(followingPreferences);
	return state[normalizedServerUrl]?.[channelId] || null;
}

export function followChannel(channelId: string, serverUrl = getActiveServerUrl()): void {
	const now = Date.now();
	followingPreferences.update((state) =>
		updateServerPreferences(state, serverUrl, (current) => ({
			...current,
			[channelId]: current[channelId] || {
				channelId,
				followedAt: now,
				alertLevel: 'off'
			}
		}))
	);
}

export function unfollowChannel(channelId: string, serverUrl = getActiveServerUrl()): void {
	followingPreferences.update((state) =>
		updateServerPreferences(state, serverUrl, (current) => {
			const next = { ...current };
			delete next[channelId];
			return next;
		})
	);
}

export function toggleChannelFollow(channelId: string, serverUrl = getActiveServerUrl()): boolean {
	if (isChannelFollowed(channelId, serverUrl)) {
		unfollowChannel(channelId, serverUrl);
		return false;
	}
	followChannel(channelId, serverUrl);
	return true;
}

export function setChannelFollowAlertLevel(
	channelId: string,
	alertLevel: FollowAlertLevel,
	serverUrl = getActiveServerUrl()
): void {
	followingPreferences.update((state) =>
		updateServerPreferences(state, serverUrl, (current) => {
			const existing = current[channelId];
			if (!existing) {
				return {
					...current,
					[channelId]: {
						channelId,
						followedAt: Date.now(),
						alertLevel
					}
				};
			}

			return {
				...current,
				[channelId]: {
					...existing,
					alertLevel
				}
			};
		})
	);
}

export function cycleChannelFollowAlertLevel(
	channelId: string,
	serverUrl = getActiveServerUrl()
): FollowAlertLevel {
	const current = getChannelFollowPreference(channelId, serverUrl);
	const currentIndex = ALERT_LEVEL_CYCLE.indexOf(current?.alertLevel || 'off');
	const nextLevel = ALERT_LEVEL_CYCLE[(currentIndex + 1) % ALERT_LEVEL_CYCLE.length] || 'off';
	setChannelFollowAlertLevel(channelId, nextLevel, serverUrl);
	return nextLevel;
}
