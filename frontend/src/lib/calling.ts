// TODO: CRITICAL - Calling system has multiple critical bugs that need fixing:
// 1. Answering calls doesn't actually connect - investigate WebRTC handshake
// 2. No call notifications system - need to add browser notifications
// 3. Can't answer from notifications - need notification click handlers
// 4. Call UI buttons are unresponsive - check event handlers in CallModal.svelte
// 5. Video feeds not displaying - check video element bindings and stream handling
// 6. Missing right-click context menu on user profiles for:
//    - Initiating calls
//    - Starting screenshare
//    - Opening individual DMs
// 7. Individual DM functionality is completely missing
// 8. Group chat functionality is completely missing
//
// Priority: HIGH - Core communication features are broken

import { writable } from 'svelte/store';
import type { Socket } from 'socket.io-client';

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

export const activeCalls = writable<Call[]>([]);
export const incomingCall = writable<IncomingCall | null>(null);
export const isInCall = writable(false);
export const isMuted = writable(false);
export const isVideoOff = writable(false);

const peerConnections = new Map<string, RTCPeerConnection>();
let localStream: MediaStream | null = null;

const rtcConfig: RTCConfiguration = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	]
};

export async function startCall(socket: Socket, targetUserId: string, isVideoCall: boolean = false) {
	try {
		// Get user media
		localStream = await navigator.mediaDevices.getUserMedia({
			video: isVideoCall,
			audio: true
		});

		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);

		// Emit call-initiate event
		socket.emit('call-initiate', {
			targetUserId,
			isVideoCall
		});

		return localStream;
	} catch (error) {
		console.error('Error starting call:', error);
		throw error;
	}
}

export async function answerCall(socket: Socket, callerId: string, isVideoCall: boolean = false) {
	try {
		// Get user media
		localStream = await navigator.mediaDevices.getUserMedia({
			video: isVideoCall,
			audio: true
		});

		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);

		// Emit call-answer event
		socket.emit('call-answer', {
			callerId,
			isVideoCall
		});

		// Clear incoming call
		incomingCall.set(null);

		return localStream;
	} catch (error) {
		console.error('Error answering call:', error);
		throw error;
	}
}

export function rejectCall(socket: Socket, callerId: string) {
	socket.emit('call-reject', { callerId });
	incomingCall.set(null);
}

export function endCall(socket: Socket) {
	if (localStream) {
		localStream.getTracks().forEach(track => track.stop());
		localStream = null;
	}

	isInCall.set(false);
	isMuted.set(false);
	isVideoOff.set(false);

	socket.emit('call-end');

	// Close all peer connections
	peerConnections.forEach(pc => pc.close());
	peerConnections.clear();
	activeCalls.set([]);
}

export function toggleMute() {
	if (localStream) {
		const audioTrack = localStream.getAudioTracks()[0];
		if (audioTrack) {
			audioTrack.enabled = !audioTrack.enabled;
			isMuted.set(!audioTrack.enabled);
		}
	}
}

export function toggleVideo() {
	if (localStream) {
		const videoTrack = localStream.getVideoTracks()[0];
		if (videoTrack) {
			videoTrack.enabled = !videoTrack.enabled;
			isVideoOff.set(!videoTrack.enabled);
		}
	}
}

export async function createCallOffer(socket: Socket, targetId: string) {
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections.set(targetId, pc);

	if (localStream) {
		localStream.getTracks().forEach(track => {
			pc.addTrack(track, localStream!);
		});
	}

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('call-ice-candidate', {
				candidate: event.candidate,
				targetId
			});
		}
	};

	pc.ontrack = (event) => {
		addRemoteStream(targetId, event.streams[0]);
	};

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
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections.set(senderId, pc);

	if (localStream) {
		localStream.getTracks().forEach(track => {
			pc.addTrack(track, localStream!);
		});
	}

	pc.ontrack = (event) => {
		addRemoteStream(senderId, event.streams[0]);
	};

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('call-ice-candidate', {
				candidate: event.candidate,
				targetId: senderId
			});
		}
	};

	await pc.setRemoteDescription(offer);
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);

	socket.emit('call-answer-sdp', {
		answer,
		targetId: senderId
	});
}

export async function handleCallAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const pc = peerConnections.get(senderId);
	if (pc) {
		await pc.setRemoteDescription(answer);
	}
}

export async function handleCallIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	const pc = peerConnections.get(senderId);
	if (pc) {
		await pc.addIceCandidate(candidate);
	}
}

function addRemoteStream(userId: string, stream: MediaStream) {
	activeCalls.update(calls => {
		const existingIndex = calls.findIndex(c => c.userId === userId);
		const newCall = {
			userId,
			username: '', // Will be updated from socket event
			stream,
			isVideoEnabled: stream.getVideoTracks().length > 0,
			isAudioEnabled: stream.getAudioTracks().length > 0
		};

		if (existingIndex >= 0) {
			calls[existingIndex] = newCall;
			return calls;
		} else {
			return [...calls, newCall];
		}
	});
}

export function removeCall(userId: string) {
	activeCalls.update(calls => calls.filter(c => c.userId !== userId));

	const pc = peerConnections.get(userId);
	if (pc) {
		pc.close();
		peerConnections.delete(userId);
	}
}

export function getLocalStream() {
	return localStream;
}
