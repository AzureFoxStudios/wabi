import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { buildRTCConfig } from './turnConfig';

// ============================================================================
// Types
// ============================================================================

export interface Call {
	userId: string;
	username: string;
	stream: MediaStream;
	isVideoEnabled: boolean;
	isAudioEnabled: boolean;
}

export interface IncomingCall {
	userId: string;
	username: string;
	isVideoCall: boolean;
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

interface PeerConnectionState {
	pc: RTCPeerConnection;
	type: 'call' | 'screen-share-outbound' | 'screen-share-inbound';
	targetId: string;
	username: string;
	lifecycleState: ConnectionLifecycleState;
	iceCandidateQueue: RTCIceCandidateInit[];
	hasRemoteDescription: boolean;
}

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
export const localStream = writable<MediaStream | null>(null);
export const localScreenStream = writable<MediaStream | null>(null);
export const connectionState = writable<ConnectionLifecycleState>('idle');

// ============================================================================
// Private State
// ============================================================================

// Single map for ALL peer connections (calls and screen shares)
const peerConnections = new Map<string, PeerConnectionState>();

// Track call participants for targeted cleanup
const callParticipants = new Set<string>();

// Lazy-loaded RTC config (built on first use, not at module load)
let rtcConfig: RTCConfiguration | null = null;

function getRTCConfig(): RTCConfiguration {
	if (!rtcConfig) {
		rtcConfig = buildRTCConfig();
	}
	return rtcConfig;
}

// ============================================================================
// ICE Candidate Queue Management
// ============================================================================

function queueIceCandidate(targetId: string, candidate: RTCIceCandidateInit): void {
	const state = peerConnections.get(targetId);
	if (!state) {
		console.warn(`[WebRTC] Cannot queue ICE candidate - no peer connection for ${targetId}`);
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
		console.log(`[WebRTC] Queued ICE candidate for ${targetId} (queue size: ${state.iceCandidateQueue.length})`);
	}
}

async function flushIceCandidateQueue(targetId: string): Promise<void> {
	const state = peerConnections.get(targetId);
	if (!state) return;

	const queue = state.iceCandidateQueue;
	state.iceCandidateQueue = [];

	console.log(`[WebRTC] Flushing ${queue.length} queued ICE candidates for ${targetId}`);

	for (const candidate of queue) {
		try {
			await state.pc.addIceCandidate(candidate);
		} catch (err) {
			console.error(`[WebRTC] Failed to add queued ICE candidate:`, err);
		}
	}
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
	// Close existing connection if any (prevents duplicates)
	const existing = peerConnections.get(targetId);
	if (existing) {
		console.log(`[WebRTC] Closing existing peer connection for ${targetId}`);
		existing.pc.close();
		peerConnections.delete(targetId);
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

	peerConnections.set(targetId, state);
	connectionState.set('signaling');

	// Connection state change handler
	pc.onconnectionstatechange = () => {
		console.log(`[WebRTC] Connection state for ${targetId}: ${pc.connectionState}`);

		switch (pc.connectionState) {
			case 'connected':
				state.lifecycleState = 'connected';
				connectionState.set('connected');
				break;
			case 'disconnected':
				state.lifecycleState = 'disconnected';
				connectionState.set('disconnected');
				break;
			case 'failed':
				state.lifecycleState = 'failed';
				connectionState.set('failed');
				// Could implement reconnection here
				break;
			case 'closed':
				cleanupPeerConnection(targetId);
				break;
		}
	};

	// ICE connection state (more granular)
	pc.oniceconnectionstatechange = () => {
		console.log(`[WebRTC] ICE connection state for ${targetId}: ${pc.iceConnectionState}`);

		if (pc.iceConnectionState === 'checking') {
			state.lifecycleState = 'connecting';
			connectionState.set('connecting');
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
		console.log(`[WebRTC] Received track from ${targetId}:`, event.track.kind);

		const stream = event.streams[0];
		if (!stream) {
			console.warn(`[WebRTC] No stream in ontrack event`);
			return;
		}

		// Handle track ended
		event.track.onended = () => {
			console.log(`[WebRTC] Track ended from ${targetId}:`, event.track.kind);
			handleRemoteTrackEnded(targetId, event.track, type);
		};

		// Handle track muted/unmuted for UI sync
		event.track.onmute = () => {
			console.log(`[WebRTC] Track muted from ${targetId}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		event.track.onunmute = () => {
			console.log(`[WebRTC] Track unmuted from ${targetId}:`, event.track.kind);
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

function cleanupPeerConnection(targetId: string): void {
	const state = peerConnections.get(targetId);
	if (!state) return;

	console.log(`[WebRTC] Cleaning up peer connection for ${targetId}`);

	try {
		state.pc.close();
	} catch (e) {
		// Ignore close errors
	}

	peerConnections.delete(targetId);
	callParticipants.delete(targetId);

	// Update UI stores
	activeCalls.update(calls => calls.filter(c => c.userId !== targetId));
	screenShares.update(shares => shares.filter(s => s.userId !== targetId));

	// Check if any connections remain
	if (peerConnections.size === 0) {
		connectionState.set('idle');
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
			isAudioEnabled: audioTrack ? audioTrack.enabled : false
		};

		if (existingIndex >= 0) {
			calls[existingIndex] = newCall;
			return [...calls];
		} else {
			return [...calls, newCall];
		}
	});

	callParticipants.add(userId);
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

function handleRemoteTrackEnded(targetId: string, track: MediaStreamTrack, type: PeerConnectionState['type']): void {
	if (type === 'call') {
		// Update call state to reflect ended track
		activeCalls.update(calls => {
			return calls.map(call => {
				if (call.userId === targetId) {
					if (track.kind === 'video') {
						return { ...call, isVideoEnabled: false };
					} else if (track.kind === 'audio') {
						return { ...call, isAudioEnabled: false };
					}
				}
				return call;
			});
		});
	} else if (type === 'screen-share-inbound') {
		// Screen share track ended - remove the share
		screenShares.update(shares => shares.filter(s => s.userId !== targetId));
		cleanupPeerConnection(targetId);
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
					return { ...call, isAudioEnabled: !track.muted && track.enabled };
				}
			}
			return call;
		});
	});
}

// ============================================================================
// Call Functions
// ============================================================================

export async function startCall(socket: Socket, targetUserId: string, isVideoCall: boolean = false) {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			video: isVideoCall,
			audio: true
		});
		localStream.set(stream);

		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);

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
		const stream = await navigator.mediaDevices.getUserMedia({
			video: isVideoCall,
			audio: true
		});
		localStream.set(stream);

		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);

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
	// Stop local media tracks
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}

	// Reset call state
	isInCall.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);

	// Notify server with participant list for targeted cleanup
	socket.emit('call-end', {
		participants: Array.from(callParticipants)
	});

	// Close all call peer connections
	peerConnections.forEach((state, targetId) => {
		if (state.type === 'call') {
			cleanupPeerConnection(targetId);
		}
	});

	activeCalls.set([]);
	callParticipants.clear();
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
			isMuted.set(!audioTrack.enabled);
		}
	}
}

export function toggleDeafen() {
	const currentlyDeafened = get(isDeafened);
	isDeafened.set(!currentlyDeafened);

	if (!currentlyDeafened) {
		// Becoming deafened - also mute self
		const stream = get(localStream);
		if (stream) {
			const audioTrack = stream.getAudioTracks()[0];
			if (audioTrack) {
				audioTrack.enabled = false;
				isMuted.set(true);
			}
		}
	}
	// Note: Actual deafen (muting remote audio) is handled in the UI component
	// by setting audio elements to muted based on isDeafened store
}

export function toggleVideo() {
	const stream = get(localStream);
	if (stream) {
		const videoTrack = stream.getVideoTracks()[0];
		if (videoTrack) {
			videoTrack.enabled = !videoTrack.enabled;
			isVideoOff.set(!videoTrack.enabled);
		}
	}
}

// ============================================================================
// WebRTC Signaling Handlers (called from socket.ts)
// ============================================================================

export async function createCallOffer(socket: Socket, targetId: string, username: string = '') {
	const pc = createPeerConnection(targetId, username, 'call', socket);

	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => {
			pc.addTrack(track, stream);
		});
	}

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	socket.emit('call-offer', {
		offer,
		targetId
	});
}

export async function handleCallOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit
) {
	const pc = createPeerConnection(senderId, username, 'call', socket);

	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => {
			pc.addTrack(track, stream);
		});
	}

	await pc.setRemoteDescription(offer);

	// Mark remote description as set and flush queue
	const state = peerConnections.get(senderId);
	if (state) {
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(senderId);
	}

	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);

	socket.emit('call-answer-sdp', {
		answer,
		targetId: senderId
	});
}

export async function handleCallAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const state = peerConnections.get(senderId);
	if (!state) {
		console.warn(`[WebRTC] No peer connection for call answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(senderId);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleCallIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	queueIceCandidate(senderId, candidate);
}

// ============================================================================
// Screen Share Functions
// ============================================================================

export async function startScreenShare(socket: Socket) {
	try {
		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: true,
			audio: false
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

	// Close all outbound screen share connections
	peerConnections.forEach((state, targetId) => {
		if (state.type === 'screen-share-outbound') {
			cleanupPeerConnection(targetId);
		}
	});
}

export async function createScreenShareOffer(socket: Socket, targetId: string) {
	const pc = createPeerConnection(targetId, '', 'screen-share-outbound', socket);

	const stream = get(localScreenStream);
	if (stream) {
		stream.getTracks().forEach(track => {
			pc.addTrack(track, stream);
		});
	}

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	socket.emit('webrtc-offer', {
		offer,
		targetId
	});
}

export async function handleScreenShareOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit
) {
	const pc = createPeerConnection(senderId, username, 'screen-share-inbound', socket);

	await pc.setRemoteDescription(offer);

	const state = peerConnections.get(senderId);
	if (state) {
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(senderId);
	}

	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);

	socket.emit('webrtc-answer', {
		answer,
		targetId: senderId
	});
}

export async function handleScreenShareAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const state = peerConnections.get(senderId);
	if (!state) {
		console.warn(`[WebRTC] No peer connection for screen share answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(senderId);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleScreenShareIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	queueIceCandidate(senderId, candidate);
}

// ============================================================================
// Cleanup Functions
// ============================================================================

export function removeCall(userId: string) {
	cleanupPeerConnection(userId);
}

export function removeScreenShare(userId: string) {
	cleanupPeerConnection(userId);
}

export function cleanupAllConnections() {
	// Stop all local media
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}

	const screenStream = get(localScreenStream);
	if (screenStream) {
		screenStream.getTracks().forEach(track => track.stop());
		localScreenStream.set(null);
	}

	// Close all peer connections
	peerConnections.forEach((state, targetId) => {
		try {
			state.pc.close();
		} catch (e) {
			// Ignore
		}
	});

	peerConnections.clear();
	callParticipants.clear();

	// Reset all stores
	activeCalls.set([]);
	screenShares.set([]);
	isInCall.set(false);
	isSharing.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);
	connectionState.set('idle');
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
	const state = peerConnections.get(userId);
	if (state) {
		state.username = username;
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
