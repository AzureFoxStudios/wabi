import os from 'node:os';
import { relayRepository } from '../db/repositories/relayRepository.js';
import {
	getBoosterRelayComponentConfigState,
	getEffectiveBoosterRelayMode,
	getRequestedBoosterRelayMode,
	type BoosterRelayMode
} from './boosterRelayMode.js';

type SelfHostedRelayStatus = 'active' | 'degraded' | 'offline';

export interface SelfHostedBoosterRelaySnapshot {
	enabled: boolean;
	advertised: boolean;
	relayId: number | null;
	url: string | null;
	name: string | null;
	region: string | null;
	status: SelfHostedRelayStatus | null;
	reason: string | null;
	requestedMode: BoosterRelayMode;
	effectiveMode: BoosterRelayMode;
	updatedAt: number | null;
}

const snapshot: SelfHostedBoosterRelaySnapshot = {
	enabled: false,
	advertised: false,
	relayId: null,
	url: null,
	name: null,
	region: null,
	status: null,
	reason: null,
	requestedMode: 'off',
	effectiveMode: 'off',
	updatedAt: null
};

let intervalHandle: NodeJS.Timeout | null = null;
let lastLogSignature = '';

function numberFromEnv(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizePublicUrl(value: string | undefined): string | null {
	const raw = (value || '').trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		url.hash = '';
		url.search = '';
		url.pathname = url.pathname.replace(/\/+$/, '');
		return url.toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}

function getAdvertisedRelayUrl(): string | null {
	return sanitizePublicUrl(process.env.BOOSTER_RELAY_PUBLIC_URL || process.env.PUBLIC_URL);
}

function getAdvertisedRelayName(): string {
	const configured = (process.env.BOOSTER_RELAY_NAME || '').trim();
	if (configured) return configured.slice(0, 120);
	return `${os.hostname()} Booster Relay`.slice(0, 120);
}

function getAdvertisedRelayRegion(): string {
	const configured = (process.env.BOOSTER_RELAY_REGION || '').trim();
	if (configured) return configured.slice(0, 64);
	return 'self-hosted';
}

function getAdvertisedRelayMetadata(status: SelfHostedRelayStatus, reason: string | null): Record<string, unknown> {
	const components = getBoosterRelayComponentConfigState();
	const turnServer = (process.env.TURN_EXTERNAL_IP || '').trim();
	const turnRealm = (process.env.TURN_REALM || '').trim() || null;
	const turnPort = numberFromEnv(process.env.TURN_PORT) || 3478;
	const useTurns = (process.env.TURN_USE_TLS || '').trim() === 'true' || (process.env.TURN_USE_TLS || '').trim() === '1';
	const livekitUrl = (process.env.LIVEKIT_URL || '').trim() || null;
	const effectiveMode = getEffectiveBoosterRelayMode();
	return {
		kind: 'booster-relay',
		source: 'origin-process',
		status,
		reason,
		requestedMode: getRequestedBoosterRelayMode(),
		effectiveMode,
		components,
		capabilities: {
			fileRelay: true,
			turn: components.turnConfigured,
			sfu: components.sfuConfigured,
			gateway: components.gatewayConfigured,
			selfHosted: true,
			boosterMode: effectiveMode === 'off' ? getRequestedBoosterRelayMode() : effectiveMode
		},
		turn: turnServer
			? {
					server: turnServer,
					port: turnPort,
					useTurns,
					realm: turnRealm
				}
			: null,
		sfu: components.sfuConfigured && livekitUrl
			? {
					provider: 'livekit',
					url: livekitUrl
				}
			: null,
		updatedAt: new Date().toISOString()
	};
}

function updateSnapshot(next: Partial<SelfHostedBoosterRelaySnapshot>): void {
	Object.assign(snapshot, next);
}

function logStateChange(status: SelfHostedRelayStatus | null, reason: string | null, url: string | null): void {
	const signature = `${status || 'none'}|${reason || ''}|${url || ''}`;
	if (signature === lastLogSignature) return;
	lastLogSignature = signature;
	if (status === 'active') {
		console.log(`[Relay] Self-hosted booster relay active at ${url}`);
		return;
	}
	if (status === 'degraded') {
		console.warn(`[Relay] Self-hosted booster relay degraded: ${reason || 'configuration incomplete'}`);
		return;
	}
	if (status === 'offline') {
		console.log(`[Relay] Self-hosted booster relay offline${reason ? `: ${reason}` : ''}`);
	}
}

async function advertiseSelfHostedBoosterRelayOnce(): Promise<void> {
	const requestedMode = getRequestedBoosterRelayMode();
	const effectiveMode = getEffectiveBoosterRelayMode();
	const url = getAdvertisedRelayUrl();
	const name = getAdvertisedRelayName();
	const region = getAdvertisedRelayRegion();
	const now = Date.now();
	const enabled = requestedMode !== 'off';

	updateSnapshot({
		enabled,
		requestedMode,
		effectiveMode,
		url,
		name,
		region,
		updatedAt: now
	});

	if (!url) {
		updateSnapshot({
			advertised: false,
			relayId: null,
			status: null,
			reason: enabled
				? 'BOOSTER_RELAY_PUBLIC_URL or PUBLIC_URL is required for self-advertisement.'
				: 'Booster relay mode is disabled.'
		});
		logStateChange(null, snapshot.reason, null);
		return;
	}

	let status: SelfHostedRelayStatus = 'offline';
	let reason: string | null = null;
	if (requestedMode === 'off') {
		reason = 'Booster relay mode is disabled.';
	} else if (effectiveMode === 'off') {
		status = 'degraded';
		reason = 'Requested booster relay mode is enabled, but no relay components are currently configured.';
	} else if (requestedMode !== effectiveMode) {
		status = 'degraded';
		reason = 'Requested booster relay mode is heavier than the currently available relay components.';
	} else {
		status = 'active';
	}

	const relay = await relayRepository.upsertSelfHosted({
		url,
		name,
		region,
		status,
		bandwidth_mbps: numberFromEnv(process.env.BOOSTER_RELAY_BANDWIDTH_MBPS),
		storage_gb: numberFromEnv(process.env.BOOSTER_RELAY_STORAGE_GB),
		metadata: getAdvertisedRelayMetadata(status, reason)
	});

	updateSnapshot({
		advertised: true,
		relayId: relay.relay_id,
		status,
		reason
	});
	logStateChange(status, reason, url);
}

export function getSelfHostedBoosterRelaySnapshot(): SelfHostedBoosterRelaySnapshot {
	return { ...snapshot };
}

export function startSelfHostedBoosterRelayAdvertiser(): { stop(): void } {
	const intervalMs = Math.max(
		15_000,
		Math.floor((numberFromEnv(process.env.BOOSTER_RELAY_HEARTBEAT_SECONDS) || 60) * 1000)
	);
	void advertiseSelfHostedBoosterRelayOnce().catch((error) => {
		console.error('[Relay] Failed to advertise self-hosted booster relay:', error);
	});
	intervalHandle = setInterval(() => {
		void advertiseSelfHostedBoosterRelayOnce().catch((error) => {
			console.error('[Relay] Failed to refresh self-hosted booster relay:', error);
		});
	}, intervalMs);
	intervalHandle.unref?.();
	return {
		stop() {
			if (intervalHandle) {
				clearInterval(intervalHandle);
				intervalHandle = null;
			}
		}
	};
}
