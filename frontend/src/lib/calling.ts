import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { buildRTCConfig, prefetchTurnCredentials } from './turnConfig';
import { playCallActionSound } from './callSounds';
import {
	getAudioCaptureConstraints,
	getStoredAudioProcessingMode,
	getMediaRuntimeConfig,
	getScreenShareQualityProfile,
	resolveCallTransportPlan,
	type AudioProcessingMode,
	type EffectiveCallTransport,
	type CallTransportMode
} from './mediaRuntime';

const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
	width: { ideal: 1280, max: 1920 },
	height: { ideal: 720, max: 1080 },
	frameRate: { ideal: 24, max: 30 }
};

// ============================================================================
// Types
// ============================================================================

export interface Call {
	userId: string;
	username: string;
	stream: MediaStream;
	isVideoEnabled: boolean;
	isAudioEnabled: boolean;
	isSpeaking: boolean;
}

export interface IncomingCall {
	userId: string;
	username: string;
	isVideoCall: boolean;
	channelId?: string;
	channelName?: string;
}

export interface ActiveVoiceChannel {
	id: string;
	name: string;
}

export interface ScreenShare {
	userId: string;
	username: string;
	stream: MediaStream;
}

type ConnectionLifecycleState =
	| 'idle'
	| 'signaling'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'disconnected'
	| 'failed';

export interface CallConnectionDiagnostics {
	pingMs: number | null;
	jitterMs: number | null;
	outboundPacketLossPct: number | null;
	inboundPacketLossPct: number | null;
	outboundKbps: number | null;
	inboundKbps: number | null;
	connectionState: ConnectionLifecycleState;
	updatedAt: number | null;
}

interface PeerConnectionState {
	pc: RTCPeerConnection;
	type: 'call' | 'screen-share-outbound' | 'screen-share-inbound';
	targetId: string;
	username: string;
	lifecycleState: ConnectionLifecycleState;
	iceCandidateQueue: RTCIceCandidateInit[];
	hasRemoteDescription: boolean;
}

type SenderMediaKind = 'audio' | 'video';
type VideoSource = 'camera' | 'screen-share';

// ============================================================================
// Stores
// ============================================================================

export const activeCalls = writable<Call[]>([]);
export const screenShares = writable<ScreenShare[]>([]);
export const incomingCall = writable<IncomingCall | null>(null);
export const isInCall = writable(false);
export const isSharing = writable(false);
export const isMuted = writable(false);
export const isDeafened = writable(false);
export const isVideoOff = writable(false);
export const isLocalSpeaking = writable(false);
export const localStream = writable<MediaStream | null>(null);
export const localScreenStream = writable<MediaStream | null>(null);
export const connectionState = writable<ConnectionLifecycleState>('idle');
export const callConnectionDiagnostics = writable<CallConnectionDiagnostics>({
	pingMs: null,
	jitterMs: null,
	outboundPacketLossPct: null,
	inboundPacketLossPct: null,
	outboundKbps: null,
	inboundKbps: null,
	connectionState: 'idle',
	updatedAt: null
});
export const activeVoiceChannel = writable<ActiveVoiceChannel | null>(null);
export const callMode = writable<'direct' | 'channel' | null>(null);
export const channelCallPanelOpen = writable(false);
export const voiceChannelNotice = writable<{ id: number; text: string } | null>(null);
export const audioProcessingRuntimeStatus = writable<{
	selected: AudioProcessingMode;
	effective: EffectiveAudioProcessingMode;
	fallbackActive: boolean;
	reason: string | null;
}>({
	selected: getStoredAudioProcessingMode(),
	effective: 'dsp',
	fallbackActive: false,
	reason: null
});
export const callTransportState = writable<{
	mode: CallTransportMode;
	activeTransport: EffectiveCallTransport;
	isFallback: boolean;
	reason: string | null;
	gatewayHealthy: boolean;
	checkedAt: number | null;
}>({
	mode: 'auto',
	activeTransport: 'p2p',
	isFallback: false,
	reason: null,
	gatewayHealthy: false,
	checkedAt: null
});

// ============================================================================
// Private State
// ============================================================================

// Single map for ALL peer connections (calls and screen shares)
// Keys are composite: `${targetId}:call` or `${targetId}:screen`
const peerConnections = new Map<string, PeerConnectionState>();
interface SpeakingMonitor {
	intervalId: number;
	analyser: AnalyserNode;
	source: MediaStreamAudioSourceNode;
	data: Uint8Array;
}
const remoteSpeakingMonitors = new Map<string, SpeakingMonitor>();
let localSpeakingMonitor: SpeakingMonitor | null = null;
let speakingAudioContext: AudioContext | null = null;
const SPEAKING_RMS_THRESHOLD = 0.045;
const SPEAKING_POLL_INTERVAL_MS = 120;

// Track call participants for targeted cleanup
const callParticipants = new Set<string>();
let activeVoiceChannelId: string | null = null;
let runtimeAudioModeOverride: EffectiveAudioProcessingMode | null = null;
let performanceGuardInterval: number | null = null;
let performanceLagStrikeCount = 0;
let performanceFallbackApplied = false;
const PERFORMANCE_GUARD_SAMPLE_MS = 1000;
const PERFORMANCE_GUARD_LAG_THRESHOLD_MS = 220;
const PERFORMANCE_GUARD_REQUIRED_STRIKES = 3;
let diagnosticsPollInterval: number | null = null;
let diagnosticsPrevBytesSample: { bytesSent: number; bytesReceived: number; timestamp: number } | null = null;

type EffectiveAudioProcessingMode = 'dsp' | 'rnn' | 'studio';

interface DspAudioPipeline {
	context: AudioContext;
	sourceNode: MediaStreamAudioSourceNode;
	highPass: BiquadFilterNode;
	lowPass: BiquadFilterNode;
	notch: BiquadFilterNode;
	compressor: DynamicsCompressorNode;
	destination: MediaStreamAudioDestinationNode;
	outputTrack: MediaStreamTrack;
}

interface LocalAudioCaptureSession {
	sourceStream: MediaStream;
	outputTrack: MediaStreamTrack;
	mode: EffectiveAudioProcessingMode;
	pipeline?: DspAudioPipeline;
}

