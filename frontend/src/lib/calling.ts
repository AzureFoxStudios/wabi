import { writable, get } from 'svelte/store';
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
export const localStream = writable<MediaStream | null>(null);
export const connectionState = writable<'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed'>('idle');

const peerConnections = new Map<string, RTCPeerConnection>();

const rtcConfig: RTCConfiguration = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' },
		// Public TURN servers (you might want to use a more robust solution like Coturn or a commercial service for production)
		{
			urls: [
				'turn:global.relay.metered.ca:80',
				'turn:global.relay.metered.ca:80?transport=udp',
				'turn:global.relay.metered.ca:80?transport=tcp',
				'turns:global.relay.metered.ca:443',
				'turns:global.relay.metered.ca:443?transport=udp',
				'turns:global.relay.metered.ca:443?transport=tcp'
			],
			username: 'YOUR_API_KEY', // Replace with your Metered API key or other TURN server credentials
			credential: 'YOUR_SECRET' // Replace with your Metered API secret or other TURN server credentials
		}
	]
};

export async function startCall(socket: Socket, targetUserId: string, isVideoCall: boolean = false) {
	try {
		// Get user media
		const stream = await navigator.mediaDevices.getUserMedia({
			video: isVideoCall,
			audio: true
		});
		localStream.set(stream);

		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);

		// Emit call-initiate event
		socket.emit('call-initiate', {
			targetUserId,
			isVideoCall
		});

		return stream;
	} catch (error) {
		console.error('Error starting call:', error);
		if (error instanceof DOMException) {
			if (error.name === 'NotAllowedError') {
				alert('Permission denied: Please allow camera and microphone access to start a call.');
			} else if (error.name === 'NotFoundError') {
				alert('No camera or microphone found to start a call.');
			} else if (error.name === 'NotReadableError' || error.name === 'OverconstrainedError') {
				alert('Camera or microphone is in use or inaccessible. Please close other applications that might be using it.');
			} else {
				alert(`Error starting call: ${error.message}`);
			}
		} else {
			alert('An unknown error occurred while trying to access media devices for the call.');
		}
		isInCall.set(false); // Ensure call state is reset
		localStream.set(null); // Clear local stream
		throw error;
	}
}

export async function answerCall(socket: Socket, callerId: string, isVideoCall: boolean = false) {
	try {
		// Get user media
		const stream = await navigator.mediaDevices.getUserMedia({
			video: isVideoCall,
			audio: true
		});
		localStream.set(stream);

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

		return stream;
	} catch (error) {
		console.error('Error answering call:', error);
		if (error instanceof DOMException) {
			if (error.name === 'NotAllowedError') {
				alert('Permission denied: Please allow camera and microphone access to answer the call.');
			} else if (error.name === 'NotFoundError') {
				alert('No camera or microphone found to answer the call.');
			} else if (error.name === 'NotReadableError' || error.name === 'OverconstrainedError') {
				alert('Camera or microphone is in use or inaccessible. Please close other applications that might be using it.');
			} else {
				alert(`Error answering call: ${error.message}`);
			}
		} else {
			alert('An unknown error occurred while trying to access media devices for the call.');
		}
		isInCall.set(false); // Ensure call state is reset
		localStream.set(null); // Clear local stream
		throw error;
	}
}

export function rejectCall(socket: Socket, callerId: string) {
	socket.emit('call-reject', { callerId });
	incomingCall.set(null);
}

export function endCall(socket: Socket) {
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}

	isInCall.set(false);
	isMuted.set(false);
	isVideoOff.set(false);

	socket.emit('call-end');

	// Close all peer connections
	peerConnections.forEach(pc => pc.close());
	peerConnections.clear();
	activeCalls.set([]);
	connectionState.set('idle');
}

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

export async function createCallOffer(socket: Socket, targetId: string) {
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections.set(targetId, pc);

	connectionState.set('connecting');

	pc.onconnectionstatechange = () => {
		console.log(`[WebRTC] Connection state changed: ${pc.connectionState}`);
		if (pc.connectionState === 'connected') {
			connectionState.set('connected');
		} else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
			connectionState.set(pc.connectionState);
			// Optionally, implement auto-retry or call end here
		}
	};

	pc.oniceconnectionstatechange = () => {
		console.log(`[WebRTC] ICE connection state changed: ${pc.iceConnectionState}`);
		// Additional handling for ICE states if needed
	};

	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => {
			pc.addTrack(track, stream);
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

	connectionState.set('connecting');

	pc.onconnectionstatechange = () => {
		console.log(`[WebRTC] Connection state changed: ${pc.connectionState}`);
		if (pc.connectionState === 'connected') {
			connectionState.set('connected');
		} else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
			connectionState.set(pc.connectionState);
			// Optionally, implement auto-retry or call end here
		}
	};

	pc.oniceconnectionstatechange = () => {
		console.log(`[WebRTC] ICE connection state changed: ${pc.iceConnectionState}`);
		// Additional handling for ICE states if needed
	};

	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => {
			pc.addTrack(track, stream);
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

