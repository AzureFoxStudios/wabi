import {
	getMediaRuntimeConfig,
	getScreenShareBitrateOverrideBps,
	getScreenShareQualityProfile
} from './mediaRuntime';
import type { PeerConnectionState, SenderMediaKind, VideoSource } from './callingTypes';
import { addPeerMicrophone, gatePeerMicrophone } from './peerMicrophone';

export type ConnectionKeyType = 'call' | 'screen';

export function getConnectionKey(targetId: string, type: ConnectionKeyType): string {
	return `${targetId}:${type}`;
}

export function keyTypeFromPCType(pcType: PeerConnectionState['type']): ConnectionKeyType {
	return pcType === 'call' ? 'call' : 'screen';
}

// ICE candidates that arrive before their peer connection exists (offer/
// answer and trickle race: the remote's trickle can land before our
// createPeerConnection runs). Dropping them breaks cross-network joins where
// every srflx/relay candidate counts — park per key and flush on creation.
const orphanIceCandidates = new Map<string, Array<{ candidate: RTCIceCandidateInit; at: number }>>();
const ORPHAN_ICE_CAP = 50;
// Candidates outlive the PC generation they were trickled for (re-offer
// recreates the PC with a new ufrag; adding the old ones then fails with
// "Unknown ufrag" noise). Drop parked entries older than this at flush.
const ORPHAN_ICE_MAX_AGE_MS = 30_000;

export function queueIceCandidate(
	peerConnections: Map<string, PeerConnectionState>,
	key: string,
	candidate: RTCIceCandidateInit
): void {
	const state = peerConnections.get(key);
	if (!state) {
		let parked = orphanIceCandidates.get(key);
		if (!parked) {
			parked = [];
			orphanIceCandidates.set(key, parked);
		}
		if (parked.length < ORPHAN_ICE_CAP) parked.push({ candidate, at: Date.now() });
		console.log(`[WebRTC] Parked early ICE candidate for ${key} (no PC yet, parked: ${parked.length})`);
		return;
	}

	if (state.hasRemoteDescription) {
		state.pc.addIceCandidate(candidate).catch(err => {
			console.error('[WebRTC] Failed to add ICE candidate:', err);
		});
	} else {
		state.iceCandidateQueue.push(candidate);
		console.log(`[WebRTC] Queued ICE candidate for ${key} (queue size: ${state.iceCandidateQueue.length})`);
	}
}

/**
 * Drain candidates parked by queueIceCandidate before the PC existed into the
 * fresh connection (queued if no remote description yet, added directly if
 * set). Called once, right after the PC is stored.
 */
export function flushOrphanIceCandidates(
	peerConnections: Map<string, PeerConnectionState>,
	key: string
): void {
	const parked = orphanIceCandidates.get(key);
	if (!parked || parked.length === 0) return;
	orphanIceCandidates.delete(key);
	const state = peerConnections.get(key);
	if (!state) return;
	const now = Date.now();
	const fresh = parked.filter((p) => now - p.at < ORPHAN_ICE_MAX_AGE_MS);
	if (fresh.length < parked.length) {
		console.log(`[WebRTC] Dropped ${parked.length - fresh.length} stale parked ICE candidate(s) for ${key} (older generation)`);
	}
	for (const { candidate } of fresh) {
		if (state.hasRemoteDescription) {
			state.pc.addIceCandidate(candidate).catch(err => {
				console.error('[WebRTC] Failed to add parked ICE candidate:', err);
			});
		} else {
			state.iceCandidateQueue.push(candidate);
		}
	}
	console.log(`[WebRTC] Flushed ${fresh.length} parked ICE candidate(s) for ${key}`);
}

/** Drop parked candidates for a torn-down connection so the map can't leak. */
export function dropOrphanIceCandidates(key: string): void {
	orphanIceCandidates.delete(key);
}

export async function flushIceCandidateQueue(
	peerConnections: Map<string, PeerConnectionState>,
	key: string
): Promise<void> {
	const state = peerConnections.get(key);
	if (!state) return;

	const queue = state.iceCandidateQueue;
	state.iceCandidateQueue = [];

	console.log(`[WebRTC] Flushing ${queue.length} queued ICE candidates for ${key}`);

	for (const candidate of queue) {
		try {
			await state.pc.addIceCandidate(candidate);
		} catch (err) {
			console.error('[WebRTC] Failed to add queued ICE candidate:', err);
		}
	}
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

export async function optimizeSender(
	sender: RTCRtpSender,
	pc: RTCPeerConnection,
	kind: SenderMediaKind,
	source: VideoSource = 'camera'
): Promise<void> {
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
				if (source === 'screen-share') {
					const overrideBitrate = getScreenShareBitrateOverrideBps();
					if (overrideBitrate != null) {
						encoding.maxBitrate = overrideBitrate;
					} else if (screenShareQuality.maxBitrate == null) {
						delete encoding.maxBitrate;
					} else {
						encoding.maxBitrate = Math.min(runtimeConfig.screenShareMaxBitrate, screenShareQuality.maxBitrate);
					}
				} else {
					encoding.maxBitrate = runtimeConfig.videoMaxBitrate;
				}
				encoding.maxFramerate = source === 'screen-share' ? screenShareQuality.maxFramerate : 24;
				typeof encoding.scaleResolutionDownBy === 'number' || (encoding.scaleResolutionDownBy = 1);
			}
		}

		await sender.setParameters(params);
	} catch (error) {
		console.warn('[WebRTC] Could not optimize sender parameters:', error);
	}
}

export async function addOptimizedTrack(
	pc: RTCPeerConnection,
	track: MediaStreamTrack,
	stream: MediaStream,
	source: VideoSource = 'camera'
): Promise<void> {
	if (track.kind === 'video') {
		track.contentHint = source === 'screen-share' ? 'detail' : 'motion';
	}

	const sender = track.kind === 'audio' && source !== 'screen-share'
		? addPeerMicrophone(pc, track, stream)
		: pc.addTrack(track, stream);
	await optimizeSender(sender, pc, track.kind as SenderMediaKind, source);
}

export async function setPeerAudioSendEnabled(
	pc: RTCPeerConnection,
	enabled: boolean
): Promise<void> {
	gatePeerMicrophone(pc, enabled);
}