let activeAudioCaptureSession: LocalAudioCaptureSession | null = null;

function getRTCConfig(): RTCConfiguration {
	return buildRTCConfig();
}

function supportsNoiseSuppressionConstraint(): boolean {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) return false;
	const supported = navigator.mediaDevices.getSupportedConstraints();
	return supported.noiseSuppression === true;
}

function resolveEffectiveAudioProcessingMode(
	requested: AudioProcessingMode = getStoredAudioProcessingMode()
): EffectiveAudioProcessingMode {
	audioProcessingRuntimeStatus.update(state => ({
		...state,
		selected: requested
	}));

	if (runtimeAudioModeOverride) {
		audioProcessingRuntimeStatus.update(state => ({
			...state,
			effective: runtimeAudioModeOverride as EffectiveAudioProcessingMode,
			fallbackActive: true,
			reason: 'performance_guard'
		}));
		return runtimeAudioModeOverride;
	}

	if (requested === 'auto') {
		const effective = supportsNoiseSuppressionConstraint() ? 'rnn' : 'dsp';
		audioProcessingRuntimeStatus.update(state => ({
			...state,
			effective,
			fallbackActive: false,
			reason: effective === 'dsp' ? 'native_not_supported' : null
		}));
		return effective;
	}
	if (requested === 'rnn' && !supportsNoiseSuppressionConstraint()) {
		audioProcessingRuntimeStatus.update(state => ({
			...state,
			effective: 'dsp',
			fallbackActive: true,
			reason: 'native_not_supported'
		}));
		return 'dsp';
	}
	audioProcessingRuntimeStatus.update(state => ({
		...state,
		effective: requested,
		fallbackActive: false,
		reason: null
	}));
	return requested;
}

function startPerformanceGuard(): void {
	if (typeof window === 'undefined') return;
	if (performanceGuardInterval !== null) return;

	let lastSampleAt = performance.now();
	performanceGuardInterval = window.setInterval(() => {
		const selectedMode = getStoredAudioProcessingMode();
		if (selectedMode !== 'auto') {
			performanceLagStrikeCount = 0;
			return;
		}

		const sessionMode = activeAudioCaptureSession?.mode;
		if (sessionMode !== 'rnn') {
			performanceLagStrikeCount = 0;
			return;
		}

		const now = performance.now();
		const lag = now - lastSampleAt - PERFORMANCE_GUARD_SAMPLE_MS;
		lastSampleAt = now;

		if (lag > PERFORMANCE_GUARD_LAG_THRESHOLD_MS) {
			performanceLagStrikeCount += 1;
		} else {
			performanceLagStrikeCount = Math.max(0, performanceLagStrikeCount - 1);
		}

		if (performanceLagStrikeCount >= PERFORMANCE_GUARD_REQUIRED_STRIKES && !performanceFallbackApplied) {
			performanceFallbackApplied = true;
			runtimeAudioModeOverride = 'dsp';
			void applyCurrentAudioProcessingToLocalTrack().finally(() => {
				pushVoiceChannelNotice('Auto audio fallback: switched to DSP for performance');
			});
		}
	}, PERFORMANCE_GUARD_SAMPLE_MS);
}

function stopPerformanceGuard(): void {
	if (performanceGuardInterval !== null) {
		clearInterval(performanceGuardInterval);
		performanceGuardInterval = null;
	}
	performanceLagStrikeCount = 0;
	performanceFallbackApplied = false;
}

export function clearAudioPerformanceFallbackOverride(): void {
	runtimeAudioModeOverride = null;
	performanceFallbackApplied = false;
	audioProcessingRuntimeStatus.update(state => ({
		...state,
		fallbackActive: false,
		reason: null
	}));
}

function createDspAudioPipeline(sourceStream: MediaStream): DspAudioPipeline {
	const context = new AudioContext({ sampleRate: 48000 });
	const sourceNode = context.createMediaStreamSource(sourceStream);
	const highPass = context.createBiquadFilter();
	highPass.type = 'highpass';
	highPass.frequency.value = 90;
	highPass.Q.value = 0.8;

	const notch = context.createBiquadFilter();
	notch.type = 'notch';
	notch.frequency.value = 60;
	notch.Q.value = 10;

	const lowPass = context.createBiquadFilter();
	lowPass.type = 'lowpass';
	lowPass.frequency.value = 11000;
	lowPass.Q.value = 0.7;

	const compressor = context.createDynamicsCompressor();
	compressor.threshold.value = -24;
	compressor.knee.value = 20;
	compressor.ratio.value = 3;
	compressor.attack.value = 0.003;
	compressor.release.value = 0.18;

	const destination = context.createMediaStreamDestination();
	sourceNode.connect(highPass);
	highPass.connect(notch);
	notch.connect(lowPass);
	lowPass.connect(compressor);
	compressor.connect(destination);

	const outputTrack = destination.stream.getAudioTracks()[0];
	if (!outputTrack) {
		throw new Error('DSP pipeline did not produce an audio track');
	}

	return {
		context,
		sourceNode,
		highPass,
		lowPass,
		notch,
		compressor,
		destination,
		outputTrack
	};
}

function disposeDspAudioPipeline(pipeline: DspAudioPipeline): void {
	try {
		pipeline.sourceNode.disconnect();
		pipeline.highPass.disconnect();
		pipeline.notch.disconnect();
		pipeline.lowPass.disconnect();
		pipeline.compressor.disconnect();
	} catch {
		// no-op
	}
	try {
		pipeline.outputTrack.stop();
	} catch {
		// no-op
	}
	void pipeline.context.close().catch(() => undefined);
}

function disposeAudioCaptureSession(session: LocalAudioCaptureSession): void {
	if (session.pipeline) {
		disposeDspAudioPipeline(session.pipeline);
	} else {
		try {
			session.outputTrack.stop();
		} catch {
			// no-op
		}
	}
	try {
		session.sourceStream.getTracks().forEach(track => track.stop());
	} catch {
		// no-op
	}
}

function clearActiveAudioCaptureSession(): void {
	if (!activeAudioCaptureSession) return;
	disposeAudioCaptureSession(activeAudioCaptureSession);
	activeAudioCaptureSession = null;
}

