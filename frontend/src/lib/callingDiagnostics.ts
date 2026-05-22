import { get } from 'svelte/store';
import { callConnectionDiagnostics, connectionState } from './callingStateStores';
import {
	VIDEO_QUALITY_TIER_PARAMS,
	type ConnectionLifecycleState,
	type PeerConnectionState,
	type VideoQualityTier
} from './callingTypes';

type CallStateProvider = () => PeerConnectionState[];
type NoticeHandler = (text: string) => void;

let diagnosticsPollInterval: number | null = null;
let diagnosticsPrevBytesSample: { bytesSent: number; bytesReceived: number; timestamp: number } | null = null;
let activeVideoQualityTier: VideoQualityTier = 'high';
let lastVideoQualityNoticeAt = 0;
let getCallStates: CallStateProvider = () => [];
let pushNotice: NoticeHandler = () => {};

export function resetCallConnectionDiagnostics(state: ConnectionLifecycleState = 'idle'): void {
	diagnosticsPrevBytesSample = null;
	callConnectionDiagnostics.set({
		pingMs: null,
		jitterMs: null,
		outboundPacketLossPct: null,
		inboundPacketLossPct: null,
		outboundKbps: null,
		inboundKbps: null,
		connectionState: state,
		updatedAt: null
	});
}

