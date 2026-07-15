import { writable, get, derived } from 'svelte/store';
import { buildRTCConfig, prefetchTurnCredentials } from './turnConfig';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

// ============================================================================
// Types
// ============================================================================

export type TransferStatus =
	| 'pending'
	| 'connecting'
	| 'preparing'
	| 'hashing'
	| 'requesting'
	| 'transferring'
	| 'paused'
	| 'resuming'
	| 'verifying'
	| 'complete'
	| 'failed'
	| 'cancelled';

export interface FileTransfer {
	id: string;
	fileName: string;
	fileSize: number;
	transferredBytes: number;
	senderId: string;
	receiverId: string;
	direction: 'send' | 'receive';
	progress: number; // 0-1
	status: TransferStatus;
	chunkSize: number;
	totalChunks: number;
	completedChunks: number;
	speedBytesPerSec?: number;
	errorMessage?: string;
}

export interface IncomingFileOffer {
	transferId: string;
	senderId: string;
	senderUsername: string;
	fileName: string;
	fileSize: number;
	offer: RTCSessionDescriptionInit;
}

export interface TransferSettings {
	askEveryTime: boolean;
	autoAcceptTrusted: boolean;
	autoAcceptUsers: string[];
	maxSimultaneousDownloads: number;
	maxSimultaneousUploads: number;
}

export interface TransferHistoryEntry {
	transfer: FileTransfer;
	completedAt: number;
}

// ============================================================================
// Stores
// ============================================================================

export const activeTransfers = writable<FileTransfer[]>([]);

/** List of incoming file offers (replaces the single nullable offer) */
export const incomingFileOffers = writable<IncomingFileOffer[]>([]);

/** Backward-compat derived store: first offer or null */
export const incomingFileOffer = derived(incomingFileOffers, ($offers) =>
	$offers.length > 0 ? $offers[0] : null
);

/** History of completed, failed, or cancelled transfers */
export const transferHistory = writable<TransferHistoryEntry[]>([]);

/** Local transfer settings (UI scaffold — no server policy) */
export const transferSettings = writable<TransferSettings>({
	askEveryTime: true,
	autoAcceptTrusted: false,
	autoAcceptUsers: [],
	maxSimultaneousDownloads: 3,
	maxSimultaneousUploads: 3
});

// Persist settings to localStorage
if (typeof localStorage !== 'undefined') {
	try {
		const saved = localStorage.getItem('wabi-transfer-settings');
		if (saved) {
			const parsed = JSON.parse(saved) as TransferSettings;
			transferSettings.set(parsed);
		}
	} catch { /* ignore */ }
	transferSettings.subscribe((s) => {
		try {
			localStorage.setItem('wabi-transfer-settings', JSON.stringify(s));
		} catch { /* ignore */ }
	});
}

// ============================================================================
// Internal state
// ============================================================================

/**
 * Architecture boundary:
 * - The backend (wabi-server) is the shared source of truth for transfer offers,
 *   restart requests, sender/receiver intent, policy, and relay/helper state.
 * - Browser storage/IndexedDB is only for local cache/checkpoints/chunks that
 *   cannot live server-side. It must not become the canonical transfer coordinator.
 *
 * The maps below are intentionally app-session runtime state: open WebRTC
 * objects, selected File handles, and pause/cancel flags. They make the current
 * P2P transport controls real while the server-side transfer-session reducers are not
 * available yet.
 */
const peerConnections = new Map<string, RTCPeerConnection>();
const dataChannels = new Map<string, RTCDataChannel>();
const receiveBuffers = new Map<string, ArrayBuffer[]>();
const receiveMetadata = new Map<string, { fileName: string; fileSize: number }>();
const sendFiles = new Map<string, File>();
const transferSockets = new Map<string, any>();
const transferTargets = new Map<string, string>();
const transferControls = new Map<string, { paused: boolean; cancelled: boolean }>();

function getTransferControl(transferId: string): { paused: boolean; cancelled: boolean } {
	let control = transferControls.get(transferId);
	if (!control) {
		control = { paused: false, cancelled: false };
		transferControls.set(transferId, control);
	}
	return control;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: TransferStatus): boolean {
	return status === 'complete' || status === 'failed' || status === 'cancelled';
}

// ============================================================================
// Send a file via P2P WebRTC data channel
// ============================================================================

