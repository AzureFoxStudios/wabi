import { get, writable } from 'svelte/store';
import {
	joinWhiteboardChannel,
	leaveWhiteboard,
	rejoinWhiteboardBoard,
	saveWhiteboardSnapshot,
	sendWhiteboardPatch,
	sendWhiteboardCursor,
	subscribeWhiteboardEvents,
	type WhiteboardAckPayload
} from './boardSocket';
import { getChannelBoardId, type WhiteboardDocument, type WhiteboardErrorPayload } from './boardTypes';
import { boardStore, isDirty, setPatchListener } from './boardStore';
import { fromTransportElement, toTransportElement, type BoardElement } from './elementTypes';
import { currentUser } from '$lib/socket-manager';

// ---------------------------------------------------------------------------
// Sync status signals
// ---------------------------------------------------------------------------

export const boardSyncReady = writable<boolean>(false);
export const boardSyncError = writable<string | null>(null);

// ---------------------------------------------------------------------------
// Patch emission
//
// element:update patches are coalesced: rapid updates to the same element
// within a 50ms window (move/resize drags) merge into a single patch. The
// buffer flushes on its per-element timer, on flushSnapshotSave, or is dropped
// on disconnect/conflict (the server doc wins there).
// ---------------------------------------------------------------------------

const PATCH_COALESCE_MS = 50;

interface PendingUpdate {
	changes: Record<string, unknown>;
	timer: ReturnType<typeof setTimeout>;
}

const pendingUpdates = new Map<string, Map<string, PendingUpdate>>();

export function emitCreatePatch(boardId: string, el: BoardElement): void {
	sendWhiteboardPatch(boardId, { op: 'create', element: toTransportElement(el) });
}

export function emitUpdatePatch(boardId: string, id: string, changes: Record<string, unknown>): void {
	let inner = pendingUpdates.get(boardId);
	if (!inner) {
		inner = new Map();
		pendingUpdates.set(boardId, inner);
	}
	const existing = inner.get(id);
	if (existing) {
		existing.changes = { ...existing.changes, ...changes };
		return;
	}
	const entry: PendingUpdate = {
		changes: { ...changes },
		timer: setTimeout(() => flushPendingUpdate(boardId, id), PATCH_COALESCE_MS)
	};
	inner.set(id, entry);
}

function flushPendingUpdate(boardId: string, id: string): void {
	const inner = pendingUpdates.get(boardId);
	if (!inner) return;
	const entry = inner.get(id);
	if (!entry) return;
	inner.delete(id);
	if (inner.size === 0) pendingUpdates.delete(boardId);
	sendWhiteboardPatch(boardId, { op: 'update', id, changes: entry.changes });
}

function flushPendingUpdates(boardId: string): void {
	const inner = pendingUpdates.get(boardId);
	if (!inner) return;
	for (const id of [...inner.keys()]) {
		flushPendingUpdate(boardId, id);
	}
}

function clearPendingUpdates(boardId: string): void {
	const inner = pendingUpdates.get(boardId);
	if (!inner) return;
	for (const entry of inner.values()) clearTimeout(entry.timer);
	pendingUpdates.delete(boardId);
}

export function emitDeletePatch(boardId: string, ids: string[]): void {
	sendWhiteboardPatch(boardId, { op: 'delete', ids });
}

export function emitReorderPatch(boardId: string, id: string, dir: string): void {
	sendWhiteboardPatch(boardId, { op: 'reorder', id, dir });
}

export function emitLayerCreatePatch(boardId: string, layer: unknown): void {
	sendWhiteboardPatch(boardId, { op: 'layer:create', layer });
}

export function emitLayerUpdatePatch(boardId: string, id: string, changes: Record<string, unknown>): void {
	sendWhiteboardPatch(boardId, { op: 'layer:update', id, changes });
}

export function emitLayerDeletePatch(boardId: string, id: string): void {
	sendWhiteboardPatch(boardId, { op: 'layer:delete', id });
}

