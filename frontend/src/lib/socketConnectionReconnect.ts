/**
 * socketConnectionReconnect.ts
 * Reconnection logic with exponential backoff and failover candidate rotation
 */

import { normalizeServerUrl, getServerUrl, setConfiguredServerUrl, getConfiguredServerRememberPreference } from './serverUrl';
import { authSessionGeneration, getAuthToken, getStoredDbUserId, getStoredUsername, setAuthToken, setStoredDbUserId, setStoredUsername } from './authSession';
import { canCarrySessionTo, getPinnedCommunityRoster, refreshCommunityRoster } from './communityRoster';

const defaultDependencies = {
	getServerUrl,
	setConfiguredServerUrl,
	getConfiguredServerRememberPreference,
	authSessionGeneration,
	getAuthToken,
	getStoredDbUserId,
	getStoredUsername,
	setAuthToken,
	setStoredDbUserId,
	setStoredUsername,
	canCarrySessionTo,
	getPinnedCommunityRoster,
	refreshCommunityRoster
};

export type ReconnectDependencies = typeof defaultDependencies;

export interface ReconnectConfig {
	baseDelay: number;
	maxDelay: number;
	jitterMs: number;
	maxAttempts: number;
}

export class SocketReconnectionManager {
	constructor(private readonly dependencies: ReconnectDependencies = defaultDependencies) {}
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private failoverCandidates: string[] = [];
	private currentFailoverCandidateIndex = 0;
	private maxReconnectAttempts = 10;

	private baseDelay = 1000;
	private maxDelay = 30000;
	private reconnectJitterMs = 1000;

	setConfig(config: Partial<ReconnectConfig>): void {
		if (config.baseDelay !== undefined) this.baseDelay = config.baseDelay;
		if (config.maxDelay !== undefined) this.maxDelay = config.maxDelay;
		if (config.jitterMs !== undefined) this.reconnectJitterMs = config.jitterMs;
		if (config.maxAttempts !== undefined) this.maxReconnectAttempts = config.maxAttempts;
	}

	getAttemptCount(): number {
		return this.reconnectAttempts;
	}

	getMaxAttempts(): number {
		return this.maxReconnectAttempts;
	}

	hasExhaustedAttempts(): boolean {
		return this.reconnectAttempts >= this.maxReconnectAttempts;
	}

	incrementAttempt(): void {
		this.reconnectAttempts += 1;
	}

	resetAttempts(): void {
		this.reconnectAttempts = 0;
	}

	calculateBackoffDelay(): number {
		const baseWait = Math.min(this.baseDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxDelay);
		const jitter = Math.random() * this.reconnectJitterMs;
		return baseWait + jitter;
	}

	setReconnectTimer(timer: ReturnType<typeof setTimeout> | null): void {
		this.reconnectTimer = timer;
	}

	cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	setFailoverCandidates(urls: Array<string | null | undefined>, preferredUrl?: string | null): void {
		const preferred = normalizeServerUrl(preferredUrl || '');
		const deduped: string[] = [];
		const seen = new Set<string>();

		for (const candidate of urls) {
			const normalized = normalizeServerUrl(candidate || '');
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			deduped.push(normalized);
		}
		// Keep the signed roster order across reconnects. Putting the current
		// endpoint first on every attempt makes two healthy candidates ping-pong
		// and can leave another approved site untried indefinitely.
		if (preferred && !seen.has(preferred)) deduped.unshift(preferred);

		if (deduped.length === 0) return;
		this.failoverCandidates = deduped;
		const currentUrl = preferred || normalizeServerUrl(this.dependencies.getServerUrl());
		const currentIndex = currentUrl ? deduped.findIndex((candidate) => candidate === currentUrl) : -1;
		this.currentFailoverCandidateIndex = currentIndex >= 0 ? currentIndex : 0;
	}

	primeFailoverCandidates(serverUrl: string): void {
		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) return;
		this.setFailoverCandidates([normalizedServerUrl], normalizedServerUrl);
	}

	async refreshFailoverCandidates(serverUrl: string): Promise<void> {
		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) return;
		try {
			const roster = await this.dependencies.refreshCommunityRoster(normalizedServerUrl);
			if (roster && normalizeServerUrl(this.dependencies.getServerUrl()) === normalizedServerUrl) {
				this.setFailoverCandidates(roster.body.entries.map((entry) => entry.url), normalizedServerUrl);
			}
		} catch (error) {
			console.warn('[SocketReconnectionManager] Failed to refresh backend failover candidates:', error);
		}
	}

	async rotateToNextFailoverCandidate(currentServerUrl: string | null): Promise<{ rotated: boolean; nextUrl: string | null }> {
		const currentUrl = normalizeServerUrl(currentServerUrl || this.dependencies.getServerUrl());
		if (!currentUrl) return { rotated: false, nextUrl: null };
		const accountId = this.dependencies.getStoredDbUserId(currentUrl);
		const token = this.dependencies.getAuthToken(currentUrl);
		if (!accountId || !token) return { rotated: false, nextUrl: null };
		const generation = this.dependencies.authSessionGeneration(currentUrl);
		const roster = await this.dependencies.getPinnedCommunityRoster(currentUrl, accountId);
		if (!roster || this.dependencies.getAuthToken(currentUrl) !== token || this.dependencies.getStoredDbUserId(currentUrl) !== accountId ||
			this.dependencies.authSessionGeneration(currentUrl) !== generation || normalizeServerUrl(this.dependencies.getServerUrl()) !== currentUrl) {
			return { rotated: false, nextUrl: null };
		}
		this.setFailoverCandidates(roster.body.entries.map((entry) => entry.url), currentUrl);
		if (this.failoverCandidates.length < 2) {
			return { rotated: false, nextUrl: null };
		}

		const startIndex = this.failoverCandidates.findIndex((candidate) => candidate === currentUrl);
		const baseIndex = startIndex >= 0 ? startIndex : this.currentFailoverCandidateIndex;
		for (let offset = 1; offset < this.failoverCandidates.length; offset += 1) {
			const nextIndex = (baseIndex + offset) % this.failoverCandidates.length;
			const nextUrl = this.failoverCandidates[nextIndex];
			if (!nextUrl || nextUrl === currentUrl || !this.dependencies.canCarrySessionTo(roster, nextUrl)) continue;
			const existingToken = this.dependencies.getAuthToken(nextUrl);
			if (existingToken && existingToken !== token) continue;

			this.dependencies.setAuthToken(token, nextUrl);
			this.dependencies.setStoredUsername(this.dependencies.getStoredUsername(currentUrl), nextUrl);
			this.dependencies.setStoredDbUserId(accountId, nextUrl);
			this.dependencies.setConfiguredServerUrl(nextUrl, this.dependencies.getConfiguredServerRememberPreference());
			this.currentFailoverCandidateIndex = nextIndex;
			console.warn(`[SocketReconnectionManager] Rotating backend endpoint: ${currentUrl} -> ${nextUrl}`);
			return { rotated: true, nextUrl };
		}

		return { rotated: false, nextUrl: null };
	}
}
