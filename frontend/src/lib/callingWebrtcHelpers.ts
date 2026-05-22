import {
	getMediaRuntimeConfig,
	getScreenShareBitrateOverrideBps,
	getScreenShareQualityProfile
} from './mediaRuntime';
import type { PeerConnectionState, SenderMediaKind, VideoSource } from './callingTypes';

export type ConnectionKeyType = 'call' | 'screen';

export function getConnectionKey(targetId: string, type: ConnectionKeyType): string {
	return `${targetId}:${type}`;
}

export function keyTypeFromPCType(pcType: PeerConnectionState['type']): ConnectionKeyType {
	return pcType === 'call' ? 'call' : 'screen';
}

export function queueIceCandidate(
	peerConnections: Map<string, PeerConnectionState>,
	key: string,
	candidate: RTCIceCandidateInit
): void {
	const state = peerConnections.get(key);
	if (!state) {
		console.warn(`[WebRTC] Cannot queue ICE candidate - no peer connection for ${key}`);
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

	const sender = pc.addTrack(track, stream);
	await optimizeSender(sender, pc, track.kind as SenderMediaKind, source);
}

export async function setPeerAudioSendEnabled(
	pc: RTCPeerConnection,
	enabled: boolean
): Promise<void> {
	const audioSenders = pc.getSenders().filter((sender) => sender.track?.kind === 'audio');
	await Promise.all(audioSenders.map(async (sender) => {
		try {
			const params = sender.getParameters();
			if (!params.encodings || params.encodings.length === 0) {
				params.encodings = [{ active: enabled }];
			} else {
				params.encodings = params.encodings.map((encoding) => ({ ...encoding, active: enabled }));
			}
			await sender.setParameters(params);
		} catch (error) {
			console.warn('[WebRTC] Could not adjust peer audio sender parameters:', error);
		}
	}));
}
