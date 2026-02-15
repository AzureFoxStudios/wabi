import { writable } from 'svelte/store';
import type { Socket } from 'socket.io-client';

export type ForwardingLayer = 'q' | 'h' | 'f' | 'auto' | string;

export interface PeerTelemetry {
	key: string;
	targetId: string;
	type: 'call' | 'screen-share-outbound' | 'screen-share-inbound';
	loss: number;
	jitterMs: number;
	rttMs: number;
	bitrateKbps: number;
	selectedLayer: ForwardingLayer;
	activeSpeakerScore: number;
	updatedAt: number;
}

interface TrackedPeer {
	key: string;
	pc: RTCPeerConnection;
	targetId: string;
	type: PeerTelemetry['type'];
	lastBytes: number;
	lastStatsAt: number;
}

const trackedPeers = new Map<string, TrackedPeer>();
let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
let diagnosticsSocket: Socket | null = null;
let localUserId = 'local';

export const callQualityTelemetry = writable<Record<string, PeerTelemetry>>({});

export function registerDiagnosticsPeer(key: string, pc: RTCPeerConnection, info: { targetId: string; type: PeerTelemetry['type'] }): void {
	trackedPeers.set(key, {
		key,
		pc,
		targetId: info.targetId,
		type: info.type,
		lastBytes: 0,
		lastStatsAt: Date.now()
	});
}

export function unregisterDiagnosticsPeer(key: string): void {
	trackedPeers.delete(key);
	callQualityTelemetry.update(current => {
		if (!current[key]) return current;
		const next = { ...current };
		delete next[key];
		return next;
	});
}

export function startDiagnostics(socket: Socket, userId: string): void {
	diagnosticsSocket = socket;
	localUserId = userId || 'local';
	if (diagnosticsTimer) return;
	diagnosticsTimer = setInterval(() => {
		pollStats().catch(err => {
			console.warn('[CallDiagnostics] Failed to poll stats', err);
		});
	}, 2000);
}

export function stopDiagnostics(): void {
	if (diagnosticsTimer) {
		clearInterval(diagnosticsTimer);
		diagnosticsTimer = null;
	}
}

export function reportSelectedLayer(targetId: string, selectedLayer: ForwardingLayer, reason: string): void {
	callQualityTelemetry.update(current => {
		const match = Object.entries(current).find(([, telemetry]) => telemetry.targetId === targetId);
		if (!match) return current;
		const [key, telemetry] = match;
		return {
			...current,
			[key]: { ...telemetry, selectedLayer, updatedAt: Date.now() }
		};
	});
	diagnosticsSocket?.emit('sfu-layer-observed', { targetId, selectedLayer, reason });
}

export function reportActiveSpeaker(userId: string, score: number): void {
	diagnosticsSocket?.emit('sfu-active-speaker', { userId, score, timestamp: Date.now() });
}

async function pollStats(): Promise<void> {
	const peers = Array.from(trackedPeers.values());
	for (const peer of peers) {
		const stats = await peer.pc.getStats();
		let packetsLost = 0;
		let packetsReceived = 0;
		let jitterMs = 0;
		let rttMs = 0;
		let inboundBytes = 0;
		let outboundBytes = 0;

		stats.forEach(report => {
			if (report.type === 'inbound-rtp' && !report.isRemote) {
				packetsLost += report.packetsLost ?? 0;
				packetsReceived += report.packetsReceived ?? 0;
				jitterMs = Math.max(jitterMs, (report.jitter ?? 0) * 1000);
				inboundBytes += report.bytesReceived ?? 0;
			}
			if (report.type === 'remote-inbound-rtp') {
				rttMs = Math.max(rttMs, (report.roundTripTime ?? 0) * 1000);
			}
			if (report.type === 'outbound-rtp' && !report.isRemote) {
				outboundBytes += report.bytesSent ?? 0;
			}
		});

		const now = Date.now();
		const elapsedSeconds = Math.max(1, (now - peer.lastStatsAt) / 1000);
		const totalBytes = inboundBytes + outboundBytes;
		const bitrateKbps = Math.max(0, ((totalBytes - peer.lastBytes) * 8) / elapsedSeconds / 1000);
		peer.lastBytes = totalBytes;
		peer.lastStatsAt = now;
		const loss = packetsReceived + packetsLost > 0 ? packetsLost / (packetsReceived + packetsLost) : 0;

		const payload = {
			publisherId: peer.targetId,
			subscriberId: localUserId,
			metrics: {
				loss,
				jitterMs,
				rttMs,
				bitrateKbps,
				cpuPressure: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ? 0.8 : 0.35
			}
		};

		diagnosticsSocket?.emit('sfu-metrics', payload);

		callQualityTelemetry.update(current => ({
			...current,
			[peer.key]: {
				key: peer.key,
				targetId: peer.targetId,
				type: peer.type,
				loss,
				jitterMs,
				rttMs,
				bitrateKbps,
				selectedLayer: current[peer.key]?.selectedLayer ?? 'auto',
				activeSpeakerScore: current[peer.key]?.activeSpeakerScore ?? 0,
				updatedAt: now
			}
		}));
	}
}
