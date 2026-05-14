import { writable, get } from 'svelte/store';
import { buildRTCConfig, prefetchTurnCredentials } from './turnConfig';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

// ============================================================================
// Types
// ============================================================================

export interface FileTransfer {
	id: string;
	fileName: string;
	fileSize: number;
	senderId: string;
	receiverId: string;
	direction: 'send' | 'receive';
	progress: number; // 0-1
	status: 'pending' | 'connecting' | 'transferring' | 'complete' | 'failed';
}

export interface IncomingFileOffer {
	transferId: string;
	senderId: string;
	senderUsername: string;
	fileName: string;
	fileSize: number;
	offer: RTCSessionDescriptionInit;
}

// ============================================================================
// Stores
// ============================================================================

export const activeTransfers = writable<FileTransfer[]>([]);
export const incomingFileOffer = writable<IncomingFileOffer | null>(null);

// ============================================================================
// Internal state
// ============================================================================

const peerConnections = new Map<string, RTCPeerConnection>();
const dataChannels = new Map<string, RTCDataChannel>();
const receiveBuffers = new Map<string, ArrayBuffer[]>();
const receiveMetadata = new Map<string, { fileName: string; fileSize: number }>();

// ============================================================================
// Send a file via P2P WebRTC data channel
// ============================================================================