export function emitLayerReorderPatch(boardId: string, id: string, dir: string): void {
	sendWhiteboardPatch(boardId, { op: 'layer:reorder', id, dir });
}

export function emitLayerSelectPatch(boardId: string, id: string): void {
	sendWhiteboardPatch(boardId, { op: 'layer:select', id });
}

// ---------------------------------------------------------------------------
// Remote patch application
// ---------------------------------------------------------------------------

export function applyRemotePatch(payload: { patch: any }): void {
	const patch = payload.patch;
	if (!patch || !patch.op) return;

	switch (patch.op) {
		case 'create': {
			const el = fromTransportElement(patch.element);
			boardStore.addElementSilent(el);
			break;
		}
		case 'update': {
			boardStore.updateElementSilent(patch.id, patch.changes || {});
			break;
		}
		case 'delete': {
			boardStore.deleteElementsSilent(patch.ids || []);
			break;
		}
		case 'reorder': {
			// Reorder is harder to do silently; reload on next snapshot
			break;
		}
		case 'layer:create': {
			boardStore.ensureLayerSilent(patch.layer || {});
			break;
		}
		case 'layer:update': {
			if (typeof patch.id === 'string') {
				boardStore.updateLayerSilent(patch.id, patch.changes || {});
			}
			break;
		}
		case 'layer:delete': {
			if (typeof patch.id === 'string') {
				boardStore.deleteLayerSilent(patch.id);
			}
			break;
		}
		case 'layer:reorder': {
			if (typeof patch.id === 'string' && typeof patch.dir === 'string') {
				boardStore.reorderLayerSilent(patch.id, patch.dir as 'front' | 'back' | 'forward' | 'backward');
			}
			break;
		}
		case 'layer:select': {
			if (typeof patch.id === 'string') {
				boardStore.setActiveLayerIdSilent(patch.id);
			}
			break;
		}
		case 'replace': {
			const document = patch.document as WhiteboardDocument | undefined;
			if (!document) return;
			applyRemoteSnapshot({ document });
			break;
		}
	}
}