function roundMetric(value: number | null, digits = 1): number | null {
	if (value == null || !Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function getVideoQualityTierForNetwork(
	jitterMs: number | null,
	outboundPacketLossPct: number | null,
	inboundPacketLossPct: number | null
): VideoQualityTier {
	const jitter = jitterMs ?? 0;
	const worstLoss = Math.max(outboundPacketLossPct ?? 0, inboundPacketLossPct ?? 0);

	if (jitter >= 80 || worstLoss >= 8) return 'audio-priority';
	if (jitter >= 45 || worstLoss >= 4) return 'low';
	if (jitter >= 25 || worstLoss >= 2) return 'medium';
	return 'high';
}

async function applyAdaptiveVideoQualityTier(nextTier: VideoQualityTier): Promise<void> {
	if (nextTier === activeVideoQualityTier) return;

	const params = VIDEO_QUALITY_TIER_PARAMS[nextTier];
	for (const state of getCallStates()) {
		for (const sender of state.pc.getSenders()) {
			if (sender.track?.kind !== 'video') continue;
			try {
				const current = sender.getParameters();
				if (!current.encodings || current.encodings.length === 0) {
					current.encodings = [{}];
				}
				for (const encoding of current.encodings) {
					encoding.maxBitrate = params.maxBitrate;
					encoding.maxFramerate = params.maxFramerate;
					encoding.scaleResolutionDownBy = params.scaleResolutionDownBy;
				}
				await sender.setParameters(current);
			} catch (error) {
				console.warn('[WebRTC] Failed to apply adaptive video tier:', error);
			}
		}
	}

	activeVideoQualityTier = nextTier;
	const now = Date.now();
	if (now - lastVideoQualityNoticeAt > 12_000) {
		if (nextTier === 'audio-priority') {
			pushNotice('Network unstable: prioritizing audio over video');
		} else if (nextTier === 'low') {
			pushNotice('Network adapting: reducing video quality');
		}
		lastVideoQualityNoticeAt = now;
	}
}

async function sampleCallConnectionDiagnostics(): Promise<void> {
	try {
		const callStates = getCallStates();
		if (!callStates.length) {
			resetCallConnectionDiagnostics(get(connectionState));
			return;
		}

		const preferredState = callStates.find((state) => state.pc.connectionState === 'connected') || callStates[0];
		const stats = await preferredState.pc.getStats();

		let pingMs: number | null = null;
		let jitterMs: number | null = null;
		let outboundPacketLossPct: number | null = null;
		let inboundPacketLossPct: number | null = null;

		let bytesSent = 0;
		let bytesReceived = 0;
		let packetsSent = 0;
		let packetsLostOutbound = 0;
		let packetsReceived = 0;
		let packetsLostInbound = 0;

		let selectedPair: RTCStats | null = null;
		stats.forEach((report) => {
			if (report.type === 'transport') {
				const selectedCandidatePairId = (report as RTCTransportStats).selectedCandidatePairId;
				if (selectedCandidatePairId) {
					const pair = stats.get(selectedCandidatePairId);
					if (pair) {
						selectedPair = pair;
					}
				}
			}
		});

		if (!selectedPair) {
			stats.forEach((report) => {
				if (report.type === 'candidate-pair') {
					const pair = report as RTCStats & {
						selected?: boolean;
						nominated?: boolean;
						state?: string;
						currentRoundTripTime?: number;
					};
					if ((pair.selected || pair.nominated) && pair.state === 'succeeded') {
						selectedPair = report;
					}
				}
			});
		}

		if (selectedPair) {
			const pair = selectedPair as RTCStats & { currentRoundTripTime?: number };
			if (typeof pair.currentRoundTripTime === 'number') {
				pingMs = pair.currentRoundTripTime * 1000;
			}
		}

		stats.forEach((report) => {
			if (report.type === 'outbound-rtp') {
				const outbound = report as RTCOutboundRtpStreamStats & { isRemote?: boolean; packetsLost?: number };
				if (outbound.isRemote) return;
				bytesSent += outbound.bytesSent || 0;
				if (typeof outbound.packetsSent === 'number') {
					packetsSent += outbound.packetsSent;
				}
				if (typeof outbound.packetsLost === 'number') {
					packetsLostOutbound += outbound.packetsLost;
				}
			}

			if (report.type === 'inbound-rtp') {
				const inbound = report as RTCInboundRtpStreamStats & { isRemote?: boolean };
				if (inbound.isRemote) return;
				bytesReceived += inbound.bytesReceived || 0;
				if (typeof inbound.packetsReceived === 'number') {
					packetsReceived += inbound.packetsReceived;
				}
				if (typeof inbound.packetsLost === 'number') {
					packetsLostInbound += inbound.packetsLost;
				}
				if (typeof inbound.jitter === 'number' && inbound.kind === 'audio') {
					jitterMs = inbound.jitter * 1000;
				}
			}
		});

		const outboundPacketTotal = packetsSent + packetsLostOutbound;
		if (outboundPacketTotal > 0) {
			outboundPacketLossPct = (packetsLostOutbound / outboundPacketTotal) * 100;
		}

		const inboundPacketTotal = packetsReceived + packetsLostInbound;
		if (inboundPacketTotal > 0) {
			inboundPacketLossPct = (packetsLostInbound / inboundPacketTotal) * 100;
		}

		const now = Date.now();
		let outboundKbps: number | null = null;
		let inboundKbps: number | null = null;
		if (diagnosticsPrevBytesSample) {
			const elapsedSec = (now - diagnosticsPrevBytesSample.timestamp) / 1000;
			if (elapsedSec > 0) {
				outboundKbps = ((bytesSent - diagnosticsPrevBytesSample.bytesSent) * 8) / elapsedSec / 1000;
				inboundKbps = ((bytesReceived - diagnosticsPrevBytesSample.bytesReceived) * 8) / elapsedSec / 1000;
			}
		}
		diagnosticsPrevBytesSample = { bytesSent, bytesReceived, timestamp: now };

		callConnectionDiagnostics.set({
			pingMs: roundMetric(pingMs, 0),
			jitterMs: roundMetric(jitterMs, 1),
			outboundPacketLossPct: roundMetric(outboundPacketLossPct, 2),
			inboundPacketLossPct: roundMetric(inboundPacketLossPct, 2),
			outboundKbps: roundMetric(outboundKbps, 1),
			inboundKbps: roundMetric(inboundKbps, 1),
			connectionState: get(connectionState),
			updatedAt: now
		});

		const nextTier = getVideoQualityTierForNetwork(jitterMs, outboundPacketLossPct, inboundPacketLossPct);
		await applyAdaptiveVideoQualityTier(nextTier);
	} catch (error) {
		console.warn('[WebRTC] Failed to sample connection diagnostics:', error);
	}
}

export function startCallDiagnosticsPolling(provider: CallStateProvider, noticeHandler: NoticeHandler): void {
	getCallStates = provider;
	pushNotice = noticeHandler;
	if (typeof window === 'undefined') return;
	if (diagnosticsPollInterval !== null) return;
	diagnosticsPollInterval = window.setInterval(() => {
		void sampleCallConnectionDiagnostics();
	}, 2000);
	void sampleCallConnectionDiagnostics();
}

export function stopCallDiagnosticsPolling(state: ConnectionLifecycleState = 'idle'): void {
	if (diagnosticsPollInterval !== null) {
		clearInterval(diagnosticsPollInterval);
		diagnosticsPollInterval = null;
	}
	resetCallConnectionDiagnostics(state);
	activeVideoQualityTier = 'high';
}