export async function sendFileP2P(
	socket: any,
	targetUserId: string,
	file: File
): Promise<string> {
	await prefetchTurnCredentials();
	const transferId = `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	const transfer: FileTransfer = {
		id: transferId,
		fileName: file.name,
		fileSize: file.size,
		senderId: socket.id!,
		receiverId: targetUserId,
		direction: 'send',
		progress: 0,
		status: 'connecting'
	};

	activeTransfers.update((t) => [...t, transfer]);

	// Create peer connection
	const pc = new RTCPeerConnection(buildRTCConfig());
	peerConnections.set(transferId, pc);

	// Create data channel
	const dc = pc.createDataChannel('file-transfer', { ordered: true });
	dataChannels.set(transferId, dc);

	dc.binaryType = 'arraybuffer';

	dc.onopen = () => {
		// Send file metadata first
		dc.send(
			JSON.stringify({
				type: 'file-meta',
				fileName: file.name,
				fileSize: file.size,
				transferId
			})
		);
		// Stream file chunks
		sendFileChunks(transferId, dc, file);
	};

	dc.onerror = () => {
		updateTransferStatus(transferId, 'failed');
		cleanup(transferId);
	};

	// ICE candidates
	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('p2p-ice-candidate', {
				transferId,
				targetId: targetUserId,
				candidate: event.candidate.toJSON()
			});
		}
	};

	pc.onconnectionstatechange = () => {
		if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
			updateTransferStatus(transferId, 'failed');
			cleanup(transferId);
		}
	};

	// Create and send offer
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);

	socket.emit('p2p-offer', {
		transferId,
		targetId: targetUserId,
		offer: pc.localDescription,
		fileName: file.name,
		fileSize: file.size
	});

	return transferId;
}

async function sendFileChunks(
	transferId: string,
	dc: RTCDataChannel,
	file: File
): Promise<void> {
	updateTransferStatus(transferId, 'transferring');

	const arrayBuffer = await file.arrayBuffer();
	let offset = 0;

	while (offset < arrayBuffer.byteLength) {
		// Backpressure: wait for buffer to drain
		while (dc.bufferedAmount > CHUNK_SIZE * 8) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const end = Math.min(offset + CHUNK_SIZE, arrayBuffer.byteLength);
		const chunk = arrayBuffer.slice(offset, end);
		dc.send(chunk);
		offset = end;
		updateTransferProgress(transferId, offset / arrayBuffer.byteLength);
	}

	// Send end-of-file marker
	dc.send(JSON.stringify({ type: 'file-complete' }));
	updateTransferStatus(transferId, 'complete');

	// Clean up after a short delay to allow the marker to arrive
	setTimeout(() => cleanup(transferId), 5000);
}

// ============================================================================
// Receive — handle incoming P2P offer
// ============================================================================

export function handleP2PIncomingOffer(data: {
	transferId: string;
	senderId: string;
	senderUsername: string;
	offer: RTCSessionDescriptionInit;
	fileName: string;
	fileSize: number;
}): void {
	incomingFileOffer.set({
		transferId: data.transferId,
		senderId: data.senderId,
		senderUsername: data.senderUsername,
		fileName: data.fileName,
		fileSize: data.fileSize,
		offer: data.offer
	});
}

export async function acceptFileTransfer(socket: any): Promise<void> {
	await prefetchTurnCredentials();
	const offer = get(incomingFileOffer);
	if (!offer) return;

	incomingFileOffer.set(null);

	const transfer: FileTransfer = {
		id: offer.transferId,
		fileName: offer.fileName,
		fileSize: offer.fileSize,
		senderId: offer.senderId,
		receiverId: socket.id!,
		direction: 'receive',
		progress: 0,
		status: 'connecting'
	};

	activeTransfers.update((t) => [...t, transfer]);

	// Create peer connection
	const pc = new RTCPeerConnection(buildRTCConfig());
	peerConnections.set(offer.transferId, pc);

	// Handle incoming data channel
	pc.ondatachannel = (event) => {
		const dc = event.channel;
		dc.binaryType = 'arraybuffer';
		dataChannels.set(offer.transferId, dc);
		receiveBuffers.set(offer.transferId, []);

		dc.onmessage = (msgEvent) => {
			if (typeof msgEvent.data === 'string') {
				const msg = JSON.parse(msgEvent.data);
				if (msg.type === 'file-meta') {
					receiveMetadata.set(offer.transferId, {
						fileName: msg.fileName,
						fileSize: msg.fileSize
					});
					updateTransferStatus(offer.transferId, 'transferring');
				} else if (msg.type === 'file-complete') {
					assembleAndDownload(offer.transferId);
				}
			} else {
				// Binary chunk
				const chunks = receiveBuffers.get(offer.transferId);
				if (chunks) {
					chunks.push(msgEvent.data as ArrayBuffer);
					const meta = receiveMetadata.get(offer.transferId);
					if (meta) {
						const received = chunks.reduce((sum, c) => sum + c.byteLength, 0);
						updateTransferProgress(offer.transferId, received / meta.fileSize);
					}
				}
			}
		};

		dc.onerror = () => {
			updateTransferStatus(offer.transferId, 'failed');
			cleanup(offer.transferId);
		};
	};

	// ICE candidates
	pc.onicecandidate = (event) => {
		if (event.candidate) {
			socket.emit('p2p-ice-candidate', {
				transferId: offer.transferId,
				targetId: offer.senderId,
				candidate: event.candidate.toJSON()
			});
		}
	};

	pc.onconnectionstatechange = () => {
		if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
			updateTransferStatus(offer.transferId, 'failed');
			cleanup(offer.transferId);
		}
	};

	// Set remote description and create answer
	await pc.setRemoteDescription(new RTCSessionDescription(offer.offer));
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);

	socket.emit('p2p-answer', {
		transferId: offer.transferId,
		targetId: offer.senderId,
		answer: pc.localDescription
	});
}

export function rejectFileTransfer(): void {
	incomingFileOffer.set(null);
}

// ============================================================================
// Handle signaling responses
// ============================================================================

export async function handleP2PAnswer(data: {
	transferId: string;
	senderId: string;
	answer: RTCSessionDescriptionInit;
}): Promise<void> {
	const pc = peerConnections.get(data.transferId);
	if (!pc) return;
	await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
}

export function handleP2PIceCandidate(data: {
	transferId: string;
	senderId: string;
	candidate: RTCIceCandidateInit;
}): void {
	const pc = peerConnections.get(data.transferId);
	if (!pc) return;
	pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch((err) => {
		console.warn('[P2P] Failed to add ICE candidate:', err);
	});
}

// ============================================================================
// Helpers
// ============================================================================

function assembleAndDownload(transferId: string): void {
	const chunks = receiveBuffers.get(transferId);
	const meta = receiveMetadata.get(transferId);
	if (!chunks || !meta) return;

	const blob = new Blob(chunks);
	const url = URL.createObjectURL(blob);

	// Trigger download
	const a = document.createElement('a');
	a.href = url;
	a.download = meta.fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);

	updateTransferStatus(transferId, 'complete');
	setTimeout(() => cleanup(transferId), 5000);
}

function updateTransferProgress(transferId: string, progress: number): void {
	activeTransfers.update((transfers) =>
		transfers.map((t) => (t.id === transferId ? { ...t, progress } : t))
	);
}

function updateTransferStatus(transferId: string, status: FileTransfer['status']): void {
	activeTransfers.update((transfers) =>
		transfers.map((t) => (t.id === transferId ? { ...t, status } : t))
	);
}

function cleanup(transferId: string): void {
	const dc = dataChannels.get(transferId);
	if (dc) {
		dc.close();
		dataChannels.delete(transferId);
	}

	const pc = peerConnections.get(transferId);
	if (pc) {
		pc.close();
		peerConnections.delete(transferId);
	}

	receiveBuffers.delete(transferId);
	receiveMetadata.delete(transferId);

	// Remove from active transfers after a delay
	setTimeout(() => {
		activeTransfers.update((transfers) => transfers.filter((t) => t.id !== transferId));
	}, 10000);
}

export function cancelTransfer(transferId: string): void {
	updateTransferStatus(transferId, 'failed');
	cleanup(transferId);
}
