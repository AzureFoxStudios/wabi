import { writable, type Readable } from 'svelte/store';
import { connected } from '$lib/socket-manager';
import {
	leaveWhiteboard,
	rejoinWhiteboardBoard,
	saveWhiteboardSnapshot,
	sendWhiteboardPatch,
	subscribeWhiteboardEvents
} from '$lib/whiteboard/boardSocket';
import type { WhiteboardDocument } from '$lib/whiteboard/boardTypes';
import {
	cadReviewAssetKey,
	cadReviewBoardId,
	cloneCadReviewElement,
	cloneCadReviewElements,
	normalizeCadReviewElements,
	type CadReviewElement
} from '$lib/cadReview';

export type CadReviewSyncStatus = 'local' | 'connecting' | 'shared' | 'offline' | 'error';

export interface CadReviewSyncState {
	elements: CadReviewElement[];
	status: CadReviewSyncStatus;
	boardId: string | null;
	error: string | null;
}

export interface CadReviewSession extends Readable<CadReviewSyncState> {
	add(element: CadReviewElement): void;
	remove(ids: string[]): void;
	replaceLocal(elements: CadReviewElement[]): void;
	destroy(): void;
}

type LocalOp =
	| { seq: number; op: 'create'; element: CadReviewElement }
	| { seq: number; op: 'delete'; ids: string[] };

const SAVE_DEBOUNCE_MS = 650;

function applyOp(elements: CadReviewElement[], op: LocalOp): CadReviewElement[] {
	if (op.op === 'create') {
		const withoutDuplicate = elements.filter((element) => element.id !== op.element.id);
		return [...withoutDuplicate, cloneCadReviewElement(op.element)];
	}
	const ids = new Set(op.ids);
	return elements.filter((element) => !ids.has(element.id));
}

function applyRemotePatch(elements: CadReviewElement[], patch: any): CadReviewElement[] {
	if (!patch || typeof patch !== 'object') return elements;
	if (patch.op === 'create') {
		const normalized = normalizeCadReviewElements([patch.element]);
		if (normalized.length !== 1) return elements;
		return applyOp(elements, { seq: 0, op: 'create', element: normalized[0] });
	}
	if (patch.op === 'delete' && Array.isArray(patch.ids)) {
		const ids = patch.ids.filter((id: unknown): id is string => typeof id === 'string');
		return applyOp(elements, { seq: 0, op: 'delete', ids });
	}
	return elements;
}

function documentForReview(base: WhiteboardDocument | null, boardId: string, version: number, elements: CadReviewElement[]): WhiteboardDocument {
	return {
		...(base || {}),
		boardId,
		version,
		updatedAt: Date.now(),
		elements: cloneCadReviewElements(elements),
		layers: [],
		activeLayerId: 'cad-review',
		viewport: { x: 0, y: 0, zoom: 1 },
		canvasBgColor: 'transparent',
		policy: base?.policy || { access: 'open', writeAccess: 'anyone' },
		meta: base?.meta || { updatedAt: Date.now(), updatedBy: 0 },
		documentKind: 'cad-review-v1'
	};
}

function createLocalSession(src: string, fileName: string): CadReviewSession {
	const key = `wabi:cad-review:${cadReviewAssetKey(src, fileName)}`;
	let elements: CadReviewElement[] = [];
	if (typeof localStorage !== 'undefined') {
		try { elements = normalizeCadReviewElements(JSON.parse(localStorage.getItem(key) || '[]')); } catch { elements = []; }
	}
	const store = writable<CadReviewSyncState>({ elements, status: 'local', boardId: null, error: null });
	const persist = () => {
		if (typeof localStorage === 'undefined') return;
		try { localStorage.setItem(key, JSON.stringify(elements)); } catch { /* Review still works for this session. */ }
	};
	const publish = () => store.set({ elements: cloneCadReviewElements(elements), status: 'local', boardId: null, error: null });
	return {
		subscribe: store.subscribe,
		add(element) { elements = applyOp(elements, { seq: 0, op: 'create', element }); persist(); publish(); },
		remove(ids) { elements = applyOp(elements, { seq: 0, op: 'delete', ids }); persist(); publish(); },
		replaceLocal(next) { elements = cloneCadReviewElements(next); persist(); publish(); },
		destroy() {}
	};
}

