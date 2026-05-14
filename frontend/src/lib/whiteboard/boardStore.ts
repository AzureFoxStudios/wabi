import { writable, readable, get } from 'svelte/store';
import type { WhiteboardLayer, WhiteboardViewport } from './boardTypes';
import type { BoardElement } from './elementTypes';
import { DEFAULT_STYLE, generateElementId } from './elementTypes';
import {
	cloneWhiteboardLayer,
	cloneWhiteboardLayers,
	createDefaultWhiteboardLayer,
	createLayerId,
	DEFAULT_WHITEBOARD_LAYER_ID,
	normalizeWhiteboardLayer,
	normalizeWhiteboardLayers,
	resolveWhiteboardLayerId,
	resolveWritableWhiteboardLayerId,
	sortWhiteboardLayers
} from './layers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolType = 'select' | 'pen' | 'line' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'pan';

export interface BoardStyle {
	strokeColor: string;
	strokeWidth: number;
	fillColor: string;
}

interface UndoEntry {
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	activeLayerId: string;
	estimatedBytes: number;
}

export interface BoardState {
	boardId: string;
	version: number;
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
}

export interface BoardDocument {
	boardId: string;
	version: number;
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	activeLayerId: string;
	viewport: WhiteboardViewport;
}

interface UpdateElementOptions {
	recordHistory?: boolean;
	emitPatch?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_UNDO = 50;
const MAX_UNDO_BYTES = 4 * 1024 * 1024; // ~4MB ceiling

function cloneElement(el: BoardElement): BoardElement {
	if (el.type === 'stroke') {
		return {
			...el,
			points: el.points.map((point) => ({ ...point }))
		};
	}
	return { ...el };
}

function cloneElements(elements: BoardElement[]): BoardElement[] {
	return elements.map(cloneElement);
}

function cloneLayers(layers: WhiteboardLayer[]): WhiteboardLayer[] {
	return cloneWhiteboardLayers(layers);
}

function estimateBytes(elements: BoardElement[]): number {
	// Rough estimate: 200 bytes per element + points for strokes
	let bytes = 0;
	for (const el of elements) {
		bytes += 200;
		if (el.type === 'stroke') bytes += el.points.length * 24;
	}
	return bytes;
}

function estimateLayerBytes(layers: WhiteboardLayer[]): number {
	return layers.length * 128;
}

function defaultState(): BoardState {
	const now = Date.now();
	const layer = createDefaultWhiteboardLayer(now);
	return {
		boardId: '',
		version: 0,
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

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

// Patch listener: external code (boardSync) can subscribe to know when local
// mutations happen so it can emit patches. We don't import boardSync here to
// avoid circular deps.
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
	const listener = _patchListeners.get(_activeBoardId);
	if (listener) listener(type, payload);
}

// ---------------------------------------------------------------------------
// Undo helpers
// ---------------------------------------------------------------------------

function pushUndo(state: BoardState): BoardState {
	const entry: UndoEntry = {
		elements: cloneElements(state.elements),
		layers: cloneLayers(state.layers),
		activeLayerId: state.activeLayerId,
		estimatedBytes: estimateBytes(state.elements) + estimateLayerBytes(state.layers)
	};
	let stack = [...state.undoStack, entry];
	// Trim by count
	while (stack.length > MAX_UNDO) stack.shift();
	// Trim by size
	let total = 0;
	for (let i = stack.length - 1; i >= 0; i--) total += stack[i].estimatedBytes;
	while (total > MAX_UNDO_BYTES && stack.length > 1) {
		total -= stack[0].estimatedBytes;
		stack.shift();
	}
	return { ...state, undoStack: stack, redoStack: [] };
}

function normalizeElementLayerId(element: BoardElement, layers: WhiteboardLayer[]): BoardElement {
	const layerId = resolveWhiteboardLayerId(layers, element.layerId);
	return element.layerId === layerId ? element : ({ ...element, layerId } as BoardElement);
}

function normalizeElements(elements: BoardElement[], layers: WhiteboardLayer[]): BoardElement[] {
	return elements.map((element) => normalizeElementLayerId(cloneElement(element), layers));
}

function buildBoardStateFromDocument(doc: BoardDocument): Partial<BoardState> {
	const layers = normalizeWhiteboardLayers(doc.layers || [], [createDefaultWhiteboardLayer()]);
	const activeLayerId = resolveWhiteboardLayerId(layers, doc.activeLayerId || layers[0]?.id || DEFAULT_WHITEBOARD_LAYER_ID);
	const elements = normalizeElements(doc.elements || [], layers);
	return {
		boardId: doc.boardId,
		version: doc.version,
		elements,
		layers,
		activeLayerId,
		viewport: { ...doc.viewport },
		selection: new Set(),
		undoStack: [],
		redoStack: [],
		isDirty: false
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function loadDocument(doc: BoardDocument): void {
	const state = buildBoardStateFromDocument({
		...doc,
		viewport: doc.viewport || { x: 0, y: 0, zoom: 1 }
	});
	activeStore().update((s) => ({
		...s,
		...state,
		viewport: state.viewport || { x: 0, y: 0, zoom: 1 }
	} as BoardState));
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

function pushHistoryCheckpoint(): void {
	activeStore().update((s) => pushUndo(s));
}

// --- Element mutations (with undo + dirty + patch) ---

function addElement(el: BoardElement): void {
	let committed: BoardElement | null = null;
	activeStore().update((s) => {
		const next = pushUndo(s);
		const targetLayerId = resolveWritableWhiteboardLayerId(next.layers, el.layerId || next.activeLayerId);
		committed = normalizeElementLayerId({ ...el, layerId: targetLayerId } as BoardElement, next.layers);
		next.elements = [...next.elements, committed];
		next.isDirty = true;
		return next;
	});
	if (committed) {
		notifyPatch('create', committed);
	}
}

function updateElement(
	id: string,
	partial: Partial<BoardElement>,
	options: UpdateElementOptions = {}
): void {
	const { recordHistory = true, emitPatch = true } = options;
	activeStore().update((s) => {
		const idx = s.elements.findIndex((e) => e.id === id);
		if (idx === -1) return s;
		const next = recordHistory ? pushUndo(s) : { ...s, elements: [...s.elements] };
		const layerId = partial.layerId ? resolveWhiteboardLayerId(next.layers, partial.layerId) : next.elements[idx].layerId;
		const updated = {
			...next.elements[idx],
			...partial,
			layerId,
			updatedAt: Date.now()
		} as BoardElement;
		next.elements[idx] = updated;
		next.isDirty = true;
		return next;
	});
	if (emitPatch) {
		notifyPatch('update', { id, changes: partial });
	}
}

function deleteElements(ids: string[]): void {
	if (ids.length === 0) return;
	activeStore().update((s) => {
		const next = pushUndo(s);
		const idSet = new Set(ids);
		next.elements = next.elements.filter((e) => !idSet.has(e.id));
		next.selection = new Set([...next.selection].filter((id) => !idSet.has(id)));
		next.isDirty = true;
		return next;
	});
	notifyPatch('delete', { ids });
}

function reorderElement(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
	activeStore().update((s) => {
		const next = pushUndo(s);
		const sorted = [...next.elements].sort((a, b) => a.zIndex - b.zIndex);
		const idx = sorted.findIndex((e) => e.id === id);
		if (idx === -1) return s;

		if (dir === 'front') {
			const maxZ = sorted.length > 0 ? sorted[sorted.length - 1].zIndex + 1 : 1;
			sorted[idx] = { ...sorted[idx], zIndex: maxZ } as BoardElement;
		} else if (dir === 'back') {
			const minZ = sorted.length > 0 ? sorted[0].zIndex - 1 : 0;
			sorted[idx] = { ...sorted[idx], zIndex: minZ } as BoardElement;
		} else if (dir === 'forward' && idx < sorted.length - 1) {
			const above = sorted[idx + 1].zIndex;
			sorted[idx] = { ...sorted[idx], zIndex: above + 1 } as BoardElement;
		} else if (dir === 'backward' && idx > 0) {
			const below = sorted[idx - 1].zIndex;
			sorted[idx] = { ...sorted[idx], zIndex: below - 1 } as BoardElement;
		}

		next.elements = sorted;
		next.isDirty = true;
		return next;
	});
	notifyPatch('reorder', { id, dir });
}

function duplicateElements(ids: string[]): void {
	activeStore().update((s) => {
		const next = pushUndo(s);
		const newEls: BoardElement[] = [];
		let offset = 1;
		for (const id of ids) {
			const src = next.elements.find((e) => e.id === id);
			if (!src) continue;
			const maxZ = next.elements
				.filter((element) => element.layerId === src.layerId)
				.reduce((m, e) => Math.max(m, e.zIndex), 0);
			const baseDup = {
				...src,
				id: generateElementId(),
				x: src.x + 20,
				y: src.y + 20,
				zIndex: maxZ + offset,
				layerId: resolveWhiteboardLayerId(next.layers, src.layerId),
				updatedAt: Date.now()
			};
			const dup =
				src.type === 'stroke'
					? ({
							...baseDup,
							points: src.points.map((point) => ({
								...point,
								x: point.x + 20,
								y: point.y + 20
							}))
						} as BoardElement)
					: (baseDup as BoardElement);
			newEls.push(dup);
			offset++;
		}
		next.elements = [...next.elements, ...newEls];
		next.selection = new Set(newEls.map((e) => e.id));
		next.isDirty = true;
		return next;
	});
	// Notify for each duplicated element
	const s = get(activeStore());
	for (const id of [...s.selection]) {
		const el = s.elements.find((e) => e.id === id);
		if (el) notifyPatch('create', el);
	}
}

// --- Silent mutations (for remote patches — no undo, no dirty, no patch) ---

function addElementSilent(el: BoardElement): void {
	activeStore().update((s) => {
		if (s.elements.some((existing) => existing.id === el.id)) {
			return s;
		}
		const normalized = normalizeElementLayerId(cloneElement(el), s.layers);
		return { ...s, elements: [...s.elements, normalized] };
	});
}

function updateElementSilent(id: string, partial: Partial<BoardElement>): void {
	activeStore().update((s) => {
		const idx = s.elements.findIndex((e) => e.id === id);
		if (idx === -1) return s;
		const els = [...s.elements];
		els[idx] = {
			...els[idx],
			...partial,
			layerId: partial.layerId ? resolveWhiteboardLayerId(s.layers, partial.layerId) : els[idx].layerId
		} as BoardElement;
		return { ...s, elements: els };
	});
}

function deleteElementsSilent(ids: string[]): void {
	const idSet = new Set(ids);
	activeStore().update((s) => ({
		...s,
		elements: s.elements.filter((e) => !idSet.has(e.id)),
		selection: new Set([...s.selection].filter((id) => !idSet.has(id)))
	}));
}

// --- Layer mutations ---

function ensureLayer(layer: Partial<WhiteboardLayer> & { id?: string; name?: string }): WhiteboardLayer {
	let created: WhiteboardLayer | null = null;
	activeStore().update((s) => {
		const existing = layer.id ? s.layers.find((candidate) => candidate.id === layer.id) : null;
		if (existing) {
			created = existing;
			return s;
		}

		const now = Date.now();
		const normalized = normalizeWhiteboardLayer(
			{
				id: layer.id || createLayerId(layer.name || 'Layer'),
				name: layer.name || 'Layer',
				kind: layer.kind || 'content',
				visible: layer.visible ?? true,
				locked: layer.locked ?? false,
				opacity: layer.opacity ?? 1,
				order: layer.order ?? s.layers.length,
				createdAt: layer.createdAt || now,
				updatedAt: layer.updatedAt || now
			},
			s.layers.length,
			now
		);
		if (!normalized) {
			created = createDefaultWhiteboardLayer(now);
			return s;
		}
		const nextLayers = sortWhiteboardLayers([...s.layers, normalized]);
		created = normalized;
		return {
			...s,
			layers: nextLayers,
			activeLayerId: resolveWhiteboardLayerId(nextLayers, s.activeLayerId)
		};
	});
	return created || createDefaultWhiteboardLayer();
}

function ensureLayerSilent(layer: Partial<WhiteboardLayer> & { id?: string; name?: string }): WhiteboardLayer {
	let created: WhiteboardLayer | null = null;
	activeStore().update((s) => {
		const existing = layer.id ? s.layers.find((candidate) => candidate.id === layer.id) : null;
		if (existing) {
			created = existing;
			return s;
		}

		const now = Date.now();
		const normalized = normalizeWhiteboardLayer(
			{
				id: layer.id || createLayerId(layer.name || 'Layer'),
				name: layer.name || 'Layer',
				kind: layer.kind || 'content',
				visible: layer.visible ?? true,
				locked: layer.locked ?? false,
				opacity: layer.opacity ?? 1,
				order: layer.order ?? s.layers.length,
				createdAt: layer.createdAt || now,
				updatedAt: layer.updatedAt || now
			},
			s.layers.length,
			now
		);
		if (!normalized) {
			created = createDefaultWhiteboardLayer(now);
			return s;
		}
		const nextLayers = sortWhiteboardLayers([...s.layers, normalized]);
		created = normalized;
		return {
			...s,
			layers: nextLayers,
			activeLayerId: resolveWhiteboardLayerId(nextLayers, s.activeLayerId)
		};
	});
	return created || createDefaultWhiteboardLayer();
}

function addLayer(partial: Partial<WhiteboardLayer>): WhiteboardLayer {
	const result = ensureLayer({
		...partial,
		id: partial.id || createLayerId(partial.name || 'Layer')
	});
	notifyPatch('layer:create', result);
	return result;
}

function updateLayer(id: string, partial: Partial<WhiteboardLayer>): void {
	activeStore().update((s) => {
		const idx = s.layers.findIndex((layer) => layer.id === id);
		if (idx === -1) return s;
		const next = pushUndo(s);
		const current = next.layers[idx];
		next.layers[idx] = normalizeWhiteboardLayer(
			{
				...current,
				...partial,
				id: current.id,
				updatedAt: Date.now()
			},
			idx
		) || current;
		next.layers = sortWhiteboardLayers(next.layers);
		next.activeLayerId = resolveWhiteboardLayerId(next.layers, next.activeLayerId);
		next.elements = next.elements.map((element) =>
			element.layerId === current.id ? { ...element, layerId: current.id } : element
		);
		next.isDirty = true;
		return next;
	});
	notifyPatch('layer:update', { id, changes: partial });
}

function updateLayerSilent(id: string, partial: Partial<WhiteboardLayer>): void {
	activeStore().update((s) => {
		const idx = s.layers.findIndex((layer) => layer.id === id);
		if (idx === -1) return s;
		const current = s.layers[idx];
		const nextLayers = [...s.layers];
		nextLayers[idx] = normalizeWhiteboardLayer(
			{
				...current,
				...partial,
				id: current.id,
				updatedAt: Date.now()
			},
			idx
		) || current;
		return {
			...s,
			layers: sortWhiteboardLayers(nextLayers),
			activeLayerId: resolveWhiteboardLayerId(nextLayers, s.activeLayerId),
			elements: s.elements.map((element) =>
				element.layerId === current.id ? { ...element, layerId: current.id } : element
			)
		};
	});
}

function deleteLayer(id: string): void {
	activeStore().update((s) => {
		if (s.layers.length <= 1) return s;
		const target = s.layers.find((layer) => layer.id === id);
		if (!target) return s;
		const next = pushUndo(s);
		const fallbackLayer = next.layers.find((layer) => layer.id !== id) || createDefaultWhiteboardLayer();
		next.layers = sortWhiteboardLayers(next.layers.filter((layer) => layer.id !== id));
		next.elements = next.elements.map((element) =>
			element.layerId === id ? { ...element, layerId: fallbackLayer.id } : element
		);
		next.activeLayerId = resolveWhiteboardLayerId(next.layers, next.activeLayerId);
		next.isDirty = true;
		return next;
	});
	notifyPatch('layer:delete', { id });
}

function deleteLayerSilent(id: string): void {
	activeStore().update((s) => {
		if (s.layers.length <= 1) return s;
		const target = s.layers.find((layer) => layer.id === id);
		if (!target) return s;
		const fallbackLayer = s.layers.find((layer) => layer.id !== id) || createDefaultWhiteboardLayer();
		const nextLayers = sortWhiteboardLayers(s.layers.filter((layer) => layer.id !== id));
		return {
			...s,
			layers: nextLayers,
			elements: s.elements.map((element) =>
				element.layerId === id ? { ...element, layerId: fallbackLayer.id } : element
			),
			activeLayerId: resolveWhiteboardLayerId(nextLayers, s.activeLayerId)
		};
	});
}

function reorderLayer(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
	activeStore().update((s) => {
		const idx = s.layers.findIndex((layer) => layer.id === id);
		if (idx === -1) return s;
		const next = pushUndo(s);
		const sorted = sortWhiteboardLayers(next.layers);
		const currentIndex = sorted.findIndex((layer) => layer.id === id);
		if (currentIndex === -1) return s;

		const targetIndex =
			dir === 'front'
				? sorted.length - 1
				: dir === 'back'
					? 0
					: dir === 'forward'
						? Math.min(sorted.length - 1, currentIndex + 1)
						: Math.max(0, currentIndex - 1);

		if (targetIndex === currentIndex) return s;
		const [layer] = sorted.splice(currentIndex, 1);
		sorted.splice(targetIndex, 0, layer);
		next.layers = sorted.map((candidate, order) => ({ ...candidate, order, updatedAt: Date.now() }));
		next.isDirty = true;
		return next;
	});
	notifyPatch('layer:reorder', { id, dir });
}

function reorderLayerSilent(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
	activeStore().update((s) => {
		const idx = s.layers.findIndex((layer) => layer.id === id);
		if (idx === -1) return s;
		const sorted = sortWhiteboardLayers(s.layers);
		const currentIndex = sorted.findIndex((layer) => layer.id === id);
		if (currentIndex === -1) return s;

		const targetIndex =
			dir === 'front'
				? sorted.length - 1
				: dir === 'back'
					? 0
					: dir === 'forward'
						? Math.min(sorted.length - 1, currentIndex + 1)
						: Math.max(0, currentIndex - 1);

		if (targetIndex === currentIndex) return s;
		const [layer] = sorted.splice(currentIndex, 1);
		sorted.splice(targetIndex, 0, layer);
		return {
			...s,
			layers: sorted.map((candidate, order) => ({ ...candidate, order, updatedAt: Date.now() }))
		};
	});
}

function setActiveLayerId(id: string): void {
	activeStore().update((s) => {
		const nextLayerId = resolveWhiteboardLayerId(s.layers, id);
		return {
			...s,
			activeLayerId: nextLayerId
		};
	});
	notifyPatch('layer:select', { id });
}

function setActiveLayerIdSilent(id: string): void {
	activeStore().update((s) => ({
		...s,
		activeLayerId: resolveWhiteboardLayerId(s.layers, id)
	}));
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
	const targetLayerId = resolveWhiteboardLayerId(get(activeStore()).layers, layerId);
	const selectionIds = [...get(activeStore()).selection];
	if (selectionIds.length === 0) return;
	activeStore().update((s) => {
		const next = pushUndo(s);
		next.elements = next.elements.map((element) =>
			next.selection.has(element.id) ? { ...element, layerId: targetLayerId, updatedAt: Date.now() } : element
		);
		next.isDirty = true;
		return next;
	});
	notifyPatch('replace', { document: getDocument() });
}

// --- Selection ---

function select(ids: string[]): void {
	activeStore().update((s) => ({ ...s, selection: new Set(ids) }));
}

function selectAll(): void {
	activeStore().update((s) => ({
		...s,
		selection: new Set(
			s.elements
				.filter((e) => {
					const layer = s.layers.find((candidate) => candidate.id === e.layerId);
					return !e.locked && layer?.visible !== false && layer?.locked !== true;
				})
				.map((e) => e.id)
		)
	}));
}

function clearSelection(): void {
	activeStore().update((s) => ({ ...s, selection: new Set() }));
}

function toggleSelection(id: string): void {
	activeStore().update((s) => {
		const next = new Set(s.selection);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return { ...s, selection: next };
	});
}

// --- Viewport ---

function setViewport(vp: WhiteboardViewport): void {
	activeStore().update((s) => ({ ...s, viewport: vp }));
}

function panBy(dx: number, dy: number): void {
	activeStore().update((s) => ({
		...s,
		viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy }
	}));
}

function zoomTo(zoom: number, cx: number, cy: number): void {
	activeStore().update((s) => {
		const clamped = Math.max(0.1, Math.min(10, zoom));
		const ratio = clamped / s.viewport.zoom;
		return {
			...s,
			viewport: {
				x: cx - (cx - s.viewport.x) / ratio,
				y: cy - (cy - s.viewport.y) / ratio,
				zoom: clamped
			}
		};
	});
}

// --- Undo / Redo ---

function undo(): void {
	activeStore().update((s) => {
		if (s.undoStack.length === 0) return s;
		const stack = [...s.undoStack];
		const entry = stack.pop()!;
		const redoEntry: UndoEntry = {
			elements: cloneElements(s.elements),
			layers: cloneLayers(s.layers),
			activeLayerId: s.activeLayerId,
			estimatedBytes: estimateBytes(s.elements) + estimateLayerBytes(s.layers)
		};
		return {
			...s,
			elements: cloneElements(entry.elements),
			layers: cloneLayers(entry.layers),
			activeLayerId: entry.activeLayerId,
			undoStack: stack,
			redoStack: [...s.redoStack, redoEntry],
			isDirty: true
		};
	});
	notifyPatch('replace', { document: getDocument() });
}

function redo(): void {
	activeStore().update((s) => {
		if (s.redoStack.length === 0) return s;
		const stack = [...s.redoStack];
		const entry = stack.pop()!;
		const undoEntry: UndoEntry = {
			elements: cloneElements(s.elements),
			layers: cloneLayers(s.layers),
			activeLayerId: s.activeLayerId,
			estimatedBytes: estimateBytes(s.elements) + estimateLayerBytes(s.layers)
		};
		return {
			...s,
			elements: cloneElements(entry.elements),
			layers: cloneLayers(entry.layers),
			activeLayerId: entry.activeLayerId,
			undoStack: [...s.undoStack, undoEntry],
			redoStack: stack,
			isDirty: true
		};
	});
	notifyPatch('replace', { document: getDocument() });
}

// --- Document access ---

function getDocument(): BoardDocument {
	const s = get(activeStore());
	return {
		boardId: s.boardId,
		version: s.version,
		elements: cloneElements(s.elements),
		layers: cloneLayers(s.layers),
		activeLayerId: s.activeLayerId,
		viewport: { ...s.viewport }
	};
}

function markClean(): void {
	activeStore().update((s) => ({ ...s, isDirty: false }));
}

// ---------------------------------------------------------------------------
// Derived stores
// ---------------------------------------------------------------------------

export const elements = deriveActiveStore((s) => s.elements);
export const layers = deriveActiveStore((s) => s.layers);
export const viewport = deriveActiveStore((s) => s.viewport);
export const activeTool = deriveActiveStore((s) => s.activeTool);
export const activeLayerId = deriveActiveStore((s) => s.activeLayerId);
export const selection = deriveActiveStore((s) => s.selection);
export const currentStyle = deriveActiveStore((s) => s.style);
export const isDirty = deriveActiveStore((s) => s.isDirty);
export const canUndo = deriveActiveStore((s) => s.undoStack.length > 0);
export const canRedo = deriveActiveStore((s) => s.redoStack.length > 0);

// ---------------------------------------------------------------------------
// Exported store object
// ---------------------------------------------------------------------------

export const boardStore = {
	subscribe: subscribeActiveStore,
	loadDocument,
	reset,
	setBoardId,
	setTool,
	setStyle,
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
	markClean
};
