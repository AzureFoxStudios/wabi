import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { getServerUrl } from './serverUrl';

export interface RelayInfo {
	relay_id: number;
	url: string;
	name: string;
	region: string;
	status: string;
	latitude: number | null;
	longitude: number | null;
	bandwidth_mbps: number | null;
	capabilities?: {
		fileRelay?: boolean;
		turn?: boolean;
		sfu?: boolean;
		gateway?: boolean;
		selfHosted?: boolean;
		boosterMode?: 'off' | 'turn-only' | 'turn-sfu' | 'turn-sfu-gateway' | null;
	};
	turn?: {
		server: string;
		port: number;
		useTurns: boolean;
		realm?: string | null;
	} | null;
	sfu?: {
		provider: 'livekit';
		url: string;
	} | null;
	latency: number | null;
}

interface CachedRelaySelection {
	fileRelay: RelayInfo | null;
	turnRelay: RelayInfo | null;
	sfuRelay: RelayInfo | null;
	timestamp: number;
}

export const relays = writable<RelayInfo[]>([]);
export const selectedRelay = writable<RelayInfo | null>(null);
export const selectedTurnRelay = writable<RelayInfo | null>(null);
export const selectedSfuRelay = writable<RelayInfo | null>(null);
export const relayEnabled = writable<boolean>(false);

const RELAY_CACHE_KEY = 'wabi_relay_selection';
const RELAY_CACHE_TTL = 5 * 60 * 1000;

let lastFetchTime = 0;

function readCachedSelection(): CachedRelaySelection | null {
	if (!browser) return null;
	try {
		const cached = JSON.parse(localStorage.getItem(RELAY_CACHE_KEY) || 'null');
		if (!cached || typeof cached !== 'object') return null;
		if (typeof cached.timestamp !== 'number' || cached.timestamp <= Date.now() - RELAY_CACHE_TTL) {
			return null;
		}
		return {
			fileRelay: cached.fileRelay || cached.relay || null,
			turnRelay: cached.turnRelay || null,
			sfuRelay: cached.sfuRelay || null,
			timestamp: cached.timestamp
		};
	} catch {
		return null;
	}
}

function writeCachedSelection(fileRelay: RelayInfo | null, turnRelay: RelayInfo | null, sfuRelay: RelayInfo | null): void {
	if (!browser) return;
	try {
		localStorage.setItem(
			RELAY_CACHE_KEY,
			JSON.stringify({
				fileRelay,
				turnRelay,
				sfuRelay,
				timestamp: Date.now()
			})
		);
	} catch {
		// ignore storage failures
	}
}

function isFileRelayCapable(relay: RelayInfo): boolean {
	return relay.capabilities?.fileRelay ?? true;
}

function isTurnRelayCapable(relay: RelayInfo): boolean {
	return relay.capabilities?.turn === true && !!relay.turn?.server;
}

function isSfuRelayCapable(relay: RelayInfo): boolean {
	return relay.capabilities?.sfu === true && relay.sfu?.provider === 'livekit' && !!relay.sfu?.url;
}

export async function initRelaySelector(): Promise<void> {
	if (!browser) return;
	if (import.meta.env.VITE_ENABLE_RELAYS !== 'true') {
		relayEnabled.set(false);
		selectedRelay.set(null);
		selectedTurnRelay.set(null);
		selectedSfuRelay.set(null);
		return;
	}
	relayEnabled.set(true);

	const cached = readCachedSelection();
	if (cached) {
		selectedRelay.set(cached.fileRelay);
		selectedTurnRelay.set(cached.turnRelay);
		selectedSfuRelay.set(cached.sfuRelay);
		return;
	}

	await refreshRelays();
}

export async function refreshRelays(): Promise<void> {
	if (!browser) return;
	if (Date.now() - lastFetchTime < 30_000) return;
	lastFetchTime = Date.now();

	try {
		const serverUrl = getServerUrl();
		const response = await fetch(`${serverUrl}/api/relays`);
		const data = await response.json();

		if (!data.relays || data.relays.length === 0) {
			selectedRelay.set(null);
			selectedTurnRelay.set(null);
			selectedSfuRelay.set(null);
			return;
		}

		const relayList: RelayInfo[] = await Promise.all(
			data.relays.map(async (relay: any) => {
				const latency = await measureLatency(relay.url);
				return { ...relay, latency };
			})
		);

		relays.set(relayList);

		const responsive = relayList.filter((relay) => relay.latency !== null);
		const bestFileRelay =
			responsive
				.filter((relay) => isFileRelayCapable(relay))
				.sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity))[0] || null;
		const bestTurnRelay =
			responsive
				.filter((relay) => isTurnRelayCapable(relay))
				.sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity))[0] || null;
		const bestSfuRelay =
			responsive
				.filter((relay) => isSfuRelayCapable(relay))
				.sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity))[0] || null;

		selectedRelay.set(bestFileRelay);
		selectedTurnRelay.set(bestTurnRelay);
		selectedSfuRelay.set(bestSfuRelay);
		writeCachedSelection(bestFileRelay, bestTurnRelay, bestSfuRelay);

		console.log(
			`[RelaySelector] File relay: ${bestFileRelay?.name || 'origin'} (${bestFileRelay?.latency ?? 'N/A'}ms) | TURN relay: ${bestTurnRelay?.name || 'origin'} (${bestTurnRelay?.latency ?? 'N/A'}ms) | SFU relay: ${bestSfuRelay?.name || 'origin'} (${bestSfuRelay?.latency ?? 'N/A'}ms)`
		);
	} catch (err) {
		console.warn('[RelaySelector] Failed to fetch relays:', err);
		selectedRelay.set(null);
		selectedTurnRelay.set(null);
		selectedSfuRelay.set(null);
	}
}

async function measureLatency(relayUrl: string): Promise<number | null> {
	try {
		const start = performance.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);

		const response = await fetch(`${relayUrl}/health`, {
			signal: controller.signal,
			mode: 'cors',
			cache: 'no-store'
		});

		clearTimeout(timeout);
		if (!response.ok) return null;
		return Math.round(performance.now() - start);
	} catch {
		return null;
	}
}

export function getRelayFileUrl(relativePath: string): string {
	const relay = get(selectedRelay);
	if (relay && isFileRelayCapable(relay)) {
		return `${relay.url}${relativePath}`;
	}
	return `${getServerUrl()}${relativePath}`;
}

export function getPreferredTurnRelayId(): number | null {
	const relay = get(selectedTurnRelay);
	if (relay?.relay_id) return relay.relay_id;
	const cached = readCachedSelection();
	return cached?.turnRelay?.relay_id || null;
}

export function getPreferredSfuRelayId(): number | null {
	const relay = get(selectedSfuRelay);
	if (relay?.relay_id) return relay.relay_id;
	const cached = readCachedSelection();
	return cached?.sfuRelay?.relay_id || null;
}