async function createAudioCaptureSession(): Promise<LocalAudioCaptureSession> {
	const mode = resolveEffectiveAudioProcessingMode();
	const sourceStream = await navigator.mediaDevices.getUserMedia({
		audio: getAudioCaptureConstraints(mode as AudioProcessingMode),
		video: false
	});

	if (mode === 'dsp') {
		const pipeline = createDspAudioPipeline(sourceStream);
		return {
			sourceStream,
			outputTrack: pipeline.outputTrack,
			mode,
			pipeline
		};
	}

	const outputTrack = sourceStream.getAudioTracks()[0];
	if (!outputTrack) {
		sourceStream.getTracks().forEach(track => track.stop());
		throw new Error('Microphone stream has no audio track');
	}

	return {
		sourceStream,
		outputTrack,
		mode
	};
}

function ensureSpeakingAudioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (speakingAudioContext) return speakingAudioContext;
	try {
		speakingAudioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
		return speakingAudioContext;
	} catch (error) {
		console.warn('[WebRTC] Speaking detection unavailable:', error);
		return null;
	}
}

function computeRms(data: Uint8Array): number {
	let sumSquares = 0;
	for (let i = 0; i < data.length; i += 1) {
		const normalized = (data[i] - 128) / 128;
		sumSquares += normalized * normalized;
	}
	return Math.sqrt(sumSquares / data.length);
}

function setRemoteSpeakingState(userId: string, isSpeaking: boolean): void {
	activeCalls.update(calls =>
		calls.map(call => (call.userId === userId ? { ...call, isSpeaking } : call))
	);
}

function stopRemoteSpeakingMonitor(userId: string): void {
	const monitor = remoteSpeakingMonitors.get(userId);
	if (!monitor) return;
	clearInterval(monitor.intervalId);
	try {
		monitor.source.disconnect();
		monitor.analyser.disconnect();
	} catch {
		// no-op
	}
	remoteSpeakingMonitors.delete(userId);
	setRemoteSpeakingState(userId, false);
}

function stopAllRemoteSpeakingMonitors(): void {
	for (const userId of remoteSpeakingMonitors.keys()) {
		stopRemoteSpeakingMonitor(userId);
	}
}

function startRemoteSpeakingMonitor(userId: string, stream: MediaStream): void {
	stopRemoteSpeakingMonitor(userId);

	const audioTrack = stream.getAudioTracks()[0];
	if (!audioTrack || audioTrack.readyState !== 'live') {
		setRemoteSpeakingState(userId, false);
		return;
	}

	const ctx = ensureSpeakingAudioContext();
	if (!ctx) return;

	void ctx.resume().catch(() => undefined);

	const analyser = ctx.createAnalyser();
	analyser.fftSize = 1024;
	analyser.smoothingTimeConstant = 0.5;
	const source = ctx.createMediaStreamSource(stream);
	source.connect(analyser);
	const data = new Uint8Array(analyser.frequencyBinCount);

	const intervalId = window.setInterval(() => {
		if (audioTrack.readyState !== 'live' || !audioTrack.enabled || audioTrack.muted) {
			setRemoteSpeakingState(userId, false);
			return;
		}
		analyser.getByteTimeDomainData(data);
		const speaking = computeRms(data) > SPEAKING_RMS_THRESHOLD;
		setRemoteSpeakingState(userId, speaking);
	}, SPEAKING_POLL_INTERVAL_MS);

	remoteSpeakingMonitors.set(userId, {
		intervalId,
		analyser,
		source,
		data
	});
}

function stopLocalSpeakingMonitor(): void {
	if (!localSpeakingMonitor) {
		isLocalSpeaking.set(false);
		return;
	}
	clearInterval(localSpeakingMonitor.intervalId);
	try {
		localSpeakingMonitor.source.disconnect();
		localSpeakingMonitor.analyser.disconnect();
	} catch {
		// no-op
	}
	localSpeakingMonitor = null;
	isLocalSpeaking.set(false);
}

function startLocalSpeakingMonitor(stream: MediaStream): void {
	stopLocalSpeakingMonitor();

	const audioTrack = stream.getAudioTracks()[0];
	if (!audioTrack || audioTrack.readyState !== 'live') {
		isLocalSpeaking.set(false);
		return;
	}

	const ctx = ensureSpeakingAudioContext();
	if (!ctx) return;

	void ctx.resume().catch(() => undefined);

	const analyser = ctx.createAnalyser();
	analyser.fftSize = 1024;
	analyser.smoothingTimeConstant = 0.5;
	const source = ctx.createMediaStreamSource(stream);
	source.connect(analyser);
	const data = new Uint8Array(analyser.frequencyBinCount);

	const intervalId = window.setInterval(() => {
		if (audioTrack.readyState !== 'live' || !audioTrack.enabled || audioTrack.muted || get(isMuted) || get(isDeafened)) {
			isLocalSpeaking.set(false);
			return;
		}
		analyser.getByteTimeDomainData(data);
		isLocalSpeaking.set(computeRms(data) > SPEAKING_RMS_THRESHOLD);
	}, SPEAKING_POLL_INTERVAL_MS);

	localSpeakingMonitor = {
		intervalId,
		analyser,
		source,
		data
	};
}

// ============================================================================
// Composite Key Helper
// ============================================================================

type ConnectionKeyType = 'call' | 'screen';

function getConnectionKey(targetId: string, type: ConnectionKeyType): string {
	return `${targetId}:${type}`;
}

function keyTypeFromPCType(pcType: PeerConnectionState['type']): ConnectionKeyType {
	return pcType === 'call' ? 'call' : 'screen';
}

// ============================================================================
// ICE Candidate Queue Management
// ============================================================================

function queueIceCandidate(key: string, candidate: RTCIceCandidateInit): void {
	const state = peerConnections.get(key);
	if (!state) {
		console.warn(`[WebRTC] Cannot queue ICE candidate - no peer connection for ${key}`);
		return;
	}

	if (state.hasRemoteDescription) {
		// Remote description already set, apply immediately
		state.pc.addIceCandidate(candidate).catch(err => {
			console.error(`[WebRTC] Failed to add ICE candidate:`, err);
		});
	} else {
		// Queue for later
		state.iceCandidateQueue.push(candidate);
		console.log(`[WebRTC] Queued ICE candidate for ${key} (queue size: ${state.iceCandidateQueue.length})`);
	}
}

