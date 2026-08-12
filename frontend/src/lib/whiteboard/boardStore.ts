import { writable, readable, get } from 'svelte/store';
import {
	DEFAULT_WHITEBOARD_POLICY,
	type WhiteboardDocument,
	type WhiteboardLayer,
	type WhiteboardMeta,
	type WhiteboardPolicy,
	type WhiteboardViewport
} from './boardTypes';
import type { BoardElement } from './elementTypes';
import { DEFAULT_STYLE, fromTransportElement, toTransportElement } from './elementTypes';
import {
	cloneWhiteboardLayers,
	createDefaultWhiteboardLayer,
	normalizeWhiteboardLayers,
	resolveWhiteboardLayerId
} from './layers';
import {
	cloneElements,
	buildBoardStateFromDocument,
	normalizeElements,
	pushUndo,
	type UndoEntry,
	type BoardDocument
} from './boardUndo';
import * as elemOps from './boardElements';
import * as layerOps from './boardLayerOps';
import * as selOps from './boardSelection';
import * as vpOps from './boardViewport';
import type { WhiteboardViewport as VpType } from './boardViewport';

export type ToolType = 'select' | 'pen' | 'line' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'eraser' | 'pan';

export interface BoardStyle {
	strokeColor: string;
	strokeWidth: number;
	fillColor: string;
	opacity: number;
	hardness: number;
	fontSize: number;
	strokeDash?: number[];
	borderRadius?: number;
}

export interface BoardState {
	boardId: string;
	version: number;
	policy: WhiteboardPolicy;
	meta: WhiteboardMeta;
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	viewport: WhiteboardViewport;
	activeTool: ToolType;
	activeLayerId: string;
	style: BoardStyle;
	selection: Set<string>;
	undoStack: UndoEntry[];
	redoStack: UndoEntry[];
	isDirty: boolean;
	canvasBgColor?: string;
}

export type { BoardDocument } from './boardUndo';

function defaultState(): BoardState {
	const now = Date.now();
	const layer = createDefaultWhiteboardLayer(now);
	return {
		boardId: '',
		version: 0,
		policy: { ...DEFAULT_WHITEBOARD_POLICY },
		meta: { updatedAt: 0, updatedBy: 0 },
		elements: [],
		layers: [layer],
		viewport: { x: 0, y: 0, zoom: 1 },
		activeTool: 'pen',
		activeLayerId: layer.id,
		style: { ...DEFAULT_STYLE },
		selection: new Set(),
		undoStack: [],
		redoStack: [],
		isDirty: false
	};
}

const _boards = new Map<string, ReturnType<typeof writable<BoardState>>>();
let _activeBoardId = '';
const activeBoardStore = writable<ReturnType<typeof writable<BoardState>>>(getStore(_activeBoardId));

function getStore(id: string): ReturnType<typeof writable<BoardState>> {
	if (!_boards.has(id)) {
		_boards.set(id, writable<BoardState>({ ...defaultState(), boardId: id }));
	}
	return _boards.get(id)!;
}

function activeStore(): ReturnType<typeof writable<BoardState>> {
	return get(activeBoardStore);
}

function subscribeActiveStore(run: (value: BoardState) => void): () => void {
	let innerUnsub = activeStore().subscribe(run);
	const outerUnsub = activeBoardStore.subscribe((store) => {
		innerUnsub();
		innerUnsub = store.subscribe(run);
	});
	return () => {
		innerUnsub();
		outerUnsub();
	};
}

function deriveActiveStore<T>(selector: (state: BoardState) => T) {
	return readable(selector(get(activeStore())), (set) => subscribeActiveStore((state) => set(selector(state))));
}

type PatchType = 'create' | 'update' | 'delete' | 'reorder' | 'replace' | 'layer:create' | 'layer:update' | 'layer:delete' | 'layer:reorder' | 'layer:select';
type PatchListener = (type: PatchType, payload: unknown) => void;
const _patchListeners = new Map<string, PatchListener>();

export function setPatchListener(fn: PatchListener | null): void {
	if (_activeBoardId) {
		if (fn) _patchListeners.set(_activeBoardId, fn);
		else _patchListeners.delete(_activeBoardId);
	}
}

function notifyPatch(type: PatchType, payload: unknown): void {
	if (type === 'replace' || type.startsWith('layer:')) {
		bumpVersion();
	}
	const listener = _patchListeners.get(_activeBoardId);
	if (listener) listener(type, payload);
}

