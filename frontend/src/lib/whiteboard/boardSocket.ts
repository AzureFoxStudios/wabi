import type { Socket } from 'socket.io-client';
import { getSocket, socket as socketStore, connected } from '$lib/socket-manager';
import { isTauriRuntime } from '$lib/tauri-platform';
import {
	getChannelBoardId,
	type WhiteboardCursorPayload,
	type WhiteboardDocument,
	type WhiteboardErrorPayload,
	type WhiteboardPatchPayload,
	type WhiteboardPresencePayload,
	type WhiteboardSnapshotPayload
} from './boardTypes';

export interface WhiteboardJoinedPayload {
	boardId: string;
	channelId?: string;
	document: WhiteboardDocument;
	capability: string;
}

export interface WhiteboardLeftPayload {
	boardId: string;
	channelId?: string;
}

export interface WhiteboardAckPayload {
	patchId: string;
	version: number;
	boardId?: string;
}

export interface WhiteboardEventHandlers {
	onJoined?: (payload: WhiteboardJoinedPayload) => void;
	onLeft?: (payload: WhiteboardLeftPayload) => void;
	onSnapshot?: (payload: WhiteboardSnapshotPayload) => void;
	onPresence?: (payload: WhiteboardPresencePayload) => void;
	onPatch?: (payload: WhiteboardPatchPayload) => void;
	onCursor?: (payload: WhiteboardCursorPayload) => void;
	onAck?: (payload: WhiteboardAckPayload) => void;
	onError?: (payload: WhiteboardErrorPayload) => void;
	/** Fired when the underlying socket transitions to disconnected (e.g. mid-reconnect). */
	onDisconnect?: () => void;
}

const activeBoards = new Set<string>();

function clientClass(): 'tauri' | 'web' {
	return isTauriRuntime() ? 'tauri' : 'web';
}

function emitWhiteboardJoin(boardId: string): void {
	const socket = getSocket();
	if (!socket || !boardId.trim()) return;
	socket.emit('whiteboard:join', { boardId: boardId.trim(), clientClass: clientClass() });
}

function rejoinActiveBoards(): void {
	if (activeBoards.size === 0) return;
	for (const boardId of activeBoards) {
		emitWhiteboardJoin(boardId);
	}
}

export function joinWhiteboardChannel(channelId: string): void {
	if (!channelId.trim()) return;
	const boardId = getChannelBoardId(channelId.trim());
	// Double-join guard: a board that is already active is a no-op. Reconnects
	// re-join through rejoinActiveBoards(), and conflicts re-join explicitly
	// through rejoinWhiteboardBoard().
	if (activeBoards.has(boardId)) return;
	activeBoards.add(boardId);
	emitWhiteboardJoin(boardId);
}

/**
 * Re-join a board that is already active. Unlike joinWhiteboardChannel this
 * always emits the join (used by the VERSION_CONFLICT recovery path, where the
 * server must re-pull the doc and re-broadcast whiteboard:joined).
 */
export function rejoinWhiteboardBoard(boardId: string): void {
	emitWhiteboardJoin(boardId);
}

export function leaveWhiteboard(boardId: string): void {
	activeBoards.delete(boardId);
	const socket = getSocket();
	if (!socket || !boardId.trim()) return;
	socket.emit('whiteboard:leave', { boardId: boardId.trim() });
}

export function saveWhiteboardSnapshot(boardId: string, document: WhiteboardDocument): void {
	const socket = getSocket();
	if (!socket || !boardId.trim()) return;
	socket.emit('whiteboard:snapshot', { boardId: boardId.trim(), document });
}

export function sendWhiteboardPatch(boardId: string, patch: unknown): void {
	const socket = getSocket();
	if (!socket || !boardId.trim()) return;
	socket.emit('whiteboard:patch', { boardId: boardId.trim(), patch });
}

export function sendWhiteboardCursor(boardId: string, cursor: unknown): void {
	const socket = getSocket();
	if (!socket || !boardId.trim()) return;
	socket.emit('whiteboard:cursor', { boardId: boardId.trim(), cursor });
}

export function subscribeWhiteboardEvents(handlers: WhiteboardEventHandlers): () => void {
	let unsubSocketEvents: (() => void) | null = null;
	let currentSocket: Socket | null = null;

	function bindToSocket(): void {
		const socket = getSocket();
		if (!socket || socket === currentSocket) return;
		if (unsubSocketEvents) {
			unsubSocketEvents();
			unsubSocketEvents = null;
		}
		currentSocket = socket;

		const listeners: Array<[string, (payload: unknown) => void]> = [];
		const addListener = <T>(event: string, handler?: (payload: T) => void) => {
			if (!handler) return;
			const listener = (payload: unknown) => {
				handler(payload as T);
			};
			listeners.push([event, listener]);
			socket.on(event, listener);
		};

		addListener('whiteboard:joined', handlers.onJoined);
		addListener('whiteboard:left', handlers.onLeft);
		addListener('whiteboard:snapshot', handlers.onSnapshot);
		addListener('whiteboard:presence', handlers.onPresence);
		addListener('whiteboard:patch', handlers.onPatch);
		addListener('whiteboard:cursor', handlers.onCursor);
		addListener('whiteboard:ack', handlers.onAck);
		addListener('whiteboard:error', handlers.onError);

		unsubSocketEvents = () => {
			for (const [event, listener] of listeners) {
				socket.off(event, listener);
			}
		};
	}

	// Initial bind to the live socket (if any).
	bindToSocket();

	// Rebind to a replacement socket instance created by the SocketManager
	// reconnection flow (it destroys the old socket and builds a new one).
	const unsubSocket = socketStore.subscribe(() => {
		bindToSocket();
	});

	// On reconnect: re-join the active board so the server re-pulls the doc.
	// On disconnect: surface the transition so sessions can drop the ready flag
	// (components must not draw on stale state while the doc is being re-pulled).
	const unsubConnected = connected.subscribe((isConnected) => {
		if (isConnected) {
			bindToSocket();
			rejoinActiveBoards();
		} else {
			handlers.onDisconnect?.();
		}
	});

	return () => {
		if (unsubSocketEvents) {
			unsubSocketEvents();
			unsubSocketEvents = null;
		}
		currentSocket = null;
		unsubSocket();
		unsubConnected();
	};
}