async function flushIceCandidateQueue(key: string): Promise<void> {
	const state = peerConnections.get(key);
	if (!state) return;

	const queue = state.iceCandidateQueue;
	state.iceCandidateQueue = [];

	console.log(`[WebRTC] Flushing ${queue.length} queued ICE candidates for ${key}`);

	for (const candidate of queue) {
		try {
			await state.pc.addIceCandidate(candidate);
		} catch (err) {
			console.error(`[WebRTC] Failed to add queued ICE candidate:`, err);
		}
	}
}

function resetCallConnectionDiagnostics(state: ConnectionLifecycleState = 'idle'): void {
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

async function sampleCallConnectionDiagnostics(): Promise<void> {
	try {
		const callStates = [...peerConnections.values()].filter((state) => state.type === 'call');
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
	} catch (error) {
		console.warn('[WebRTC] Failed to sample connection diagnostics:', error);
	}
}

function startCallDiagnosticsPolling(): void {
	if (typeof window === 'undefined') return;
	if (diagnosticsPollInterval !== null) return;
	diagnosticsPollInterval = window.setInterval(() => {
		void sampleCallConnectionDiagnostics();
	}, 2000);
	void sampleCallConnectionDiagnostics();
}

function stopCallDiagnosticsPolling(state: ConnectionLifecycleState = 'idle'): void {
	if (diagnosticsPollInterval !== null) {
		clearInterval(diagnosticsPollInterval);
		diagnosticsPollInterval = null;
	}
	resetCallConnectionDiagnostics(state);
}

// ============================================================================
// Peer Connection Management
// ============================================================================

function createPeerConnection(
	targetId: string,
	username: string,
	type: PeerConnectionState['type'],
	socket: Socket
): RTCPeerConnection {
	const key = getConnectionKey(targetId, keyTypeFromPCType(type));

	// Close existing connection of same type if any (prevents duplicates)
	const existing = peerConnections.get(key);
	if (existing) {
		console.log(`[WebRTC] Closing existing peer connection for ${key}`);
		existing.pc.close();
		peerConnections.delete(key);
	}

	const pc = new RTCPeerConnection(getRTCConfig());

	const state: PeerConnectionState = {
		pc,
		type,
		targetId,
		username,
		lifecycleState: 'signaling',
		iceCandidateQueue: [],
		hasRemoteDescription: false
	};

	peerConnections.set(key, state);
	connectionState.set('signaling');
	if (type === 'call') {
		startCallDiagnosticsPolling();
	}

	// Connection state change handler
	pc.onconnectionstatechange = () => {
		console.log(`[WebRTC] Connection state for ${key}: ${pc.connectionState}`);

		switch (pc.connectionState) {
			case 'connected':
				state.lifecycleState = 'connected';
				connectionState.set('connected');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'connected' }));
				break;
			case 'disconnected':
				state.lifecycleState = 'disconnected';
				connectionState.set('disconnected');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'disconnected' }));
				break;
			case 'failed':
				state.lifecycleState = 'failed';
				connectionState.set('failed');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'failed' }));
				break;
			case 'closed':
				cleanupPeerConnection(key);
				break;
		}
	};

	// ICE connection state (more granular)
	pc.oniceconnectionstatechange = () => {
		console.log(`[WebRTC] ICE connection state for ${key}: ${pc.iceConnectionState}`);

		if (pc.iceConnectionState === 'checking') {
			state.lifecycleState = 'connecting';
			connectionState.set('connecting');
			callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'connecting' }));
		}
	};

	// ICE candidate handler
	pc.onicecandidate = (event) => {
		if (event.candidate) {
			const eventName = type === 'call' ? 'call-ice-candidate' : 'webrtc-ice-candidate';
			socket.emit(eventName, {
				candidate: event.candidate,
				targetId
			});
		}
	};

	// Track handler
	pc.ontrack = (event) => {
		console.log(`[WebRTC] Received track from ${key}:`, event.track.kind);

		const stream = event.streams[0];
		if (!stream) {
			console.warn(`[WebRTC] No stream in ontrack event`);
			return;
		}

		// Handle track ended
		event.track.onended = () => {
			console.log(`[WebRTC] Track ended from ${key}:`, event.track.kind);
			handleRemoteTrackEnded(targetId, key, event.track, type);
		};

		// Handle track muted/unmuted for UI sync
		event.track.onmute = () => {
			console.log(`[WebRTC] Track muted from ${key}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		event.track.onunmute = () => {
			console.log(`[WebRTC] Track unmuted from ${key}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		if (type === 'call') {
			addRemoteCallStream(targetId, username, stream);
		} else if (type === 'screen-share-inbound') {
			addRemoteScreenShare(targetId, username, stream);
		}
	};

	return pc;
}

function preferOpusForAudio(sender: RTCRtpSender, pc: RTCPeerConnection): void {
	const transceiver = pc.getTransceivers().find(t => t.sender === sender);
	if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') {
		return;
	}

	const capabilities = RTCRtpSender.getCapabilities?.('audio');
	if (!capabilities?.codecs?.length) {
		return;
	}

	const opusCodecs = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() === 'audio/opus');
	if (!opusCodecs.length) {
		return;
	}

	const otherCodecs = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() !== 'audio/opus');
	transceiver.setCodecPreferences([...opusCodecs, ...otherCodecs]);
}

async function optimizeSender(sender: RTCRtpSender, pc: RTCPeerConnection, kind: SenderMediaKind, source: VideoSource = 'camera'): Promise<void> {
	try {
		if (kind === 'audio') {
			preferOpusForAudio(sender, pc);
		}

		const params = sender.getParameters();
		if (!params.encodings || params.encodings.length === 0) {
			params.encodings = [{}];
		}

		const runtimeConfig = getMediaRuntimeConfig();

		for (const encoding of params.encodings) {
			if (kind === 'audio') {
				encoding.maxBitrate = runtimeConfig.audioMaxBitrate;
			} else {
				const screenShareQuality = getScreenShareQualityProfile();
				encoding.maxBitrate = source === 'screen-share' ? Math.min(runtimeConfig.screenShareMaxBitrate, screenShareQuality.maxBitrate) : runtimeConfig.videoMaxBitrate;
				encoding.maxFramerate = source === 'screen-share' ? screenShareQuality.maxFramerate : 24;
				typeof encoding.scaleResolutionDownBy === 'number' || (encoding.scaleResolutionDownBy = 1);
			}
		}

		await sender.setParameters(params);
	} catch (error) {
		console.warn('[WebRTC] Could not optimize sender parameters:', error);
	}
}

