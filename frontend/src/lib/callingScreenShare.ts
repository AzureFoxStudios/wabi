/**
 * callingScreenShare.ts
 * Screen Share domain extracted from calling_impl_core.ts
 *
 * Manages starting, stopping, and signaling for WebRTC screen shares.
 */

import { get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import type { PeerConnectionState } from './callingTypes';
import {
	isSharing,
	localScreenStream,
	sfuMediaActive,
	connectionState,
	screenShares,
	callConnectionDiagnostics
} from './callingStateStores';
import { getLivekitRoom } from './callingLivekit';
import { getScreenShareQualityProfile } from './mediaRuntime';
import { prefetchTurnCredentials } from './turnConfig';
import {
	getConnectionKey,
	queueIceCandidate as queuePendingIceCandidate,
	flushIceCandidateQueue as flushQueuedIceCandidates
} from './callingWebrtcHelpers';

// ============================================================================
// Dependency Injection
// ============================================================================

export type ScreenShareDeps = {
	peerConnections: Map<string, PeerConnectionState>;
	cleanupPeerConnection: (key: string) => void;
	createPeerConnection: (
		targetId: string,
		username: string,
		type: PeerConnectionState['type'],
		socket: Socket
	) => RTCPeerConnection;
	addTrackWithOptimizations: (
		pc: RTCPeerConnection,
		track: MediaStreamTrack,
		stream: MediaStream
	) => Promise<void>;
	syncSpatialAudioGraph: () => void;
};

let deps: ScreenShareDeps | null = null;

export function initScreenShareDeps(d: ScreenShareDeps): void {
	deps = d;
}

function requireDeps(): ScreenShareDeps {
	if (!deps) {
		throw new Error('[screenshare] ScreenShareDeps not initialized — call initScreenShareDeps() first');
	}
	return deps;
}

// ============================================================================
// Screen Share Functions
// ============================================================================

export function canScreenShare(): boolean {
	return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

export async function startScreenShare(socket: Socket) {
	if (!canScreenShare()) {
		console.warn('[screenshare] getDisplayMedia not supported on this platform');
		return null;
	}
	if (getLivekitRoom() && get(sfuMediaActive)) {
		await getLivekitRoom()!.localParticipant.setScreenShareEnabled(true);
		isSharing.set(true);
		return null;
	}
	try {
		await prefetchTurnCredentials();
		const screenShareQuality = getScreenShareQualityProfile();
		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: screenShareQuality.constraints,
			audio: true
		});

		// On Linux, getDisplayMedia({ audio: true }) often returns no audio track.
		// Remove dead audio tracks so downstream code doesn't try to use them.
		const audioTracks = stream.getAudioTracks();
		for (const track of audioTracks) {
			if (track.readyState !== 'live' || !track.enabled) {
				stream.removeTrack(track);
				track.stop();
			}
		}

		localScreenStream.set(stream);
		isSharing.set(true);

		socket.emit('start-screen-share');

		// Handle user stopping via browser UI
		stream.getVideoTracks()[0].onended = () => {
			stopScreenShare(socket);
		};

		return stream;
	} catch (error) {
		// User dismissed the screen picker or platform denied access — not a crash
		if (error instanceof DOMException &&
			(error.name === 'NotAllowedError' || error.name === 'NotSupportedError' || error.name === 'AbortError')) {
			return null;
		}
		console.error('Error starting screen share:', error);
		return null;
	}
}

export function stopScreenShare(socket: Socket) {
	const { peerConnections, cleanupPeerConnection, syncSpatialAudioGraph } = requireDeps();

	if (getLivekitRoom() && get(sfuMediaActive)) {
		void getLivekitRoom()!.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
		isSharing.set(false);
		syncSpatialAudioGraph();
		return;
	}
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
	syncSpatialAudioGraph();
}

export async function createScreenShareOffer(socket: Socket, targetId: string) {
	const { peerConnections, createPeerConnection, cleanupPeerConnection, addTrackWithOptimizations } = requireDeps();

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
	const { peerConnections, createPeerConnection, cleanupPeerConnection } = requireDeps();

	await prefetchTurnCredentials();
	const pc = createPeerConnection(senderId, username, 'screen-share-inbound', socket);
	const key = getConnectionKey(senderId, 'screen');

	try {
		await pc.setRemoteDescription(offer);

		const state = peerConnections.get(key);
		if (state) {
			state.hasRemoteDescription = true;
			await flushQueuedIceCandidates(peerConnections, key);
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
	const { peerConnections } = requireDeps();

	const key = getConnectionKey(senderId, 'screen');
	const state = peerConnections.get(key);
	if (!state) {
		console.warn(`[WebRTC] No peer connection for screen share answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		state.hasRemoteDescription = true;
		await flushQueuedIceCandidates(peerConnections, key);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleScreenShareIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	const { peerConnections } = requireDeps();

	const key = getConnectionKey(senderId, 'screen');
	queuePendingIceCandidate(peerConnections, key, candidate);
}