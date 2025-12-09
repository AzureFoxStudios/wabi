import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { addCallLog, updateCallLog, getCallHistory } from './history';

let currentCallLogId: string | null = null;


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

export interface ConnectionQuality {
    quality: 'good' | 'average' | 'poor';
    packetsLost?: number;
    jitter?: number;
    roundTripTime?: number;
}
export const connectionStats = writable<Map<string, ConnectionQuality>>(new Map());

const peerConnections = new Map<string, RTCPeerConnection>();
const monitoringIntervals = new Map<string, number>();

let lastStats: Map<string, RTCStatsReport> = new Map();

function analyzeStats(statsReport: RTCStatsReport, userId: string): ConnectionQuality {
    let packetsLost = 0;
    let jitter = 0;
    let roundTripTime = 0;
    let quality: ConnectionQuality['quality'] = 'good';

    statsReport.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
            packetsLost = report.packetsLost;
            jitter = report.jitter;
        }
        if (report.type === 'remote-candidate-pair' || report.type === 'candidate-pair' && report.state === 'succeeded') {
            roundTripTime = report.currentRoundTripTime;
        }
    });

    if (packetsLost > 10 || jitter > 0.1 || roundTripTime > 0.5) {
        quality = 'poor';
    } else if (packetsLost > 2 || jitter > 0.05 || roundTripTime > 0.25) {
        quality = 'average';
    }

    const qualityData = { quality, packetsLost, jitter, roundTripTime };
    connectionStats.update(stats => stats.set(userId, qualityData));
    return qualityData;
}

function startMonitoringConnection(userId: string) {
    const pc = peerConnections.get(userId);
    if (!pc) return;

    const intervalId = setInterval(async () => {
        if (pc.signalingState === 'closed') {
            stopMonitoringConnection(userId);
            return;
        }
        const stats = await pc.getStats();
        analyzeStats(stats, userId);
        lastStats.set(userId, stats);
    }, 5000);

    monitoringIntervals.set(userId, intervalId as unknown as number);
}

function stopMonitoringConnection(userId: string) {
    if (monitoringIntervals.has(userId)) {
        clearInterval(monitoringIntervals.get(userId));
        monitoringIntervals.delete(userId);
    }
    connectionStats.update(stats => {
        stats.delete(userId);
        return stats;
    });
    lastStats.delete(userId);
}


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

        const newLog = addCallLog({
            username: targetUserId, // We might want to resolve this to a proper username later
            type: 'outgoing',
            status: 'answered',
            startTime: Date.now(),
            isVideo: isVideoCall,
        });
        currentCallLogId = newLog.id;

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

        const callInfo = get(incomingCall);
        if (callInfo) {
            const newLog = addCallLog({
                username: callInfo.username,
                type: 'incoming',
                status: 'answered',
                startTime: Date.now(),
                isVideo: isVideoCall,
            });
            currentCallLogId = newLog.id;
        }

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

    const callInfo = get(incomingCall);
    if (callInfo) {
        addCallLog({
            username: callInfo.username,
            type: 'incoming',
            status: 'declined',
            startTime: Date.now(),
            endTime: Date.now(),
            duration: 0,
            isVideo: callInfo.isVideoCall,
        });
    }

	incomingCall.set(null);
}

export function endCall(socket: Socket) {
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}

    if (currentCallLogId) {
        const history = getCallHistory(); // Note: getCallHistory is not defined in this file. It should be imported.
        const log = history.find(l => l.id === currentCallLogId);
        if (log) {
            const endTime = Date.now();
            updateCallLog(currentCallLogId, {
                status: 'ended',
                endTime: endTime,
                duration: Math.round((endTime - log.startTime) / 1000)
            });
        }
        currentCallLogId = null;
    }

	isInCall.set(false);
	isMuted.set(false);
	isVideoOff.set(false);

	socket.emit('call-end');

	// Close all peer connections
	peerConnections.forEach((pc, userId) => {
		pc.close();
        stopMonitoringConnection(userId);
	});
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
	pc.onconnectionstatechange = () => {
		console.log(`[WebRTC] Connection state changed: ${pc.connectionState}`);
		if (pc.connectionState === 'connected') {
			connectionState.set('connected');
            startMonitoringConnection(targetId);
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
            startMonitoringConnection(senderId);
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
    stopMonitoringConnection(userId);
}