async function addTrackWithOptimizations(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
	const isScreenShareTrack = stream === get(localScreenStream);
	if (track.kind === 'video') {
		track.contentHint = isScreenShareTrack ? 'detail' : 'motion';
	}

	const sender = pc.addTrack(track, stream);
	await optimizeSender(sender, pc, track.kind as SenderMediaKind, isScreenShareTrack ? 'screen-share' : 'camera');
}

async function renegotiateCallConnection(state: PeerConnectionState, socket: Socket): Promise<void> {
	if (state.type !== 'call') return;

	const offer = await state.pc.createOffer();
	await state.pc.setLocalDescription(offer);

	socket.emit('call-offer', {
		offer,
		targetId: state.targetId
	});
}

function cleanupPeerConnection(key: string): void {
	const state = peerConnections.get(key);
	if (!state) return;

	console.log(`[WebRTC] Cleaning up peer connection for ${key}`);

	try {
		state.pc.close();
	} catch (e) {
		// Ignore close errors
	}

	peerConnections.delete(key);

	// Only clean the relevant store based on connection type
	if (state.type === 'call') {
		stopRemoteSpeakingMonitor(state.targetId);
		callParticipants.delete(state.targetId);
		activeCalls.update(calls => calls.filter(c => c.userId !== state.targetId));
	} else {
		screenShares.update(shares => shares.filter(s => s.userId !== state.targetId));
	}

	// Check if any connections remain
	if (peerConnections.size === 0) {
		connectionState.set('idle');
		stopCallDiagnosticsPolling('idle');
	}
}

// ============================================================================
// Remote Stream/Track Handlers
// ============================================================================

function addRemoteCallStream(userId: string, username: string, stream: MediaStream): void {
	activeCalls.update(calls => {
		const existingIndex = calls.findIndex(c => c.userId === userId);

		// Check actual track enabled states (not just existence)
		const videoTrack = stream.getVideoTracks()[0];
		const audioTrack = stream.getAudioTracks()[0];

		const newCall: Call = {
			userId,
			username: username || 'Unknown',
			stream,
			isVideoEnabled: videoTrack ? videoTrack.enabled : false,
			isAudioEnabled: audioTrack ? audioTrack.enabled : false,
			isSpeaking: false
		};

		if (existingIndex >= 0) {
			calls[existingIndex] = newCall;
			return [...calls];
		} else {
			if (get(callMode) === 'channel' && username) {
				pushVoiceChannelNotice(`${username} joined voice`);
			}
			return [...calls, newCall];
		}
	});

	callParticipants.add(userId);
	startRemoteSpeakingMonitor(userId, stream);
}

function addRemoteScreenShare(userId: string, username: string, stream: MediaStream): void {
	screenShares.update(shares => {
		const existingIndex = shares.findIndex(s => s.userId === userId);

		const newShare: ScreenShare = {
			userId,
			username: username || 'Unknown',
			stream
		};

		if (existingIndex >= 0) {
			shares[existingIndex] = newShare;
			return [...shares];
		} else {
			return [...shares, newShare];
		}
	});
}

function handleRemoteTrackEnded(targetId: string, key: string, track: MediaStreamTrack, type: PeerConnectionState['type']): void {
	if (type === 'call') {
		// Update call state to reflect ended track
		activeCalls.update(calls => {
			return calls.map(call => {
				if (call.userId === targetId) {
					if (track.kind === 'video') {
						return { ...call, isVideoEnabled: false };
					} else if (track.kind === 'audio') {
						return { ...call, isAudioEnabled: false, isSpeaking: false };
					}
				}
				return call;
			});
		});
	} else if (type === 'screen-share-inbound') {
		// Screen share track ended - remove the share
		screenShares.update(shares => shares.filter(s => s.userId !== targetId));
		cleanupPeerConnection(key);
	}
}

function updateRemoteTrackState(targetId: string, track: MediaStreamTrack, type: PeerConnectionState['type']): void {
	if (type !== 'call') return;

	activeCalls.update(calls => {
		return calls.map(call => {
			if (call.userId === targetId) {
				if (track.kind === 'video') {
					return { ...call, isVideoEnabled: !track.muted && track.enabled };
				} else if (track.kind === 'audio') {
					const isAudioEnabled = !track.muted && track.enabled;
					return { ...call, isAudioEnabled, isSpeaking: isAudioEnabled ? call.isSpeaking : false };
				}
			}
			return call;
		});
	});
}

let voiceChannelNoticeId = 0;

function applyLocalTrackPreferences(stream: MediaStream): void {
	const muted = get(isMuted);
	const deafened = get(isDeafened);
	const videoOff = get(isVideoOff);

	const audioTrack = stream.getAudioTracks()[0];
	if (audioTrack) {
		audioTrack.enabled = !(muted || deafened);
	}

	const videoTrack = stream.getVideoTracks()[0];
	if (videoTrack) {
		videoTrack.enabled = !videoOff;
	}
}

function pushVoiceChannelNotice(text: string): void {
	voiceChannelNoticeId += 1;
	const id = voiceChannelNoticeId;
	voiceChannelNotice.set({ id, text });
	setTimeout(() => {
		if (get(voiceChannelNotice)?.id === id) {
			voiceChannelNotice.set(null);
		}
	}, 2400);
}

async function resolveActiveTransport(): Promise<EffectiveCallTransport> {
	const plan = await resolveCallTransportPlan();
	callTransportState.set({
		mode: plan.mode,
		activeTransport: plan.effective,
		isFallback: plan.fallbackApplied,
		reason: plan.reason,
		gatewayHealthy: plan.gatewayHealthy,
		checkedAt: plan.checkedAt
	});

	// SFU control hooks exist, but client media-plane SFU wiring is not live yet.
	// Fall back to P2P while preserving explicit degraded-mode state.
	if (plan.effective === 'sfu') {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: true,
			reason: 'sfu_path_not_implemented_client',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: plan.checkedAt
		});
		return 'p2p';
	}

	return 'p2p';
}