export function applyRemoteSnapshot(payload: { document: WhiteboardDocument }): void {
	const doc = payload.document;
	if (!doc) return;
	boardStore.setDocument(doc);
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

const SNAPSHOT_DEBOUNCE_MS = 2000;

const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSnapshotSave(boardId: string): void {
	const existing = snapshotTimers.get(boardId);
	if (existing) clearTimeout(existing);
	snapshotTimers.set(boardId, setTimeout(() => {
		snapshotTimers.delete(boardId);
		flushSnapshotSave(boardId);
	}, SNAPSHOT_DEBOUNCE_MS));
}

export function flushSnapshotSave(boardId: string): void {
	const existing = snapshotTimers.get(boardId);
	if (existing) {
		clearTimeout(existing);
		snapshotTimers.delete(boardId);
	}
	flushPendingUpdates(boardId);
	if (!get(isDirty)) return;
	const doc = boardStore.getSnapshotDocument();
	if (!doc.boardId || doc.boardId !== boardId) return;
	saveWhiteboardSnapshot(boardId, doc);
	boardStore.markClean();
}

export function cancelSnapshotSave(boardId: string): void {
	const existing = snapshotTimers.get(boardId);
	if (existing) {
		clearTimeout(existing);
		snapshotTimers.delete(boardId);
	}
}

// ---------------------------------------------------------------------------
// Cursor broadcast
// ---------------------------------------------------------------------------

let lastCursorBroadcast = 0;
let lastCursorX = Number.NaN;
let lastCursorY = Number.NaN;

export function broadcastCursor(boardId: string, data: { x: number; y: number; username: string; color: string }): void {
	const now = Date.now();
	if (now - lastCursorBroadcast < 100 || (Math.abs(data.x - lastCursorX) < 2 && Math.abs(data.y - lastCursorY) < 2)) return;
	lastCursorBroadcast = now;
	lastCursorX = data.x;
	lastCursorY = data.y;
	sendWhiteboardCursor(boardId, data);
}

// ---------------------------------------------------------------------------
// Sync session lifecycle
// ---------------------------------------------------------------------------

export interface SyncSession {
	destroy: () => void;
}

// VERSION_CONFLICT recovery re-joins the board so the server re-pulls the doc
// (server doc wins). Guard against a re-join loop: at most 3 re-joins within a
// 10s window, after which we surface a persistent error and stop.
const REJOIN_LIMIT = 3;
const REJOIN_WINDOW_MS = 10000;
let conflictRejoinAt: number[] = [];

function canRejoinAfterConflict(): boolean {
	const now = Date.now();
	conflictRejoinAt = conflictRejoinAt.filter((t) => now - t < REJOIN_WINDOW_MS);
	if (conflictRejoinAt.length >= REJOIN_LIMIT) {
		boardSyncError.set('Sync failed — reload the board.');
		return false;
	}
	conflictRejoinAt.push(now);
	return true;
}

function handleSyncError(
	payload: WhiteboardErrorPayload,
	channelId: string,
	handlers: {
		onError?: (payload: any) => void;
	}
): void {
	const boardId = getChannelBoardId(channelId);
	const code = payload.code;
	switch (code) {
		case 'VERSION_CONFLICT':
			// Server doc wins: drop any pending outbound patches and the debounced
			// save timer so stale local state is never re-persisted after re-pull.
			clearPendingUpdates(boardId);
			cancelSnapshotSave(boardId);
			boardStore.markClean();
			if (canRejoinAfterConflict()) {
				boardSyncError.set('Your changes conflicted with a newer version — re-syncing.');
				rejoinWhiteboardBoard(boardId);
			}
			break;
		case 'DESKTOP_REQUIRED':
			boardSyncError.set('This whiteboard is desktop-only. Open the desktop app to edit it.');
			break;
		case 'READ_ONLY':
			boardSyncError.set('This whiteboard is read-only — you can view but not edit.');
			break;
		default:
			boardSyncError.set(payload.message || 'Whiteboard error');
			break;
	}
	handlers.onError?.(payload);
}

export function createSyncSession(
	channelId: string,
	handlers: {
		onRemotePatch?: (payload: any) => void;
		onRemoteCursor?: (payload: any) => void;
		onPresence?: (payload: any) => void;
		onError?: (payload: any) => void;
		onReady?: () => void;
	} = {}
): SyncSession {
	const boardId = getChannelBoardId(channelId);
	boardStore.setBoardId(boardId);
	boardSyncReady.set(false);
	boardSyncError.set(null);
	const localUser = get(currentUser);
	const localStableId =
		typeof localUser?.dbUserId === 'number' ? `user-${localUser.dbUserId}` : (localUser?.id || '');
	let hasHydratedFromSnapshot = false;

	// Guests carry no JWT identity — the server rejects whiteboard:join with
	// UNAUTHORIZED ("Authentication required") even though local drawing works
	// fine. Skip the socket session entirely so no red error toasts surface;
	// the board stays fully functional as a local-only scratchpad. Raster
	// commits still upload through their own guest-session REST path.
	if (typeof localUser?.dbUserId !== 'number') {
		boardSyncReady.set(true);
		handlers.onReady?.();
		return {
			destroy() {
				boardSyncReady.set(false);
				boardSyncError.set(null);
			}
		};
	}

	// Subscribe to remote events
	const unsubEvents = subscribeWhiteboardEvents({
		onJoined: (payload) => {
			if (payload.boardId !== boardId) return;
			boardStore.setDocument(payload.document);
			if (!hasHydratedFromSnapshot) {
				hasHydratedFromSnapshot = true;
				handlers.onReady?.();
			}
			boardSyncReady.set(true);
			boardSyncError.set(null);
		},
		onLeft: (payload) => {
			if (payload.boardId !== boardId) return;
			boardSyncReady.set(false);
		},
		onSnapshot: (payload) => {
			if (payload.boardId !== boardId) return;
			if (!hasHydratedFromSnapshot) {
				applyRemoteSnapshot(payload);
				hasHydratedFromSnapshot = true;
				handlers.onReady?.();
				return;
			}
			if (payload.updatedBy && payload.updatedBy === localStableId) {
				boardStore.markClean();
				return;
			}
			if (get(isDirty)) {
				return;
			}
			applyRemoteSnapshot(payload);
		},
		onPatch: (payload) => {
			if (payload.boardId !== boardId) return;
			applyRemotePatch(payload);
			handlers.onRemotePatch?.(payload);
		},
		onCursor: (payload) => {
			if (payload.boardId !== boardId) return;
			handlers.onRemoteCursor?.(payload);
		},
		onPresence: (payload) => {
			if (payload.boardId !== boardId) return;
			handlers.onPresence?.(payload);
		},
		onAck: (payload: WhiteboardAckPayload) => {
			if (payload.boardId && payload.boardId !== boardId) return;
			if (typeof payload.version === 'number') {
				boardStore.setVersion(payload.version);
			}
		},
		onError: (payload) => {
			handleSyncError(payload, channelId, handlers);
		},
		onDisconnect: () => {
			// Socket dropped (possibly mid-reconnect). Until a fresh
			// whiteboard:joined re-hydrates the doc, components must not render
			// stale state. Drop any coalesced patches too — the server doc wins
			// after re-join.
			clearPendingUpdates(boardId);
			boardSyncReady.set(false);
		}
	});

	// Wire patch listener so boardStore mutations emit patches.
	// Undo/redo ('replace') stays local-only — it is persisted via snapshot.
	setPatchListener((type, payload) => {
		switch (type) {
			case 'create':
				emitCreatePatch(boardId, payload as BoardElement);
				break;
			case 'update': {
				const p = payload as { id: string; changes?: Record<string, unknown> };
				emitUpdatePatch(boardId, p.id, p.changes || {});
				break;
			}
			case 'delete': {
				const p = payload as { ids: string[] };
				emitDeletePatch(boardId, p.ids);
				break;
			}
			case 'reorder': {
				const p = payload as { id: string; dir: string };
				emitReorderPatch(boardId, p.id, p.dir);
				break;
			}
			case 'layer:create': {
				emitLayerCreatePatch(boardId, payload);
				break;
			}
			case 'layer:update': {
				const p = payload as { id: string; changes?: Record<string, unknown> };
				emitLayerUpdatePatch(boardId, p.id, p.changes || {});
				break;
			}
			case 'layer:delete': {
				const p = payload as { id: string };
				emitLayerDeletePatch(boardId, p.id);
				break;
			}
			case 'layer:reorder': {
				const p = payload as { id: string; dir: string };
				emitLayerReorderPatch(boardId, p.id, p.dir);
				break;
			}
			case 'layer:select': {
				const p = payload as { id: string };
				emitLayerSelectPatch(boardId, p.id);
				break;
			}
		}
		scheduleSnapshotSave(boardId);
	});

	// Debounced snapshot persistence on any local mutation.
	const unsubDirty = isDirty.subscribe((dirty) => {
		if (dirty) scheduleSnapshotSave(boardId);
	});

	// Join the channel
	joinWhiteboardChannel(channelId);

	// Flush on visibility change and beforeunload
	const onVisChange = () => {
		if (document.hidden) flushSnapshotSave(boardId);
	};
	const onBeforeUnload = () => flushSnapshotSave(boardId);
	document.addEventListener('visibilitychange', onVisChange);
	window.addEventListener('beforeunload', onBeforeUnload);

	return {
		destroy() {
			flushSnapshotSave(boardId);
			cancelSnapshotSave(boardId);
			clearPendingUpdates(boardId);
			setPatchListener(null);
			unsubDirty();
			unsubEvents();
			leaveWhiteboard(boardId);
			boardSyncReady.set(false);
			boardSyncError.set(null);
			document.removeEventListener('visibilitychange', onVisChange);
			window.removeEventListener('beforeunload', onBeforeUnload);
		}
	};
}