function toState(s: BoardState): elemOps.BoardState & layerOps.BoardState & selOps.BoardState & vpOps.BoardState {
	return s as elemOps.BoardState & layerOps.BoardState & selOps.BoardState & vpOps.BoardState;
}

function fromState(s: BoardState, partial: Partial<BoardState>): BoardState {
	return { ...s, ...partial };
}

function loadDocument(doc: BoardDocument): void {
	const state = buildBoardStateFromDocument({
		...doc,
		viewport: doc.viewport || { x: 0, y: 0, zoom: 1 }
	});
	activeStore().update((s) => ({ ...s, ...state, viewport: state.viewport || { x: 0, y: 0, zoom: 1 } } as BoardState));
}

function setDocument(doc: WhiteboardDocument): void {
	activeStore().update((s) => {
		const layers = normalizeWhiteboardLayers(doc.layers || [], [createDefaultWhiteboardLayer()]);
		const activeLayerId = resolveWhiteboardLayerId(layers, typeof doc.activeLayerId === 'string' ? doc.activeLayerId : layers[0]?.id || '');
		const elements = normalizeElements((doc.elements || []).map(fromTransportElement), layers);
		return {
			...s,
			boardId: doc.boardId || s.boardId,
			version: typeof doc.version === 'number' ? doc.version : 0,
			policy: doc.policy ? { ...doc.policy } : { ...DEFAULT_WHITEBOARD_POLICY },
			meta: doc.meta ? { ...doc.meta } : { updatedAt: 0, updatedBy: 0 },
			elements,
			layers,
			activeLayerId,
			viewport: {
				x: Number.isFinite(doc.viewport?.x) ? doc.viewport!.x : 0,
				y: Number.isFinite(doc.viewport?.y) ? doc.viewport!.y : 0,
				zoom: Number.isFinite(doc.viewport?.zoom) ? doc.viewport!.zoom : 1
			},
			selection: new Set<string>(),
			undoStack: [],
			redoStack: [],
			isDirty: false
		};
	});
}

function reset(): void {
	activeStore().set(defaultState());
}

function setBoardId(id: string): void {
	_activeBoardId = id;
	activeBoardStore.set(getStore(id));
	activeStore().update((s) => ({
		...s,
		boardId: id,
		layers: s.layers.length > 0 ? s.layers : [createDefaultWhiteboardLayer()],
		activeLayerId: resolveWhiteboardLayerId(s.layers.length > 0 ? s.layers : [createDefaultWhiteboardLayer()], s.activeLayerId)
	}));
}

function setTool(tool: ToolType): void {
	activeStore().update((s) => ({ ...s, activeTool: tool }));
}

function setStyle(partial: Partial<BoardStyle>): void {
	activeStore().update((s) => ({ ...s, style: { ...s.style, ...partial } }));
}

export function setCanvasBgColor(color: string | undefined): void {
	activeStore().update((s) => ({ ...s, canvasBgColor: color }));
}

function setWhiteboardPolicy(policy: WhiteboardPolicy): void {
	activeStore().update((s) => ({ ...s, policy: { ...policy }, isDirty: true }));
	bumpVersion();
}

function pushHistoryCheckpoint(): void {
	activeStore().update((s) => ({ ...s, undoStack: pushUndo(s.elements, s.layers, s.activeLayerId, s.undoStack), redoStack: [] }));
}

function addElement(el: BoardElement): void {
	activeStore().update((s) => fromState(s, elemOps.addElement(toState(s), el, notifyPatch)));
	bumpVersion();
}

function updateElement(id: string, partial: Partial<BoardElement>, options: elemOps.UpdateElementOptions = {}): void {
	activeStore().update((s) => fromState(s, elemOps.updateElement(toState(s), id, partial, options, notifyPatch)));
	bumpVersion();
}

function deleteElements(ids: string[]): void {
	activeStore().update((s) => fromState(s, elemOps.deleteElements(toState(s), ids, notifyPatch)));
	bumpVersion();
}

function reorderElement(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
	activeStore().update((s) => fromState(s, elemOps.reorderElement(toState(s), id, dir, notifyPatch)));
	bumpVersion();
}

function duplicateElements(ids: string[]): void {
	activeStore().update((s) => fromState(s, elemOps.duplicateElements(toState(s), ids, notifyPatch)));
	bumpVersion();
}

function addElementSilent(el: BoardElement): void {
	activeStore().update((s) => fromState(s, elemOps.addElementSilent(toState(s), el)));
}

