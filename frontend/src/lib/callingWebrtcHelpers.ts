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

export { queueIceCandidate, flushOrphanIceCandidates, dropOrphanIceCandidates, flushIceCandidateQueue } from './callingIce';

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
