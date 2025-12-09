import { writable } from 'svelte/store';
import type { Socket } from 'socket.io-client';

export interface ScreenShare {
	userId: string;
	username: string;
	stream: MediaStream;
}

export const screenShares = writable<ScreenShare[]>([]);
export const isSharing = writable(false);

const peerConnections = new Map<string, RTCPeerConnection>();
let localStream: MediaStream | null = null;

const rtcConfig: RTCConfiguration = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' },
		// Public TURN servers (you might want to use a more robust solution like Coturn or a commercial service for production)
		{
			urls: [
				'turn:YOUR_SERVER_IP:3478'
			],
			username: 'chatuser',
			credential: 'SecurePassword123'
		}
	]
};

export async function startScreenShare(socket: Socket) {
	try {
		localStream = await navigator.mediaDevices.getDisplayMedia({
			video: true,
			audio: false
		});

		isSharing.set(true);
		socket.emit('start-screen-share');

		localStream.getVideoTracks()[0].onended = () => {
			stopScreenShare(socket);
		};

		return localStream;
	} catch (error) {
		console.error('Error starting screen share:', error);
		throw error;
	}
}

export function stopScreenShare(socket: Socket) {
	if (localStream) {
		localStream.getTracks().forEach(track => track.stop());
		localStream = null;
	}

	isSharing.set(false);
	socket.emit('stop-screen-share');

	// Close all peer connections
	peerConnections.forEach(pc => pc.close());
	peerConnections.clear();
}

export async function createOffer(socket: Socket, targetId: string) {
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections.set(targetId, pc);

	if (localStream) {
		localStream.getTracks().forEach(track => {
			pc.addTrack(track, localStream!);
		});
	}

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('webrtc-ice-candidate', {
				candidate: event.candidate,
				targetId
			});
		}
	};

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	socket.emit('webrtc-offer', {
		offer,
		targetId
	});
}

export async function handleOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit
) {
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections.set(senderId, pc);

	pc.ontrack = (event) => {
		screenShares.update(shares => {
			const existingIndex = shares.findIndex(s => s.userId === senderId);
			const newShare = {
				userId: senderId,
				username,
				stream: event.streams[0]
			};

			if (existingIndex >= 0) {
				shares[existingIndex] = newShare;
				return shares;
			} else {
				return [...shares, newShare];
			}
		});
	};

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('webrtc-ice-candidate', {
				candidate: event.candidate,
				targetId: senderId
			});
		}
	};

	await pc.setRemoteDescription(offer);
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);

	socket.emit('webrtc-answer', {
		answer,
		targetId: senderId
	});
}

export async function handleAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const pc = peerConnections.get(senderId);
	if (pc) {
		await pc.setRemoteDescription(answer);
	}
}

export async function handleIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	const pc = peerConnections.get(senderId);
	if (pc) {
		await pc.addIceCandidate(candidate);
	}
}

export function removeScreenShare(userId: string) {
	screenShares.update(shares => shares.filter(s => s.userId !== userId));

	const pc = peerConnections.get(userId);
	if (pc) {
		pc.close();
		peerConnections.delete(userId);
	}
}