function updateElementSilent(id: string, partial: Partial<BoardElement>): void {
	activeStore().update((s) => fromState(s, elemOps.updateElementSilent(toState(s), id, partial)));
}

function deleteElementsSilent(ids: string[]): void {
	activeStore().update((s) => fromState(s, elemOps.deleteElementsSilent(toState(s), ids)));
}

function ensureLayer(layer: Partial<WhiteboardLayer> & { id?: string; name?: string }): WhiteboardLayer {
	let created: WhiteboardLayer | null = null;
	activeStore().update((s) => {
		const result = layerOps.ensureLayer(toState(s), layer, notifyPatch);
		created = result.created;
		return fromState(s, result.state);
	});
	return created || createDefaultWhiteboardLayer();
}

function ensureLayerSilent(layer: Partial<WhiteboardLayer> & { id?: string; name?: string }): WhiteboardLayer {
	let created: WhiteboardLayer | null = null;
	activeStore().update((s) => {
		const result = layerOps.ensureLayer(toState(s), layer, null);
		created = result.created;
		return fromState(s, result.state);
	});
	return created || createDefaultWhiteboardLayer();
}

function addLayer(partial: Partial<WhiteboardLayer>): WhiteboardLayer {
	let created: WhiteboardLayer | null = null;
	activeStore().update((s) => {
		const result = layerOps.addLayer(toState(s), partial, notifyPatch);
		created = result.created;
		return fromState(s, result.state);
	});
	return created || createDefaultWhiteboardLayer();
}

function updateLayer(id: string, partial: Partial<WhiteboardLayer>): void {
	activeStore().update((s) => fromState(s, layerOps.updateLayer(toState(s), id, partial, notifyPatch)));
}

function updateLayerSilent(id: string, partial: Partial<WhiteboardLayer>): void {
	activeStore().update((s) => fromState(s, layerOps.updateLayerSilent(toState(s), id, partial)));
}

function deleteLayer(id: string): void {
	activeStore().update((s) => fromState(s, layerOps.deleteLayer(toState(s), id, notifyPatch)));
}

function deleteLayerSilent(id: string): void {
	activeStore().update((s) => fromState(s, layerOps.deleteLayerSilent(toState(s), id)));
}

function reorderLayer(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
	activeStore().update((s) => fromState(s, layerOps.reorderLayer(toState(s), id, dir, notifyPatch)));
}

function reorderLayerSilent(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
	activeStore().update((s) => fromState(s, layerOps.reorderLayerSilent(toState(s), id, dir)));
}

function setActiveLayerId(id: string): void {
	activeStore().update((s) => fromState(s, layerOps.setActiveLayerId(toState(s), id, notifyPatch)));
}

function setActiveLayerIdSilent(id: string): void {
	activeStore().update((s) => fromState(s, layerOps.setActiveLayerIdSilent(toState(s), id)));
}

function setLayerVisible(id: string, visible: boolean): void {
	updateLayer(id, { visible });
}

function setLayerLocked(id: string, locked: boolean): void {
	updateLayer(id, { locked });
}

function setLayerOpacity(id: string, opacity: number): void {
	updateLayer(id, { opacity: Math.max(0, Math.min(1, opacity)) });
}

function renameLayer(id: string, name: string): void {
	updateLayer(id, { name: name.trim() || 'Layer' });
}

function assignSelectionToLayer(layerId: string): void {
	activeStore().update((s) => fromState(s, layerOps.assignSelectionToLayer(toState(s), layerId, notifyPatch)));
}

function select(ids: string[]): void {
	activeStore().update((s) => fromState(s, selOps.select(toState(s), ids)));
}

function selectAll(): void {
	activeStore().update((s) => fromState(s, selOps.selectAll(toState(s))));
}

function clearSelection(): void {
	activeStore().update((s) => fromState(s, selOps.clearSelection(toState(s))));
}

function toggleSelection(id: string): void {
	activeStore().update((s) => fromState(s, selOps.toggleSelection(toState(s), id)));
}

function setViewport(vp: VpType): void {
	activeStore().update((s) => fromState(s, vpOps.setViewport(toState(s), vp)));
}

function panBy(dx: number, dy: number): void {
	activeStore().update((s) => fromState(s, vpOps.panBy(toState(s), dx, dy)));
}

