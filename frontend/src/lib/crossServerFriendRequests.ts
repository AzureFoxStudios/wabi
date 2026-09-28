import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { authSessionGeneration, getAuthToken, getStoredDbUserId } from './authSession';
import { fetchWithTimeout, parseApiJson } from './api/utils';
import type { FriendRequest } from './api/friends';
import { savedServers } from './savedServers';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';

export interface RemoteFriendRequests {
	accountId: number | null;
	requests: FriendRequest[];
	updatedAt: number;
}

export const remoteFriendRequests = writable<Record<string, RemoteFriendRequests>>({});

let users = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let runGeneration = 0;

async function poll(): Promise<void> {
	if (!browser || polling || users === 0) return;
	polling = true;
	const generationAtStart = runGeneration;
	try {
		const currentUrl = normalizeServerUrl(resolveServerUrl().url);
		const servers = get(savedServers).filter((server) => server.url !== currentUrl && server.hasRegisteredSession);
		const results = await Promise.allSettled(servers.map(async (server) => {
			const token = getAuthToken(server.url);
			const accountId = getStoredDbUserId(server.url);
			const generation = authSessionGeneration(server.url);
			if (!token) return null;
			const response = await fetchWithTimeout(`${server.url}/api/friends/`, {
				method: 'GET', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', timeoutMs: 10000
			});
			if (!response.ok) return null;
			const data = await parseApiJson(response);
			if (!data || typeof data !== 'object' || !Array.isArray((data as { incoming?: unknown }).incoming)) return null;
			if (token !== getAuthToken(server.url) || generation !== authSessionGeneration(server.url)) return null;
			return { url: server.url, accountId: accountId ?? null, requests: (data as { incoming: FriendRequest[] }).incoming };
		}));
		if (users === 0 || generationAtStart !== runGeneration) return;
		const next: Record<string, RemoteFriendRequests> = {};
		for (const result of results) {
			if (result.status !== 'fulfilled' || !result.value) continue;
			next[result.value.url] = { accountId: result.value.accountId, requests: result.value.requests, updatedAt: Date.now() };
		}
		remoteFriendRequests.set(next);
	} finally {
		polling = false;
		if (users > 0) timer = setTimeout(() => { void poll(); }, document.hidden ? 60_000 : 45_000);
	}
}

export function startRemoteFriendRequestPoller(): () => void {
	if (!browser) return () => {};
	users += 1;
	if (users === 1) {
		runGeneration += 1;
		timer = setTimeout(() => { void poll(); }, 3000);
	}
	return () => {
		users -= 1;
		if (users === 0) {
			runGeneration += 1;
			if (timer) clearTimeout(timer);
			timer = null;
			remoteFriendRequests.set({});
		}
	};
}