export async function sendFileP2P(
	socket: any,
	targetUserId: string,
	file: File
): Promise<string> {
	const transferId = `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return startOutgoingTransfer(socket, targetUserId, file, transferId);
}

async function startOutgoingTransfer(
	socket: any,
	targetUserId: string,
	file: File,
	transferId: string
): Promise<string> {
	await prefetchTurnCredentials();
	const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

	const transfer: FileTransfer = {
		id: transferId,
		fileName: file.name,
		fileSize: file.size,
		transferredBytes: 0,
		senderId: socket.id!,
		receiverId: targetUserId,
		direction: 'send',
		progress: 0,
		status: 'connecting',
		chunkSize: CHUNK_SIZE,
		totalChunks,
		completedChunks: 0
	};

	sendFiles.set(transferId, file);
	transferSockets.set(transferId, socket);
	transferTargets.set(transferId, targetUserId);
	transferControls.set(transferId, { paused: false, cancelled: false });

	activeTransfers.update((transfers) => {
		const withoutExisting = transfers.filter((t) => t.id !== transferId);
		return [...withoutExisting, transfer];
	});

	// Create peer connection
	const pc = new RTCPeerConnection(buildRTCConfig());
	peerConnections.set(transferId, pc);

	// Create data channel
	const dc = pc.createDataChannel('file-transfer', { ordered: true });
	dataChannels.set(transferId, dc);

	dc.binaryType = 'arraybuffer';
	dc.onmessage = (event) => handleTransferControlMessage(transferId, event.data);
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
		void sendFileChunks(transferId, dc, file);
	};

	dc.onerror = () => {
		const current = get(activeTransfers).find((t) => t.id === transferId);
		if (current && !isTerminalStatus(current.status)) {
			updateTransferStatus(transferId, 'failed', 'Data channel error');
		}
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
			const current = get(activeTransfers).find((t) => t.id === transferId);
			if (current && !isTerminalStatus(current.status)) {
				updateTransferStatus(transferId, 'failed', `Peer connection ${pc.connectionState}`);
			}
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
	let completedChunks = 0;
	const speedSamples: { time: number; bytes: number }[] = [];
	let lastSpeedUpdate = 0;
	const control = getTransferControl(transferId);

	try {
		while (offset < arrayBuffer.byteLength) {
			if (control.cancelled) {
				updateTransferStatus(transferId, 'cancelled');
				cleanup(transferId);
				return;
			}

			if (control.paused) {
				updateTransferStatus(transferId, 'paused');
				while (control.paused && !control.cancelled) {
					await sleep(100);
				}
				if (control.cancelled) {
					updateTransferStatus(transferId, 'cancelled');
					cleanup(transferId);
					return;
				}
				updateTransferStatus(transferId, 'transferring');
			}

			// Backpressure: wait for buffer to drain
			while (dc.bufferedAmount > CHUNK_SIZE * 8) {
				if (control.cancelled) {
					updateTransferStatus(transferId, 'cancelled');
					cleanup(transferId);
					return;
				}
				await sleep(10);
			}

			if (dc.readyState !== 'open') {
				throw new Error('Data channel closed before transfer completed');
			}

			const end = Math.min(offset + CHUNK_SIZE, arrayBuffer.byteLength);
			const chunk = arrayBuffer.slice(offset, end);
			dc.send(chunk);
			offset = end;
			completedChunks++;

			const now = Date.now();
			speedSamples.push({ time: now, bytes: offset });
			if (now - lastSpeedUpdate > 500) {
				lastSpeedUpdate = now;
				const cutoff = now - 3000;
				while (speedSamples.length > 1 && speedSamples[0].time < cutoff) {
					speedSamples.shift();
				}
				const speed = speedSamples.length > 1
					? Math.round((speedSamples[speedSamples.length - 1].bytes - speedSamples[0].bytes)
						/ ((speedSamples[speedSamples.length - 1].time - speedSamples[0].time) / 1000))
					: undefined;
				updateTransferProgress(transferId, offset / arrayBuffer.byteLength, offset, completedChunks, speed);
			}
		}

		updateTransferStatus(transferId, 'verifying');
		updateTransferProgress(transferId, 1, offset, completedChunks, 0);

		if (dc.readyState === 'open') {
			dc.send(JSON.stringify({ type: 'file-complete' }));
		}
		updateTransferStatus(transferId, 'complete');
		setTimeout(() => cleanup(transferId), 5000);
	} catch (error) {
		if (control.cancelled) {
			updateTransferStatus(transferId, 'cancelled');
		} else {
			updateTransferStatus(
				transferId,
				'failed',
				error instanceof Error ? error.message : 'Transfer failed while sending chunks'
			);
		}
		cleanup(transferId);
	}
}

function handleTransferControlMessage(transferId: string, data: unknown): void {
	if (typeof data !== 'string') return;
	let msg: { type?: string; action?: string };
	try {
		msg = JSON.parse(data);
	} catch {
		return;
	}
	if (msg.type !== 'transfer-control') return;

	const control = getTransferControl(transferId);
	if (msg.action === 'pause') {
		control.paused = true;
		updateTransferStatus(transferId, 'paused');
	} else if (msg.action === 'resume') {
		control.paused = false;
		control.cancelled = false;
		updateTransferStatus(transferId, 'transferring');
	} else if (msg.action === 'cancel') {
		control.cancelled = true;
		updateTransferStatus(transferId, 'cancelled');
		cleanup(transferId);
	}
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
	const offer: IncomingFileOffer = {
		transferId: data.transferId,
		senderId: data.senderId,
		senderUsername: data.senderUsername,
		fileName: data.fileName,
		fileSize: data.fileSize,
		offer: data.offer
	};
	incomingFileOffers.update((offers) => [...offers, offer]);
}

export async function acceptFileTransfer(socket: any, transferId?: string): Promise<void> {
	await prefetchTurnCredentials();
	const offers = get(incomingFileOffers);
	const offer = transferId
		? offers.find((o) => o.transferId === transferId)
		: offers[0];
	if (!offer) return;

	incomingFileOffers.update((offers) => offers.filter((o) => o.transferId !== offer.transferId));

	const totalChunks = Math.ceil(offer.fileSize / CHUNK_SIZE);
	const transfer: FileTransfer = {
		id: offer.transferId,
		fileName: offer.fileName,
		fileSize: offer.fileSize,
		transferredBytes: 0,
		senderId: offer.senderId,
		receiverId: socket.id!,
		direction: 'receive',
		progress: 0,
		status: 'connecting',
		chunkSize: CHUNK_SIZE,
		totalChunks,
		completedChunks: 0
	};

	activeTransfers.update((transfers) => {
		const withoutExisting = transfers.filter((t) => t.id !== transfer.id);
		return [...withoutExisting, transfer];
	});

	// Create peer connection
	const pc = new RTCPeerConnection(buildRTCConfig());
	peerConnections.set(offer.transferId, pc);

	// Handle incoming data channel
	pc.ondatachannel = (event) => {
		const dc = event.channel;
		dc.binaryType = 'arraybuffer';
		dataChannels.set(offer.transferId, dc);
		transferControls.set(offer.transferId, { paused: false, cancelled: false });
		receiveBuffers.set(offer.transferId, []);

		let receiveSpeedSamples: { time: number; bytes: number }[] = [];
		let receiveLastSpeedUpdate = 0;

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
					updateTransferStatus(offer.transferId, 'verifying');
					assembleAndDownload(offer.transferId);
				}
			} else {
				if (getTransferControl(offer.transferId).cancelled) return;
				// Binary chunk
				const chunks = receiveBuffers.get(offer.transferId);
				if (chunks) {
					chunks.push(msgEvent.data as ArrayBuffer);
					const meta = receiveMetadata.get(offer.transferId);
					if (meta) {
						const received = chunks.reduce((sum, c) => sum + c.byteLength, 0);
						const completedChunks = chunks.length;
						const totalChunks = Math.ceil(meta.fileSize / CHUNK_SIZE);

						// Speed tracking
						const now = Date.now();
						receiveSpeedSamples.push({ time: now, bytes: received });
						let speed: number | undefined;
						if (now - receiveLastSpeedUpdate > 500) {
							receiveLastSpeedUpdate = now;
							const cutoff = now - 3000;
							while (receiveSpeedSamples.length > 1 && receiveSpeedSamples[0].time < cutoff) {
								receiveSpeedSamples.shift();
							}
							if (receiveSpeedSamples.length > 1) {
								speed = Math.round(
									(receiveSpeedSamples[receiveSpeedSamples.length - 1].bytes - receiveSpeedSamples[0].bytes)
									/ ((receiveSpeedSamples[receiveSpeedSamples.length - 1].time - receiveSpeedSamples[0].time) / 1000)
								);
							}
						}
						updateTransferProgress(offer.transferId, received / meta.fileSize, received, completedChunks, speed);
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

export function rejectFileTransfer(transferId?: string): void {
	incomingFileOffers.update((offers) =>
		transferId ? offers.filter((o) => o.transferId !== transferId) : []
	);
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

function updateTransferProgress(
	transferId: string,
	progress: number,
	transferredBytes?: number,
	completedChunks?: number,
	speedBytesPerSec?: number
): void {
	activeTransfers.update((transfers) =>
		transfers.map((t) =>
			t.id === transferId
				? {
						...t,
						progress,
						...(transferredBytes !== undefined ? { transferredBytes } : {}),
						...(completedChunks !== undefined ? { completedChunks } : {}),
						...(speedBytesPerSec !== undefined ? { speedBytesPerSec } : {})
				  }
				: t
		)
	);
}

function updateTransferStatus(transferId: string, status: TransferStatus, errorMessage?: string): void {
	activeTransfers.update((transfers) =>
		transfers.map((t) =>
			t.id === transferId ? { ...t, status, ...(errorMessage !== undefined ? { errorMessage } : {}) } : t
		)
	);
}

function moveToHistory(transferId: string): void {
	const transfer = get(activeTransfers).find((t) => t.id === transferId);
	if (transfer && isTerminalStatus(transfer.status)) {
		transferHistory.update((h) => [
			{ transfer, completedAt: Date.now() },
			...h.filter((entry) => entry.transfer.id !== transferId).slice(0, 199) // keep last 200 unique transfer ids
		]);
	}
}

function cleanup(transferId: string): void {
	cleanupTransportOnly(transferId);

	// Move to history then remove from active after a delay
	moveToHistory(transferId);
	setTimeout(() => {
		activeTransfers.update((transfers) => transfers.filter((t) => t.id !== transferId));
	}, 10000);
}

function cleanupTransportOnly(transferId: string): void {
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
}

function sendControlMessage(transferId: string, action: 'pause' | 'resume' | 'cancel'): void {
	const dc = dataChannels.get(transferId);
	if (!dc || dc.readyState !== 'open') return;
	dc.send(JSON.stringify({ type: 'transfer-control', action, transferId }));
}

export function cancelTransfer(transferId: string): void {
	const control = getTransferControl(transferId);
	control.cancelled = true;
	control.paused = false;
	sendControlMessage(transferId, 'cancel');
	updateTransferStatus(transferId, 'cancelled');
	cleanup(transferId);
}

export function pauseTransfer(transferId: string): void {
	const control = getTransferControl(transferId);
	control.paused = true;
	sendControlMessage(transferId, 'pause');
	updateTransferStatus(transferId, 'paused');
}

export function resumeTransfer(transferId: string): void {
	const control = getTransferControl(transferId);
	const dc = dataChannels.get(transferId);
	if (!dc || dc.readyState !== 'open') {
		updateTransferStatus(transferId, 'failed', 'Data channel not available for resume');
		return;
	}
	control.paused = false;
	control.cancelled = false;
	updateTransferStatus(transferId, 'resuming');
	sendControlMessage(transferId, 'resume');
	setTimeout(() => {
		const current = get(activeTransfers).find((t) => t.id === transferId);
		if (current && current.status === 'resuming') updateTransferStatus(transferId, 'transferring');
	}, 100);
}

/**
 * Restart/retry a transfer.
 *
 * Current guarantee: outgoing transfers can be restarted during the same app
 * session because the sender keeps the original File object in memory and
 * emits a fresh WebRTC offer for the same transfer id.
 *
 * Still missing until the server-side transfer-session work lands: durable restart
 * after page reload/device restart and receiver-originated re-request routing.
 */
export function restartTransfer(transferId: string, socket?: any): void {
	let transfer = get(activeTransfers).find((t) => t.id === transferId);
	if (!transfer) {
		const historyEntry = get(transferHistory).find((e) => e.transfer.id === transferId);
		if (historyEntry) {
			transfer = historyEntry.transfer;
			transferHistory.update((h) => h.filter((e) => e.transfer.id !== transferId));
		}
	}

	if (!transfer) return;

	if (transfer.direction !== 'send') {
		activeTransfers.update((transfers) => {
			const withoutExisting = transfers.filter((t) => t.id !== transferId);
			return [
				...withoutExisting,
				{
					...transfer!,
					status: 'requesting',
					progress: 0,
					transferredBytes: 0,
					completedChunks: 0,
					speedBytesPerSec: undefined,
					errorMessage: 'Restart requested. Receiver-side re-request needs server-side transfer-session routing; ask the sender to resend for now.'
				}
			];
		});
		return;
	}

	const file = sendFiles.get(transferId);
	const targetUserId = transferTargets.get(transferId) || transfer.receiverId;
	const effectiveSocket = socket || transferSockets.get(transferId);

	if (!file || !effectiveSocket || !targetUserId) {
		activeTransfers.update((transfers) => {
			const withoutExisting = transfers.filter((t) => t.id !== transferId);
			return [
				...withoutExisting,
				{
					...transfer!,
					status: 'failed',
					errorMessage: 'Cannot restart: original file/socket is no longer available in this app session.'
				}
			];
		});
		return;
	}

	cleanupTransportOnly(transferId);
	transferControls.set(transferId, { paused: false, cancelled: false });
	void startOutgoingTransfer(effectiveSocket, targetUserId, file, transferId).catch((error) => {
		updateTransferStatus(
			transferId,
			'failed',
			error instanceof Error ? error.message : 'Failed to restart transfer'
		);
	});
}
