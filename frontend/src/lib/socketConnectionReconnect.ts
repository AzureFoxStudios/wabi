/**
 * socketConnectionReconnect.ts
 * Reconnection logic with exponential backoff and failover candidate rotation
 */

import { normalizeServerUrl, getServerUrl, setConfiguredServerUrl, getConfiguredServerRememberPreference } from './serverUrl';
import { copyScopedAuthState } from './authSession';
import { getCachedBackendEndpointCandidates, refreshBackendEndpointCandidates } from './backendEndpoints';

export interface ReconnectConfig {
	baseDelay: number;
	maxDelay: number;
	jitterMs: number;
	maxAttempts: number;
}

export class SocketReconnectionManager {
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

		if (preferred) {
			deduped.push(preferred);
			seen.add(preferred);
		}

		for (const candidate of urls) {
			const normalized = normalizeServerUrl(candidate || '');
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			deduped.push(normalized);
		}

		if (deduped.length === 0) return;
		this.failoverCandidates = deduped;
		const currentUrl = preferred || normalizeServerUrl(getServerUrl());
		const currentIndex = currentUrl ? deduped.findIndex((candidate) => candidate === currentUrl) : -1;
		this.currentFailoverCandidateIndex = currentIndex >= 0 ? currentIndex : 0;
	}

	primeFailoverCandidates(serverUrl: string): void {
		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) return;
		const cached = getCachedBackendEndpointCandidates(normalizedServerUrl);
		this.setFailoverCandidates([normalizedServerUrl, ...cached], normalizedServerUrl);
	}

	async refreshFailoverCandidates(serverUrl: string): Promise<void> {
		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) return;
		try {
			const candidates = await refreshBackendEndpointCandidates(normalizedServerUrl);
			if (candidates.length > 0) {
				this.setFailoverCandidates(candidates, normalizedServerUrl);
			}
		} catch (error) {
			console.warn('[SocketReconnectionManager] Failed to refresh backend failover candidates:', error);
		}
	}

	rotateToNextFailoverCandidate(currentServerUrl: string | null): { rotated: boolean; nextUrl: string | null } {
		const currentUrl = normalizeServerUrl(currentServerUrl || getServerUrl());
		if (!currentUrl) return { rotated: false, nextUrl: null };

		this.primeFailoverCandidates(currentUrl);
		if (this.failoverCandidates.length < 2) {
			return { rotated: false, nextUrl: null };
		}

		const startIndex = this.failoverCandidates.findIndex((candidate) => candidate === currentUrl);
		const baseIndex = startIndex >= 0 ? startIndex : this.currentFailoverCandidateIndex;
		for (let offset = 1; offset < this.failoverCandidates.length; offset += 1) {
			const nextIndex = (baseIndex + offset) % this.failoverCandidates.length;
			const nextUrl = this.failoverCandidates[nextIndex];
			if (!nextUrl || nextUrl === currentUrl) continue;

			copyScopedAuthState(currentUrl, nextUrl);
			setConfiguredServerUrl(nextUrl, getConfiguredServerRememberPreference());
			this.currentFailoverCandidateIndex = nextIndex;
			console.warn(`[SocketReconnectionManager] Rotating backend endpoint: ${currentUrl} -> ${nextUrl}`);
			return { rotated: true, nextUrl };
		}

		return { rotated: false, nextUrl: null };
	}
}
