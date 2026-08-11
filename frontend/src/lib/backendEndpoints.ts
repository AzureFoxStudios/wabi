import { browser } from '$app/environment';
import { getPublicBackendEndpointsFrom } from './api';
import { normalizeServerUrl } from './serverUrl';

const BACKEND_ENDPOINT_CACHE_KEY = 'wabi.backendEndpoints.v1';
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedBackendEndpointEntry {
	urls: string[];
	updatedAt: number;
}

type CachedBackendEndpointState = Record<string, CachedBackendEndpointEntry>;

function normalizeCandidateUrls(urls: Array<string | null | undefined>): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const candidate of urls) {
		if (typeof candidate !== 'string') continue;
		const next = normalizeServerUrl(candidate);
		if (!next || seen.has(next)) continue;
		seen.add(next);
		normalized.push(next);
	}
	return normalized;
}

function loadCachedState(): CachedBackendEndpointState {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(BACKEND_ENDPOINT_CACHE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as CachedBackendEndpointState;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}

function persistCachedState(state: CachedBackendEndpointState): void {
	if (!browser) return;
	try {
		// The cache contains normalized public endpoints only, never credentials.
		localStorage.setItem(BACKEND_ENDPOINT_CACHE_KEY, JSON.stringify(state));
	} catch {
		// Best effort only.
	}
}

function seedCacheEntries(seedUrls: string[], urls: string[]): void {
	if (!browser || seedUrls.length === 0 || urls.length === 0) return;
	const now = Date.now();
	const state = loadCachedState();
	for (const seedUrl of seedUrls) {
		state[seedUrl] = {
			urls,
			updatedAt: now
		};
	}
	persistCachedState(state);
}

export function cacheBackendEndpointCandidates(
	seedUrls: Array<string | null | undefined>,
	candidateUrls: Array<string | null | undefined>
): string[] {
	const normalizedSeeds = normalizeCandidateUrls(seedUrls);
	const normalizedCandidates = normalizeCandidateUrls(candidateUrls);
	if (normalizedSeeds.length === 0 || normalizedCandidates.length === 0) {
		return normalizedCandidates;
	}
	seedCacheEntries(
		normalizeCandidateUrls([...normalizedSeeds, ...normalizedCandidates]),
		normalizedCandidates
	);
	return normalizedCandidates;
}

export function getCachedBackendEndpointCandidates(
	baseUrl?: string | null,
	maxAgeMs: number = DEFAULT_CACHE_TTL_MS
): string[] {
	if (!browser) return [];
	const normalizedBaseUrl = normalizeServerUrl(baseUrl || '');
	if (!normalizedBaseUrl) return [];
	const entry = loadCachedState()[normalizedBaseUrl];
	if (!entry) return [];
	if (!Number.isFinite(entry.updatedAt) || (Date.now() - entry.updatedAt) > maxAgeMs) {
		return [];
	}
	return normalizeCandidateUrls(entry.urls);
}

export async function refreshBackendEndpointCandidates(baseUrl?: string | null): Promise<string[]> {
	const normalizedBaseUrl = normalizeServerUrl(baseUrl || '');
	if (!normalizedBaseUrl) return [];
	const response = await getPublicBackendEndpointsFrom(normalizedBaseUrl);
	if (!response?.success) {
		return getCachedBackendEndpointCandidates(normalizedBaseUrl);
	}
	return cacheBackendEndpointCandidates(
		[normalizedBaseUrl, response.currentUrl, ...response.endpoints.map((endpoint) => endpoint.url)],
		[response.currentUrl, ...response.endpoints.map((endpoint) => endpoint.url)]
	);
}
