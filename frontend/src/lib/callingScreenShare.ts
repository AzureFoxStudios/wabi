/**
 * callingScreenShare.ts
 * Screen Share domain extracted from calling_impl_core.ts
 *
 * Manages starting, stopping, and signaling for WebRTC screen shares.
 */

import { get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import type { PeerConnectionState, CallMediaScope } from './callingTypes';
import {
	isSharing,
	localScreenStream,
	localScreenShareSessionId,
	sfuMediaActive
} from './callingStateStores';
import { getLivekitRoom, getLivekitChannelId } from './callingLivekit';
import { getScreenShareQualityProfile } from './mediaRuntime';
import { prefetchTurnCredentials } from './turnConfig';
// Keep transport selection before the display picker, within user activation.
import { wabidbVideoTransportLive, wabidbStartVideo, wabidbStopVideoSource } from './callingWabidb';
import { groupMembership } from './groupAccess';
import { showToast } from './toast';
import { requestScreenShareAdmission } from './screenShareAdmission';
import {
	getConnectionKey,
	queueIceCandidate as queuePendingIceCandidate,
	flushIceCandidateQueue as flushQueuedIceCandidates
} from './callingWebrtcHelpers';

// ============================================================================
// Dependency Injection
// ============================================================================

export type ScreenShareDeps = {
	captureScope: () => CallMediaScope | null;
	receiveScope: (channelId: string | undefined, peerId: string) => CallMediaScope | null;
	peerConnections: Map<string, PeerConnectionState>;
	cleanupPeerConnection: (key: string) => void;
	createPeerConnection: (
		targetId: string,
		username: string,
		type: PeerConnectionState['type'],
		socket: Socket,
		metadata?: Pick<PeerConnectionState, 'channelId' | 'mediaRequestId'>
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

type ShareOwner = {
	id: string; socket: Socket; socketId: string | undefined; scope: CallMediaScope;
	stream: MediaStream | null; room: ReturnType<typeof getLivekitRoom>;
	promise: Promise<MediaStream | null>; relay: boolean;
	controller: AbortController; disconnected: () => void;
};
let shareOwner: ShareOwner | null = null;
const targetChannel = (owner: ShareOwner) => owner.scope.channelId ?? owner.scope.peerUserId;
const ownerCurrent = (owner: ShareOwner) => shareOwner === owner && owner.scope.current() &&
	owner.socket.connected && owner.socket.id === owner.socketId;
function wireScope(scope: CallMediaScope) {
	return { channelId: scope.channelId, membershipRevision: scope.channelId ? groupMembership.revision(scope.channelId) : undefined };
}

export function startScreenShare(socket: Socket): Promise<MediaStream | null> {
	if (shareOwner && ownerCurrent(shareOwner)) return shareOwner.promise;
	const { captureScope } = requireDeps();
	const scope = captureScope();
	if (!canScreenShare()) {
		showToast('Screen sharing is not supported by this browser. Try the desktop app or a supported desktop browser.', 'warning');
		return Promise.resolve(null);
	}
	if (!socket.connected || !scope?.current()) return Promise.resolve(null);
	if (shareOwner) stopOwnedShare(shareOwner, true);
	const room = getLivekitRoom();
	const owner: ShareOwner = {
		id: crypto.randomUUID(), socket, socketId: socket.id, scope, stream: null,
		controller: new AbortController(), disconnected: () => stopOwnedShare(owner, false),
		room: room && get(sfuMediaActive) && getLivekitChannelId() === scope.channelId ? room : null,
		relay: wabidbVideoTransportLive(scope.channelId ?? scope.peerUserId),
		promise: null as unknown as Promise<MediaStream | null>
	};
	shareOwner = owner;
	socket.on('disconnect', owner.disconnected);
	owner.promise = (async () => {
		let stream: MediaStream | null = null;
		try {
			if (owner.room) {
				const publication = await owner.room.localParticipant.setScreenShareEnabled(true);
				const track = publication?.track?.mediaStreamTrack;
				if (!track) throw new Error('Screen share did not produce a video track');
				stream = new MediaStream([track]);
			} else {
				// Keep the picker within the user's activation; TURN is fetched
				// later by peer negotiation, not before getDisplayMedia.
				stream = await navigator.mediaDevices.getDisplayMedia({
					video: getScreenShareQualityProfile().constraints, audio: true
				});
			}
			if (!ownerCurrent(owner)) {
				stream.getTracks().forEach(track => track.stop());
				if (shareOwner === owner) stopOwnedShare(owner, false);
				return null;
			}
			owner.stream = stream;
			for (const track of stream.getAudioTracks()) {
				if (track.readyState !== 'live' || !track.enabled) { stream.removeTrack(track); track.stop(); }
			}
			const video = stream.getVideoTracks().find(track => track.readyState === 'live');
			if (!video) throw new Error('Screen share did not produce a live video track');
			await requestScreenShareAdmission(socket, { ...wireScope(scope), requestId: owner.id, targetUserId: scope.peerUserId }, owner.controller.signal);
			if (!ownerCurrent(owner)) throw new DOMException('Screen share cancelled', 'AbortError');
			if (owner.relay && !await wabidbStartVideo('screen', stream, targetChannel(owner), () => ownerCurrent(owner))) {
				throw new Error('Screen share relay could not start');
			}
			if (!ownerCurrent(owner)) {
				stream.getTracks().forEach(track => track.stop());
				if (shareOwner === owner) stopOwnedShare(owner, false);
				return null;
			}
			localScreenShareSessionId.set(scope.channelId ?? `direct:${scope.peerUserId}`);
			localScreenStream.set(stream); isSharing.set(true);
			video.onended = () => { if (shareOwner === owner) stopOwnedShare(owner, true); };
			return stream;
		} catch (error) {
			const report = shareOwner === owner && owner.scope.current();
			stream?.getTracks().forEach(track => track.stop());
			if (shareOwner === owner) stopOwnedShare(owner, false);
			if (!(error instanceof DOMException && ['AbortError', 'NotAllowedError', 'NotSupportedError'].includes(error.name))) {
				console.error('[screenshare] Could not start:', error);
				if (report) showToast(error instanceof Error ? error.message : 'Screen sharing could not start.', 'warning');
			}
			return null;
		}
	})();
	return owner.promise;
}

function stopOwnedShare(owner: ShareOwner, notify: boolean): void {
	if (shareOwner !== owner) return;
	const stillAdmitted = ownerCurrent(owner);
	shareOwner = null; // onended/late permission cannot stop a replacement
	owner.socket.off('disconnect', owner.disconnected);
	owner.controller.abort();
	wabidbStopVideoSource('screen', targetChannel(owner));
	if (owner.room) void owner.room.localParticipant.setScreenShareEnabled(false).catch(() => {});
	owner.stream?.getTracks().forEach(track => track.stop());
	if (get(localScreenStream) === owner.stream) {
		localScreenStream.set(null); localScreenShareSessionId.set(null);
	}
	isSharing.set(false);
	const { peerConnections, cleanupPeerConnection, syncSpatialAudioGraph } = requireDeps();
	for (const [key, state] of peerConnections) {
		if (state.type === 'screen-share-outbound' && state.mediaRequestId === owner.id) cleanupPeerConnection(key);
	}
	if (notify && stillAdmitted) owner.socket.emit('stop-screen-share', {
		...wireScope(owner.scope), requestId: owner.id, targetUserId: owner.scope.peerUserId
	});
	syncSpatialAudioGraph();
}

export function stopScreenShare(_socket: Socket): void {
	if (shareOwner) stopOwnedShare(shareOwner, true);
}

export function cancelChannelScreenShare(channelId: string): void {
	if (shareOwner?.scope.channelId === channelId) stopOwnedShare(shareOwner, false);
}

export function screenShareTargetsCurrent(requestId?: string): boolean {
	return !!shareOwner && ownerCurrent(shareOwner) && !shareOwner.relay && !shareOwner.room &&
		!!shareOwner.stream && (!requestId || requestId === shareOwner.id);
}

export function rejectScreenShare(requestId: string): void {
	if (shareOwner?.id === requestId) {
		stopOwnedShare(shareOwner, false);
		showToast('Screen sharing was refused because this call is no longer available.', 'warning');
	}
}

export async function createScreenShareOffer(socket: Socket, targetId: string, requestId?: string) {
	const owner = shareOwner;
	if (!owner || !screenShareTargetsCurrent(requestId)) return;
	const { peerConnections, createPeerConnection, cleanupPeerConnection, addTrackWithOptimizations } = requireDeps();
	await prefetchTurnCredentials();
	if (!ownerCurrent(owner)) return;
	const key = getConnectionKey(targetId, 'screen');
	const previous = peerConnections.get(key);
	if (previous && previous.channelId !== owner.scope.channelId) return;
	const pc = createPeerConnection(targetId, '', 'screen-share-outbound', socket, { channelId: owner.scope.channelId, mediaRequestId: owner.id });
	const state = peerConnections.get(key)!;
	state.channelId = owner.scope.channelId; state.mediaRequestId = owner.id;
	try {
		for (const track of owner.stream!.getTracks()) {
			if (!ownerCurrent(owner)) throw new DOMException('Screen share cancelled', 'AbortError');
			await addTrackWithOptimizations(pc, track, owner.stream!);
		}
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		if (!ownerCurrent(owner) || peerConnections.get(key) !== state) throw new DOMException('Screen offer superseded', 'AbortError');
		socket.emit('webrtc-offer', { offer, targetId, ...wireScope(owner.scope), requestId: owner.id });
	} catch (error) {
		if (peerConnections.get(key) === state) cleanupPeerConnection(key);
		if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('[screenshare] Offer failed:', error);
	}
}

export async function handleScreenShareOffer(
	socket: Socket, senderId: string, username: string, offer: RTCSessionDescriptionInit,
	channelId?: string, requestId?: string
) {
	const { peerConnections, createPeerConnection, cleanupPeerConnection, receiveScope } = requireDeps();
	const scope = receiveScope(channelId, senderId);
	if (!scope?.current()) return;
	const socketId = socket.id;
	const current = () => scope.current() && socket.connected && socket.id === socketId;
	await prefetchTurnCredentials();
	if (!current()) return;
	const key = getConnectionKey(senderId, 'screen');
	const previous = peerConnections.get(key);
	if (previous && previous.channelId !== channelId) return;
	const pc = createPeerConnection(senderId, username, 'screen-share-inbound', socket, { channelId, mediaRequestId: requestId });
	const state = peerConnections.get(key)!;
	state.channelId = channelId; state.mediaRequestId = requestId;
	try {
		await pc.setRemoteDescription(offer);
		if (!current() || peerConnections.get(key) !== state) throw new DOMException('Screen answer superseded', 'AbortError');
		state.hasRemoteDescription = true;
		await flushQueuedIceCandidates(peerConnections, key);
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		if (!current() || peerConnections.get(key) !== state) throw new DOMException('Screen answer superseded', 'AbortError');
		socket.emit('webrtc-answer', { answer, targetId: senderId, ...wireScope(scope), requestId });
	} catch (error) {
		if (peerConnections.get(key) === state) cleanupPeerConnection(key);
		if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('[screenshare] Answer failed:', error);
	}
}

export async function handleScreenShareAnswer(senderId: string, answer: RTCSessionDescriptionInit, channelId?: string, requestId?: string) {
	const { peerConnections, receiveScope } = requireDeps();

	const key = getConnectionKey(senderId, 'screen');
	const state = peerConnections.get(key);
	const scope = receiveScope(channelId, senderId);
	if (!state || state.channelId !== channelId || state.mediaRequestId !== requestId || !scope?.current()) return;

	try {
		await state.pc.setRemoteDescription(answer);
		if (peerConnections.get(key) !== state || !scope.current()) return;
		state.hasRemoteDescription = true;
		await flushQueuedIceCandidates(peerConnections, key);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleScreenShareIceCandidate(senderId: string, candidate: RTCIceCandidateInit, channelId?: string, requestId?: string) {
	const { peerConnections, receiveScope } = requireDeps();

	const key = getConnectionKey(senderId, 'screen');
	const scope = receiveScope(channelId, senderId);
	if (!scope?.current()) return;
	queuePendingIceCandidate(peerConnections, key, candidate,
		state => scope.current() && state.channelId === channelId && state.mediaRequestId === requestId);
}