function zoomTo(zoom: number, cx: number, cy: number): void {
	activeStore().update((s) => fromState(s, vpOps.zoomTo(toState(s), zoom, cx, cy)));
}

function undo(): void {
	activeStore().update((s) => {
		if (s.undoStack.length === 0) return s;
		const stack = [...s.undoStack];
		const entry = stack.pop()!;
		const redoEntry: UndoEntry = {
			elements: cloneElements(s.elements),
			layers: cloneWhiteboardLayers(s.layers),
			activeLayerId: s.activeLayerId,
			estimatedBytes: 0
		};
		notifyPatch('replace', { document: null });
		return { ...s, elements: entry.elements, layers: entry.layers, activeLayerId: entry.activeLayerId, undoStack: stack, redoStack: [...s.redoStack, redoEntry], isDirty: true };
	});
}

function redo(): void {
	activeStore().update((s) => {
		if (s.redoStack.length === 0) return s;
		const stack = [...s.redoStack];
		const entry = stack.pop()!;
		const undoEntry: UndoEntry = {
			elements: cloneElements(s.elements),
			layers: cloneWhiteboardLayers(s.layers),
			activeLayerId: s.activeLayerId,
			estimatedBytes: 0
		};
		notifyPatch('replace', { document: null });
		return { ...s, elements: entry.elements, layers: entry.layers, activeLayerId: entry.activeLayerId, undoStack: [...s.undoStack, undoEntry], redoStack: stack, isDirty: true };
	});
}

function getDocument(): BoardDocument {
	const s = get(activeStore());
	return {
		boardId: s.boardId,
		version: s.version,
		elements: cloneElements(s.elements),
		layers: cloneWhiteboardLayers(s.layers),
		activeLayerId: s.activeLayerId,
		viewport: { ...s.viewport }
	};
}

function getSnapshotDocument(): WhiteboardDocument {
	const s = get(activeStore());
	return {
		boardId: s.boardId,
		version: s.version,
		updatedAt: s.meta.updatedAt || Date.now(),
		elements: s.elements.map(toTransportElement),
		layers: cloneWhiteboardLayers(s.layers),
		activeLayerId: s.activeLayerId,
		viewport: { ...s.viewport },
		policy: { ...s.policy },
		meta: { ...s.meta }
	};
}

function markClean(): void {
	activeStore().update((s) => ({ ...s, isDirty: false }));
}

function bumpVersion(): void {
	activeStore().update((s) => ({ ...s, version: s.version + 1 }));
}

function setVersion(version: number): void {
	activeStore().update((s) => ({ ...s, version }));
}

export const elements = deriveActiveStore((s) => s.elements);
export const layers = deriveActiveStore((s) => s.layers);
export const viewport = deriveActiveStore((s) => s.viewport);
export const activeTool = deriveActiveStore((s) => s.activeTool);
export const activeLayerId = deriveActiveStore((s) => s.activeLayerId);
export const selection = deriveActiveStore((s) => s.selection);
export const currentStyle = deriveActiveStore((s) => s.style);
export const isDirty = deriveActiveStore((s) => s.isDirty);
export const policy = deriveActiveStore((s) => s.policy);
export const meta = deriveActiveStore((s) => s.meta);
export const canUndo = deriveActiveStore((s) => s.undoStack.length > 0);
export const canRedo = deriveActiveStore((s) => s.redoStack.length > 0);
export const boardState = deriveActiveStore((s) => s);

export const boardStore = {
	subscribe: subscribeActiveStore,
	loadDocument,
	setDocument,
	reset,
	setBoardId,
	setTool,
	setStyle,
	setWhiteboardPolicy,
	pushHistoryCheckpoint,
	addElement,
	updateElement,
	deleteElements,
	reorderElement,
	duplicateElements,
	addElementSilent,
	updateElementSilent,
	deleteElementsSilent,
	ensureLayer,
	ensureLayerSilent,
	addLayer,
	updateLayer,
	updateLayerSilent,
	deleteLayer,
	deleteLayerSilent,
	reorderLayer,
	reorderLayerSilent,
	setActiveLayerId,
	setActiveLayerIdSilent,
	setLayerVisible,
	setLayerLocked,
	setLayerOpacity,
	renameLayer,
	assignSelectionToLayer,
	select,
	selectAll,
	clearSelection,
	toggleSelection,
	setViewport,
	panBy,
	zoomTo,
	undo,
	redo,
	getDocument,
	getSnapshotDocument,
	markClean,
	bumpVersion,
	setVersion
};