// ============================================================================
// Call Functions
// ============================================================================

async function ensureLocalAudioStream(): Promise<MediaStream> {
	let stream = get(localStream);
	if (!stream) {
		const nextSession = await createAudioCaptureSession();
		const previousSession = activeAudioCaptureSession;
		activeAudioCaptureSession = nextSession;
		if (previousSession) {
			disposeAudioCaptureSession(previousSession);
		}
		stream = new MediaStream([nextSession.outputTrack]);
		localStream.set(stream);
		applyLocalTrackPreferences(stream);
		startLocalSpeakingMonitor(stream);
		return stream;
	}

	const hasActiveAudioTrack = stream.getAudioTracks().some(track => track.readyState === 'live');
	if (hasActiveAudioTrack) {
		return stream;
	}

	const nextSession = await createAudioCaptureSession();
	const previousSession = activeAudioCaptureSession;
	activeAudioCaptureSession = nextSession;
	stream.getAudioTracks().forEach(track => {
		stream.removeTrack(track);
		try {
			track.stop();
		} catch {
			// no-op
		}
	});
	stream.addTrack(nextSession.outputTrack);
	if (previousSession) {
		disposeAudioCaptureSession(previousSession);
	}
	applyLocalTrackPreferences(stream);
	startLocalSpeakingMonitor(stream);
	return stream;
}

export async function joinVoiceChannel(socket: Socket, channelId: string) {
	if (activeVoiceChannelId === channelId) {
		return get(localStream);
	}

	if (activeVoiceChannelId && activeVoiceChannelId !== channelId) {
		await leaveVoiceChannel(socket, activeVoiceChannelId);
	}

	try {
		await prefetchTurnCredentials();
		await resolveActiveTransport();
		const stream = await ensureLocalAudioStream();
		activeVoiceChannelId = channelId;
		callMode.set('channel');
		channelCallPanelOpen.set(false);
		activeVoiceChannel.set({ id: channelId, name: channelId });
		incomingCall.set(null);
		pushVoiceChannelNotice(`Joined voice: ${channelId}`);
		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(true);
		startLocalSpeakingMonitor(stream);
		startPerformanceGuard();
		playCallActionSound('join');
		socket.emit('voice-channel-join', { channelId });
		return stream;
	} catch (error) {
		console.error('Error joining voice channel:', error);
		handleMediaError(error as DOMException, 'starting');
		isInCall.set(false);
		throw error;
	}
}

export async function leaveVoiceChannel(socket: Socket, channelId: string) {
	if (activeVoiceChannelId !== channelId) {
		socket.emit('voice-channel-leave', { channelId });
		return;
	}

	socket.emit('voice-channel-leave', { channelId });
	activeVoiceChannelId = null;
	pushVoiceChannelNotice(`Left voice: ${channelId}`);
	playCallActionSound('leave');

	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}
	clearActiveAudioCaptureSession();

	isInCall.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);
	channelCallPanelOpen.set(false);
	activeVoiceChannel.set(null);
	callMode.set(null);

	const callKeys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'call') {
			callKeys.push(key);
		}
	});
	callKeys.forEach(key => cleanupPeerConnection(key));

	activeCalls.set([]);
	callParticipants.clear();
	stopAllRemoteSpeakingMonitors();
	stopLocalSpeakingMonitor();
	screenShares.set([]);
	if (peerConnections.size === 0) {
		connectionState.set('idle');
	}
	stopPerformanceGuard();
	clearAudioPerformanceFallbackOverride();
	stopCallDiagnosticsPolling('idle');
}

export async function startCall(socket: Socket, targetUserId: string, isVideoCall: boolean = false) {
	try {
		await prefetchTurnCredentials();
		await resolveActiveTransport();
		const stream = await ensureLocalAudioStream();
		if (isVideoCall && !stream.getVideoTracks()[0]) {
			const cameraStream = await navigator.mediaDevices.getUserMedia({
				video: CAMERA_CONSTRAINTS,
				audio: false
			});
			const cameraTrack = cameraStream.getVideoTracks()[0];
			if (cameraTrack) {
				stream.addTrack(cameraTrack);
			}
		}

		isInCall.set(true);
		callMode.set('direct');
		channelCallPanelOpen.set(false);
		activeVoiceChannel.set(null);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);
		startLocalSpeakingMonitor(stream);
		startPerformanceGuard();
		playCallActionSound('join');

		socket.emit('call-initiate', {
			targetUserId,
			isVideoCall
		});

		return stream;
	} catch (error) {
		console.error('Error starting call:', error);
		handleMediaError(error as DOMException, 'starting');
		isInCall.set(false);
		localStream.set(null);
		throw error;
	}
}

export async function answerCall(socket: Socket, callerId: string, isVideoCall: boolean = false) {
	try {
		await prefetchTurnCredentials();
		await resolveActiveTransport();
		const stream = await ensureLocalAudioStream();
		if (isVideoCall && !stream.getVideoTracks()[0]) {
			const cameraStream = await navigator.mediaDevices.getUserMedia({
				video: CAMERA_CONSTRAINTS,
				audio: false
			});
			const cameraTrack = cameraStream.getVideoTracks()[0];
			if (cameraTrack) {
				stream.addTrack(cameraTrack);
			}
		}

		isInCall.set(true);
		callMode.set('direct');
		channelCallPanelOpen.set(false);
		activeVoiceChannel.set(null);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);
		startLocalSpeakingMonitor(stream);
		startPerformanceGuard();
		playCallActionSound('join');

		socket.emit('call-answer', {
			callerId,
			isVideoCall
		});

		incomingCall.set(null);

		return stream;
	} catch (error) {
		console.error('Error answering call:', error);
		handleMediaError(error as DOMException, 'answering');
		isInCall.set(false);
		localStream.set(null);
		throw error;
	}
}

export function rejectCall(socket: Socket, callerId: string) {
	socket.emit('call-reject', { callerId });
	incomingCall.set(null);
}

