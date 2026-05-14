import { get } from 'svelte/store';
import {
	joinWhiteboardChannel,
	leaveWhiteboard,
	saveWhiteboardSnapshot,
	sendWhiteboardPatch,
	sendWhiteboardCursor,
	subscribeWhiteboardEvents
} from './boardSocket';
import { getChannelBoardId, type WhiteboardDocument } from './boardTypes';
import { boardStore, isDirty, setPatchListener } from './boardStore';
import { fromTransportElement, toTransportElement, type BoardElement } from './elementTypes';
import { currentUser } from '$lib/socket-manager';

// ---------------------------------------------------------------------------
// Patch emission
// ---------------------------------------------------------------------------

export function emitCreatePatch(boardId: string, el: BoardElement): void {
	sendWhiteboardPatch(boardId, { op: 'create', element: toTransportElement(el) });
}

export function emitUpdatePatch(boardId: string, id: string, changes: Record<string, unknown>): void {
	sendWhiteboardPatch(boardId, { op: 'update', id, changes });
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
	const elements = (doc.elements || []).map(fromTransportElement);
	boardStore.loadDocument({
		boardId: doc.boardId,
		version: doc.version,
		elements,
		layers: Array.isArray(doc.layers) ? doc.layers : [],
		activeLayerId: typeof doc.activeLayerId === 'string' ? doc.activeLayerId : '',
		viewport: doc.viewport || { x: 0, y: 0, zoom: 1 }
	});
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSnapshotSave(boardId: string): void {
	const existing = snapshotTimers.get(boardId);
	if (existing) clearTimeout(existing);
	snapshotTimers.set(boardId, setTimeout(() => {
		snapshotTimers.delete(boardId);
		flushSnapshotSave(boardId);
	}, 3000));
}

export function flushSnapshotSave(boardId: string): void {
	const existing = snapshotTimers.get(boardId);
	if (existing) {
		clearTimeout(existing);
		snapshotTimers.delete(boardId);
	}
	if (!get(isDirty)) return;
	const doc = boardStore.getDocument();
	if (!doc.boardId || doc.boardId !== boardId) return;
	const transportDoc: WhiteboardDocument = {
		boardId: doc.boardId,
		version: doc.version,
		updatedAt: Date.now(),
		elements: doc.elements.map(toTransportElement),
		layers: doc.layers,
		activeLayerId: doc.activeLayerId,
		viewport: doc.viewport
	};
	saveWhiteboardSnapshot(boardId, transportDoc);
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

export function broadcastCursor(boardId: string, data: { x: number; y: number; username: string; color: string }): void {
	const now = Date.now();
	if (now - lastCursorBroadcast < 50) return;
	lastCursorBroadcast = now;
	sendWhiteboardCursor(boardId, data);
}

// ---------------------------------------------------------------------------
// Sync session lifecycle
// ---------------------------------------------------------------------------

export interface SyncSession {
	destroy: () => void;
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
	const localUser = get(currentUser);
	const localStableId =
		typeof localUser?.dbUserId === 'number' ? `user-${localUser.dbUserId}` : (localUser?.id || '');
	let hasHydratedFromSnapshot = false;

	// Subscribe to remote events
	const unsubEvents = subscribeWhiteboardEvents({
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
		onError: (payload) => {
			handlers.onError?.(payload);
		}
	});

	// Wire patch listener so boardStore mutations emit patches
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
			case 'replace': {
				const p = payload as { document?: ReturnType<typeof boardStore.getDocument> };
				if (!p.document) break;
				sendWhiteboardPatch(boardId, {
					op: 'replace',
					document: {
						boardId,
						version: p.document.version,
						updatedAt: Date.now(),
						elements: p.document.elements.map(toTransportElement),
						layers: p.document.layers,
						activeLayerId: p.document.activeLayerId,
						viewport: p.document.viewport
					}
				});
				break;
			}
		}
		scheduleSnapshotSave(boardId);
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
			setPatchListener(null);
			unsubEvents();
			leaveWhiteboard(boardId);
			document.removeEventListener('visibilitychange', onVisChange);
			window.removeEventListener('beforeunload', onBeforeUnload);
		}
	};
}
