import { browser } from '$app/environment';
import { normalizeServerUrl } from './serverUrl';

const PENDING_CHANNEL_KEY = 'wabi.pendingChannelNavigation.v1';
const MAX_PENDING_AGE_MS = 5 * 60 * 1000;

interface PendingChannelNavigation {
	serverUrl: string;
	channelId: string;
	createdAt: number;
}

function sanitizePendingNavigation(raw: unknown): PendingChannelNavigation | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const serverUrl =
		typeof candidate.serverUrl === 'string' ? normalizeServerUrl(candidate.serverUrl) : null;
	const channelId = typeof candidate.channelId === 'string' ? candidate.channelId.trim() : '';
	const createdAt =
		typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
			? candidate.createdAt
			: 0;

	if (!serverUrl || !channelId || !createdAt) return null;
	if (Date.now() - createdAt > MAX_PENDING_AGE_MS) return null;

	return {
		serverUrl,
		channelId,
		createdAt
	};
}

function readPendingNavigation(): PendingChannelNavigation | null {
	if (!browser) return null;
	try {
		const raw = sessionStorage.getItem(PENDING_CHANNEL_KEY);
		if (!raw) return null;
		return sanitizePendingNavigation(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function setPendingChannelNavigation(serverUrl: string, channelId: string): void {
	if (!browser) return;
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl || !channelId.trim()) return;

	try {
		sessionStorage.setItem(
			PENDING_CHANNEL_KEY,
			JSON.stringify({
				serverUrl: normalizedServerUrl,
				channelId: channelId.trim(),
				createdAt: Date.now()
			} satisfies PendingChannelNavigation)
		);
	} catch {
		// best effort only
	}
}

export function clearPendingChannelNavigation(): void {
	if (!browser) return;
	try {
		sessionStorage.removeItem(PENDING_CHANNEL_KEY);
	} catch {
		// best effort only
	}
}

export function consumePendingChannelNavigation(serverUrl: string): string | null {
	const pending = readPendingNavigation();
	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!pending || !normalizedServerUrl) {
		clearPendingChannelNavigation();
		return null;
	}

	if (pending.serverUrl !== normalizedServerUrl) {
		return null;
	}

	clearPendingChannelNavigation();
	return pending.channelId;
}
