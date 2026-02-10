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
	latency: number | null;
}

// Stores
export const relays = writable<RelayInfo[]>([]);
export const selectedRelay = writable<RelayInfo | null>(null);
export const relayEnabled = writable<boolean>(false);

const RELAY_CACHE_KEY = 'wabi_relay_selection';
const RELAY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let lastFetchTime = 0;

export async function initRelaySelector(): Promise<void> {
	if (!browser) return;
	if (import.meta.env.VITE_ENABLE_RELAYS !== 'true') {
		relayEnabled.set(false);
		return;
	}
	relayEnabled.set(true);

	// Try to restore cached selection
	try {
		const cached = JSON.parse(localStorage.getItem(RELAY_CACHE_KEY) || 'null');
		if (cached && cached.timestamp > Date.now() - RELAY_CACHE_TTL) {
			selectedRelay.set(cached.relay);
			return;
		}
	} catch { /* ignore parse errors */ }

	await refreshRelays();
}

export async function refreshRelays(): Promise<void> {
	if (!browser) return;
	if (Date.now() - lastFetchTime < 30_000) return; // debounce 30s
	lastFetchTime = Date.now();

	try {
		const serverUrl = getServerUrl();
		const response = await fetch(`${serverUrl}/api/relays`);
		const data = await response.json();

		if (!data.relays || data.relays.length === 0) {
			selectedRelay.set(null);
			return;
		}

		// Measure latency to each relay in parallel
		const relayList: RelayInfo[] = await Promise.all(
			data.relays.map(async (r: any) => {
				const latency = await measureLatency(r.url);
				return { ...r, latency };
			})
		);

		relays.set(relayList);

		// Select fastest responsive relay
		const responsive = relayList.filter((r) => r.latency !== null);
		responsive.sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity));

		const best = responsive[0] || null;
		selectedRelay.set(best);

		// Cache selection
		if (best) {
			try {
				localStorage.setItem(
					RELAY_CACHE_KEY,
					JSON.stringify({ relay: best, timestamp: Date.now() })
				);
			} catch { /* storage full — ignore */ }
		}

		console.log(
			`[RelaySelector] Selected: ${best?.name || 'origin'} (${best?.latency ?? 'N/A'}ms)`
		);
	} catch (err) {
		console.warn('[RelaySelector] Failed to fetch relays:', err);
		selectedRelay.set(null);
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
		return null; // relay unreachable
	}
}

/**
 * Get the best URL for a file path.
 * If a relay is selected and reachable, returns relay URL.
 * Otherwise falls back to origin.
 */
export function getRelayFileUrl(relativePath: string): string {
	const relay = get(selectedRelay);
	if (relay) {
		return `${relay.url}${relativePath}`;
	}
	return getOriginFileUrl(relativePath);
}

function getOriginFileUrl(relativePath: string): string {
	if (
		window.location.origin.includes(':5173') ||
		window.location.origin.includes('tauri.localhost')
	) {
		return `http://localhost:3000${relativePath}`;
	} else if (window.location.origin.includes(':3000')) {
		return `${window.location.origin.replace(':3000', ':8080')}${relativePath}`;
	} else {
		return `${window.location.origin}${relativePath}`;
	}
}