export function endCall(socket: Socket) {
	playCallActionSound('leave');

	// Stop local media tracks
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}
	clearActiveAudioCaptureSession();

	// Reset call state
	isInCall.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);
	channelCallPanelOpen.set(false);
	activeVoiceChannel.set(null);
	callMode.set(null);

	// Notify server with participant list for targeted cleanup
	socket.emit('call-end', {
		participants: Array.from(callParticipants)
	});

	// Close all call peer connections (collect keys first to avoid mutation during iteration)
	const callKeys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'call') {
			callKeys.push(key);
		}
	});
	callKeys.forEach(key => cleanupPeerConnection(key));

	activeCalls.set([]);
	callParticipants.clear();
	activeVoiceChannelId = null;
	stopAllRemoteSpeakingMonitors();
	stopLocalSpeakingMonitor();
	stopPerformanceGuard();
	clearAudioPerformanceFallbackOverride();
	connectionState.set('idle');
}

// ============================================================================
// Audio/Video Controls
// ============================================================================

export function toggleMute() {
	const stream = get(localStream);
	if (stream) {
		const audioTrack = stream.getAudioTracks()[0];
		if (audioTrack) {
			audioTrack.enabled = !audioTrack.enabled;
			const nextMuted = !audioTrack.enabled;
			isMuted.set(nextMuted);
			if (nextMuted) {
				isLocalSpeaking.set(false);
			}
			playCallActionSound(nextMuted ? 'mute' : 'unmute');
		}
	}
}

export async function applyCurrentAudioProcessingToLocalTrack(): Promise<void> {
	const stream = get(localStream);
	if (!stream) return;
	const existingAudioTrack = stream.getAudioTracks()[0];
	if (!existingAudioTrack || existingAudioTrack.readyState !== 'live') return;

	const previousSession = activeAudioCaptureSession;
	const nextSession = await createAudioCaptureSession();
	stream.removeTrack(existingAudioTrack);
	stream.addTrack(nextSession.outputTrack);
	applyLocalTrackPreferences(stream);
	startLocalSpeakingMonitor(stream);

	activeAudioCaptureSession = nextSession;
	if (previousSession) {
		disposeAudioCaptureSession(previousSession);
	}
	try {
		existingAudioTrack.stop();
	} catch {
		// no-op
	}

	const tasks: Promise<unknown>[] = [];
	peerConnections.forEach((state) => {
		if (state.type !== 'call') return;
		const sender = state.pc.getSenders().find(s => s.track?.kind === 'audio');
		if (!sender) return;
		tasks.push(sender.replaceTrack(nextSession.outputTrack));
		tasks.push(optimizeSender(sender, state.pc, 'audio'));
	});
	const results = await Promise.allSettled(tasks);
	if (results.some(result => result.status === 'rejected')) {
		console.warn('[WebRTC] Audio mode switched locally, but one or more peer senders failed to update.');
	}
}

export function toggleDeafen() {
	const currentlyDeafened = get(isDeafened);
	isDeafened.set(!currentlyDeafened);
	playCallActionSound(currentlyDeafened ? 'undeafen' : 'deafen');

	if (!currentlyDeafened) {
		// Becoming deafened - also mute self
		const stream = get(localStream);
		if (stream) {
			const audioTrack = stream.getAudioTracks()[0];
			if (audioTrack) {
				audioTrack.enabled = false;
				isMuted.set(true);
				isLocalSpeaking.set(false);
			}
		}
	}
	// Note: Actual deafen (muting remote audio) is handled in the UI component
	// by setting audio elements to muted based on isDeafened store
}

export async function toggleVideo(socket?: Socket) {
	const stream = get(localStream);
	if (!stream) {
		return;
	}

	const existingTrack = stream.getVideoTracks()[0];
	if (existingTrack) {
		existingTrack.enabled = !existingTrack.enabled;
		isVideoOff.set(!existingTrack.enabled);
		return;
	}

	try {
		const cameraStream = await navigator.mediaDevices.getUserMedia({
			video: CAMERA_CONSTRAINTS,
			audio: false
		});
		const cameraTrack = cameraStream.getVideoTracks()[0];
		if (!cameraTrack) {
			return;
		}

		stream.addTrack(cameraTrack);

		const renegotiationTasks: Promise<void>[] = [];
		peerConnections.forEach(state => {
			if (state.type !== 'call') return;

			const existingSender = state.pc.getSenders().find(sender => sender.track?.kind === 'video');
			if (existingSender) {
				renegotiationTasks.push(existingSender.replaceTrack(cameraTrack));
				renegotiationTasks.push(optimizeSender(existingSender, state.pc, 'video', 'camera'));
			} else {
				renegotiationTasks.push(addTrackWithOptimizations(state.pc, cameraTrack, stream));
			}

			if (socket) {
				renegotiationTasks.push(renegotiateCallConnection(state, socket));
			}
		});

		await Promise.all(renegotiationTasks);
		isVideoOff.set(false);
	} catch (error) {
		console.error('[WebRTC] Could not enable camera track:', error);
		handleMediaError(error as DOMException, 'starting');
	}
}

// ============================================================================
// WebRTC Signaling Handlers (called from socket.ts)
// ============================================================================