export function createCadReviewSession(options: { channelId?: string | null; src: string; fileName: string }): CadReviewSession {
	const boardId = options.channelId ? cadReviewBoardId(options.channelId, options.src, options.fileName) : null;
	if (!boardId) return createLocalSession(options.src, options.fileName);

	let elements: CadReviewElement[] = [];
	let baseDocument: WhiteboardDocument | null = null;
	let version = 0;
	let joined = false;
	let destroyed = false;
	let sequence = 0;
	let pending: LocalOp[] = [];
	let saveThroughSeq: number | null = null;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let stateStatus: CadReviewSyncStatus = 'connecting';
	let stateError: string | null = null;
	const store = writable<CadReviewSyncState>({ elements: [], status: stateStatus, boardId, error: null });

	const publish = () => store.set({ elements: cloneCadReviewElements(elements), status: stateStatus, boardId, error: stateError });
	const reapplyPending = (base: CadReviewElement[]) => pending.reduce((current, op) => applyOp(current, op), base);

	function scheduleSave(): void {
		if (!joined || destroyed || pending.length === 0 || saveThroughSeq !== null) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			flushSave();
		}, SAVE_DEBOUNCE_MS);
	}

	function flushSave(): void {
		if (!joined || destroyed || pending.length === 0 || saveThroughSeq !== null) return;
		saveThroughSeq = pending[pending.length - 1].seq;
		saveWhiteboardSnapshot(boardId, documentForReview(baseDocument, boardId, version, elements));
	}

	const unsubscribeEvents = subscribeWhiteboardEvents({
		onJoined(payload) {
			if (payload.boardId !== boardId || destroyed) return;
			baseDocument = payload.document;
			version = Number.isFinite(payload.document?.version) ? payload.document.version : 0;
			elements = reapplyPending(normalizeCadReviewElements(payload.document?.elements));
			joined = true;
			stateStatus = 'shared';
			stateError = null;
			publish();
			scheduleSave();
		},
		onSnapshot(payload) {
			if (payload.boardId !== boardId || destroyed) return;
			baseDocument = payload.document;
			version = Number.isFinite(payload.document?.version) ? payload.document.version : version;
			elements = reapplyPending(normalizeCadReviewElements(payload.document?.elements));
			stateStatus = 'shared';
			stateError = null;
			publish();
		},
		onPatch(payload) {
			if (payload.boardId !== boardId || destroyed) return;
			elements = applyRemotePatch(elements, payload.patch);
			publish();
		},
		onAck(payload) {
			if (destroyed || payload.boardId !== boardId || saveThroughSeq === null) return;
			if ((payload as unknown as { patchId?: string | null }).patchId != null) return;
			version = payload.version;
			pending = pending.filter((op) => op.seq > (saveThroughSeq as number));
			saveThroughSeq = null;
			stateStatus = 'shared';
			stateError = null;
			publish();
			scheduleSave();
		},
		onError(payload) {
			if (destroyed) return;
			if (payload.boardId && payload.boardId !== boardId) return;
			if (payload.code === 'VERSION_CONFLICT') {
				saveThroughSeq = null;
				joined = false;
				stateStatus = 'connecting';
				stateError = null;
				publish();
				rejoinWhiteboardBoard(boardId);
				return;
			}
			stateStatus = 'error';
			stateError = payload.message || 'CAD review sync failed.';
			publish();
		},
		onDisconnect() {
			if (destroyed) return;
			joined = false;
			saveThroughSeq = null;
			stateStatus = 'offline';
			stateError = null;
			publish();
		}
	});

	const unsubscribeConnected = connected.subscribe((isConnected) => {
		if (destroyed || !isConnected) return;
		joined = false;
		stateStatus = 'connecting';
		publish();
		rejoinWhiteboardBoard(boardId);
	});

	// connected.subscribe emits immediately. If socket state is not ready yet,
	// reconnect handling above will perform the join when it becomes ready.
	rejoinWhiteboardBoard(boardId);

	function add(element: CadReviewElement): void {
		const op: LocalOp = { seq: ++sequence, op: 'create', element: cloneCadReviewElement(element) };
		pending.push(op);
		elements = applyOp(elements, op);
		publish();
		if (joined) sendWhiteboardPatch(boardId, { op: 'create', element: cloneCadReviewElement(element) });
		scheduleSave();
	}

	function remove(ids: string[]): void {
		const safeIds = [...new Set(ids.filter(Boolean))];
		if (safeIds.length === 0) return;
		const op: LocalOp = { seq: ++sequence, op: 'delete', ids: safeIds };
		pending.push(op);
		elements = applyOp(elements, op);
		publish();
		if (joined) sendWhiteboardPatch(boardId, { op: 'delete', ids: safeIds });
		scheduleSave();
	}

	return {
		subscribe: store.subscribe,
		add,
		remove,
		replaceLocal(next) {
			const ids = elements.map((element) => element.id);
			if (ids.length) remove(ids);
			for (const element of next) add(element);
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			if (saveTimer) clearTimeout(saveTimer);
			if (joined && pending.length > 0 && saveThroughSeq === null) flushSave();
			unsubscribeEvents();
			unsubscribeConnected();
			leaveWhiteboard(boardId);
		}
	};
}
