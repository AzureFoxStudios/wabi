import { get } from 'svelte/store';
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
}

const activeBoards = new Set<string>();

function clientClass(): 'tauri' | 'web' {
	return isTauriRuntime() ? 'tauri' : 'web';
}

function rejoinActiveBoards(): void {
	if (activeBoards.size === 0) return;
	const socket = getSocket();
	if (!socket) return;
	for (const boardId of activeBoards) {
		socket.emit('whiteboard:join', { boardId, clientClass: clientClass() });
	}
}

export function joinWhiteboardChannel(channelId: string): void {
	const socket = getSocket();
	if (!socket || !channelId.trim()) return;
	const boardId = getChannelBoardId(channelId.trim());
	activeBoards.add(boardId);
	socket.emit('whiteboard:join', { boardId, clientClass: clientClass() });
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
	const unsubConnected = connected.subscribe((isConnected) => {
		if (isConnected) {
			bindToSocket();
			rejoinActiveBoards();
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