export async function createCallOffer(socket: Socket, targetId: string, username: string = '') {
	await prefetchTurnCredentials();
	const pc = createPeerConnection(targetId, username, 'call', socket);
	const key = getConnectionKey(targetId, 'call');

	const stream = get(localStream);
	if (stream) {
		for (const track of stream.getTracks()) {
			await addTrackWithOptimizations(pc, track, stream);
		}
	}

	try {
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);

		socket.emit('call-offer', {
			offer,
			targetId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to create call offer:', err);
		cleanupPeerConnection(key);
	}
}

export async function handleCallOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit
) {
	await prefetchTurnCredentials();
	const pc = createPeerConnection(senderId, username, 'call', socket);
	const key = getConnectionKey(senderId, 'call');

	const stream = get(localStream);
	if (stream) {
		for (const track of stream.getTracks()) {
			await addTrackWithOptimizations(pc, track, stream);
		}
	}

	try {
		await pc.setRemoteDescription(offer);

		// Mark remote description as set and flush queue
		const state = peerConnections.get(key);
		if (state) {
			state.hasRemoteDescription = true;
			await flushIceCandidateQueue(key);
		}

		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);

		socket.emit('call-answer-sdp', {
			answer,
			targetId: senderId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to handle call offer:', err);
		cleanupPeerConnection(key);
	}
}

export async function handleCallAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const key = getConnectionKey(senderId, 'call');
	const state = peerConnections.get(key);
	if (!state) {
		console.warn(`[WebRTC] No peer connection for call answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(key);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleCallIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	const key = getConnectionKey(senderId, 'call');
	queueIceCandidate(key, candidate);
}

// ============================================================================
// Screen Share Functions
// ============================================================================

export async function startScreenShare(socket: Socket) {
	try {
		await prefetchTurnCredentials();
		const screenShareQuality = getScreenShareQualityProfile();
		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: screenShareQuality.constraints,
			audio: true
		});

		localScreenStream.set(stream);
		isSharing.set(true);

		socket.emit('start-screen-share');

		// Handle user stopping via browser UI
		stream.getVideoTracks()[0].onended = () => {
			stopScreenShare(socket);
		};

		return stream;
	} catch (error) {
		// User clicked Cancel on the screen picker — not an error
		if (error instanceof DOMException && error.name === 'NotAllowedError') {
			return null;
		}
		console.error('Error starting screen share:', error);
		throw error;
	}
}

export function stopScreenShare(socket: Socket) {
	const stream = get(localScreenStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localScreenStream.set(null);
	}

	isSharing.set(false);
	socket.emit('stop-screen-share');

	// Close all outbound screen share connections (collect keys first)
	const outboundKeys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'screen-share-outbound') {
			outboundKeys.push(key);
		}
	});
	outboundKeys.forEach(key => cleanupPeerConnection(key));
}

export async function createScreenShareOffer(socket: Socket, targetId: string) {
	await prefetchTurnCredentials();
	const pc = createPeerConnection(targetId, '', 'screen-share-outbound', socket);
	const key = getConnectionKey(targetId, 'screen');

	const stream = get(localScreenStream);
	if (stream) {
		for (const track of stream.getTracks()) {
			await addTrackWithOptimizations(pc, track, stream);
		}
	}

	try {
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);

		socket.emit('webrtc-offer', {
			offer,
			targetId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to create screen share offer:', err);
		cleanupPeerConnection(key);
	}
}

export async function handleScreenShareOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit
) {
	await prefetchTurnCredentials();
	const pc = createPeerConnection(senderId, username, 'screen-share-inbound', socket);
	const key = getConnectionKey(senderId, 'screen');

	try {
		await pc.setRemoteDescription(offer);

		const state = peerConnections.get(key);
		if (state) {
			state.hasRemoteDescription = true;
			await flushIceCandidateQueue(key);
		}

		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);

		socket.emit('webrtc-answer', {
			answer,
			targetId: senderId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to handle screen share offer:', err);
		cleanupPeerConnection(key);
	}
}

export async function handleScreenShareAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const key = getConnectionKey(senderId, 'screen');
	const state = peerConnections.get(key);
	if (!state) {
		console.warn(`[WebRTC] No peer connection for screen share answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(key);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleScreenShareIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	const key = getConnectionKey(senderId, 'screen');
	queueIceCandidate(key, candidate);
}

// ============================================================================
// Cleanup Functions
// ============================================================================

export function removeCall(userId: string) {
	cleanupPeerConnection(getConnectionKey(userId, 'call'));
	if (get(callMode) === 'channel') {
		const call = get(activeCalls).find(c => c.userId === userId);
		if (call?.username) {
			pushVoiceChannelNotice(`${call.username} left voice`);
		}
	}
}

export function removeScreenShare(userId: string) {
	cleanupPeerConnection(getConnectionKey(userId, 'screen'));
}

export function cleanupAllConnections() {
	// Stop all local media
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}
	clearActiveAudioCaptureSession();

	const screenStream = get(localScreenStream);
	if (screenStream) {
		screenStream.getTracks().forEach(track => track.stop());
		localScreenStream.set(null);
	}

	// Close all peer connections
	peerConnections.forEach((state) => {
		try {
			state.pc.close();
		} catch (e) {
			// Ignore
		}
	});

	peerConnections.clear();
	callParticipants.clear();
	activeVoiceChannelId = null;
	stopAllRemoteSpeakingMonitors();
	stopLocalSpeakingMonitor();
	stopPerformanceGuard();
	clearAudioPerformanceFallbackOverride();

	// Reset all stores
	activeCalls.set([]);
	screenShares.set([]);
	isInCall.set(false);
	isSharing.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);
	isLocalSpeaking.set(false);
	channelCallPanelOpen.set(false);
	connectionState.set('idle');
}

export function openChannelCallPanel(): void {
	channelCallPanelOpen.set(true);
}

export function closeChannelCallPanel(): void {
	channelCallPanelOpen.set(false);
}

export function toggleChannelCallPanel(): void {
	channelCallPanelOpen.update((open) => !open);
}

// ============================================================================
// Utility Functions
// ============================================================================

function handleMediaError(error: DOMException, action: string) {
	if (error.name === 'NotAllowedError') {
		alert(`Permission denied: Please allow camera and microphone access to ${action === 'starting' ? 'start' : 'answer'} a call.`);
	} else if (error.name === 'NotFoundError') {
		alert(`No camera or microphone found to ${action === 'starting' ? 'start' : 'answer'} the call.`);
	} else if (error.name === 'NotReadableError' || error.name === 'OverconstrainedError') {
		alert('Camera or microphone is in use or inaccessible. Please close other applications that might be using it.');
	} else {
		alert(`Error ${action} call: ${error.message}`);
	}
}

// Update username for a call (called when username info becomes available)
export function updateCallUsername(userId: string, username: string) {
	// Update all peer connection states for this user
	const callKey = getConnectionKey(userId, 'call');
	const screenKey = getConnectionKey(userId, 'screen');
	const callState = peerConnections.get(callKey);
	if (callState) {
		callState.username = username;
	}
	const screenState = peerConnections.get(screenKey);
	if (screenState) {
		screenState.username = username;
	}

	activeCalls.update(calls => {
		return calls.map(call => {
			if (call.userId === userId) {
				return { ...call, username };
			}
			return call;
		});
	});

	screenShares.update(shares => {
		return shares.map(share => {
			if (share.userId === userId) {
				return { ...share, username };
			}
			return share;
		});
	});
}
