import { getSocket } from '$lib/socket-manager';
import type {
	WhiteboardCursorPayload,
	WhiteboardDocument,
	WhiteboardErrorPayload,
	WhiteboardPatchPayload,
	WhiteboardPresencePayload,
	WhiteboardSnapshotPayload
} from './boardTypes';

interface WhiteboardEventHandlers {
	onSnapshot?: (payload: WhiteboardSnapshotPayload) => void;
	onPresence?: (payload: WhiteboardPresencePayload) => void;
	onPatch?: (payload: WhiteboardPatchPayload) => void;
	onCursor?: (payload: WhiteboardCursorPayload) => void;
	onError?: (payload: WhiteboardErrorPayload) => void;
}

export function joinWhiteboardChannel(channelId: string): void {
	const socket = getSocket();
	if (!socket || !channelId.trim()) return;
	socket.emit('whiteboard:join', { channelId: channelId.trim() });
}

export function leaveWhiteboard(boardId: string): void {
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
	const socket = getSocket();
	if (!socket) return () => {};

	const listeners: Array<[string, (payload: unknown) => void]> = [];
	const addListener = <T>(event: string, handler?: (payload: T) => void) => {
		if (!handler) return;
		const listener = (payload: unknown) => {
			handler(payload as T);
		};
		listeners.push([event, listener]);
		socket.on(event, listener);
	};

	addListener<WhiteboardSnapshotPayload>('whiteboard:snapshot', handlers.onSnapshot);
	addListener<WhiteboardPresencePayload>('whiteboard:presence', handlers.onPresence);
	addListener<WhiteboardPatchPayload>('whiteboard:patch', handlers.onPatch);
	addListener<WhiteboardCursorPayload>('whiteboard:cursor', handlers.onCursor);
	addListener<WhiteboardErrorPayload>('whiteboard:error', handlers.onError);

	return () => {
		for (const [event, listener] of listeners) {
			socket.off(event, listener);
		}
	};
}
