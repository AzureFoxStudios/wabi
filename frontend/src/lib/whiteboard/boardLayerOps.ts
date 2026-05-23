import type { WhiteboardLayer } from './boardTypes';
import type { BoardElement } from './elementTypes';
import { createDefaultWhiteboardLayer, createLayerId, normalizeWhiteboardLayer, resolveWhiteboardLayerId, sortWhiteboardLayers } from './layers';
import { pushUndo, type UndoEntry } from './boardUndo';

type PatchType = 'layer:create' | 'layer:update' | 'layer:delete' | 'layer:reorder' | 'layer:select' | 'replace';
type PatchListener = (type: PatchType, payload: unknown) => void;

export interface BoardState {
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	activeLayerId: string;
	selection: Set<string>;
	undoStack: UndoEntry[];
	redoStack: UndoEntry[];
	isDirty: boolean;
}

export function ensureLayer(
	state: BoardState,
	layer: Partial<WhiteboardLayer> & { id?: string; name?: string },
	patchListener: PatchListener | null
): { state: BoardState; created: WhiteboardLayer } {
	const existing = layer.id ? state.layers.find((candidate) => candidate.id === layer.id) : null;
	if (existing) return { state, created: existing };

	const now = Date.now();
	const normalized = normalizeWhiteboardLayer(
		{
			id: layer.id || createLayerId(layer.name || 'Layer'),
			name: layer.name || 'Layer',
			kind: layer.kind || 'content',
			visible: layer.visible ?? true,
			locked: layer.locked ?? false,
			opacity: layer.opacity ?? 1,
			order: layer.order ?? state.layers.length,
			createdAt: layer.createdAt || now,
			updatedAt: layer.updatedAt || now
		},
		state.layers.length,
		now
	);
	if (!normalized) {
		return { state, created: createDefaultWhiteboardLayer(now) };
	}
	const nextLayers = sortWhiteboardLayers([...state.layers, normalized]);
	const next: BoardState = {
		...state,
		layers: nextLayers,
		activeLayerId: resolveWhiteboardLayerId(nextLayers, state.activeLayerId)
	};
	if (patchListener) patchListener('layer:create', normalized);
	return { state: next, created: normalized };
}

export function addLayer(
	state: BoardState,
	partial: Partial<WhiteboardLayer>,
	patchListener: PatchListener | null
): { state: BoardState; created: WhiteboardLayer } {
	return ensureLayer(state, { ...partial, id: partial.id || createLayerId(partial.name || 'Layer') }, patchListener);
}

export function updateLayer(
	state: BoardState,
	id: string,
	partial: Partial<WhiteboardLayer>,
	patchListener: PatchListener | null
): BoardState {
	const idx = state.layers.findIndex((layer) => layer.id === id);
	if (idx === -1) return state;
	const current = state.layers[idx];
	const updated = normalizeWhiteboardLayer(
		{ ...current, ...partial, id: current.id, updatedAt: Date.now() },
		idx
	) || current;
	const nextLayers = sortWhiteboardLayers(state.layers.map((l, i) => i === idx ? updated : l));
	const next: BoardState = {
		...state,
		layers: nextLayers,
		activeLayerId: resolveWhiteboardLayerId(nextLayers, state.activeLayerId),
		elements: state.elements.map((element) =>
			element.layerId === current.id ? { ...element, layerId: current.id } : element
		),
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	if (patchListener) patchListener('layer:update', { id, changes: partial });
	return next;
}

export function updateLayerSilent(state: BoardState, id: string, partial: Partial<WhiteboardLayer>): BoardState {
	const idx = state.layers.findIndex((layer) => layer.id === id);
	if (idx === -1) return state;
	const current = state.layers[idx];
	const nextLayers = [...state.layers];
	nextLayers[idx] = normalizeWhiteboardLayer(
		{ ...current, ...partial, id: current.id, updatedAt: Date.now() },
		idx
	) || current;
	const sorted = sortWhiteboardLayers(nextLayers);
	return {
		...state,
		layers: sorted,
		activeLayerId: resolveWhiteboardLayerId(sorted, state.activeLayerId),
		elements: state.elements.map((element) =>
			element.layerId === current.id ? { ...element, layerId: current.id } : element
		)
	};
}

export function deleteLayer(
	state: BoardState,
	id: string,
	patchListener: PatchListener | null
): BoardState {
	if (state.layers.length <= 1) return state;
	const target = state.layers.find((layer) => layer.id === id);
	if (!target) return state;
	const fallbackLayer = state.layers.find((layer) => layer.id !== id) || createDefaultWhiteboardLayer();
	const nextLayers = sortWhiteboardLayers(state.layers.filter((layer) => layer.id !== id));
	const next: BoardState = {
		...state,
		layers: nextLayers,
		elements: state.elements.map((element) =>
			element.layerId === id ? { ...element, layerId: fallbackLayer.id } : element
		),
		activeLayerId: resolveWhiteboardLayerId(nextLayers, state.activeLayerId),
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	if (patchListener) patchListener('layer:delete', { id });
	return next;
}

export function deleteLayerSilent(state: BoardState, id: string): BoardState {
	if (state.layers.length <= 1) return state;
	const target = state.layers.find((layer) => layer.id === id);
	if (!target) return state;
	const fallbackLayer = state.layers.find((layer) => layer.id !== id) || createDefaultWhiteboardLayer();
	const nextLayers = sortWhiteboardLayers(state.layers.filter((layer) => layer.id !== id));
	return {
		...state,
		layers: nextLayers,
		elements: state.elements.map((element) =>
			element.layerId === id ? { ...element, layerId: fallbackLayer.id } : element
		),
		activeLayerId: resolveWhiteboardLayerId(nextLayers, state.activeLayerId)
	};
}

export function reorderLayer(
	state: BoardState,
	id: string,
	dir: 'front' | 'back' | 'forward' | 'backward',
	patchListener: PatchListener | null
): BoardState {
	const sorted = sortWhiteboardLayers(state.layers);
	const currentIndex = sorted.findIndex((layer) => layer.id === id);
	if (currentIndex === -1) return state;

	const targetIndex =
		dir === 'front' ? sorted.length - 1
		: dir === 'back' ? 0
		: dir === 'forward' ? Math.min(sorted.length - 1, currentIndex + 1)
		: Math.max(0, currentIndex - 1);

	if (targetIndex === currentIndex) return state;
	const [layer] = sorted.splice(currentIndex, 1);
	sorted.splice(targetIndex, 0, layer);
	const next: BoardState = {
		...state,
		layers: sorted.map((candidate, order) => ({ ...candidate, order, updatedAt: Date.now() })),
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	if (patchListener) patchListener('layer:reorder', { id, dir });
	return next;
}

export function reorderLayerSilent(state: BoardState, id: string, dir: 'front' | 'back' | 'forward' | 'backward'): BoardState {
	const sorted = sortWhiteboardLayers(state.layers);
	const currentIndex = sorted.findIndex((layer) => layer.id === id);
	if (currentIndex === -1) return state;

	const targetIndex =
		dir === 'front' ? sorted.length - 1
		: dir === 'back' ? 0
		: dir === 'forward' ? Math.min(sorted.length - 1, currentIndex + 1)
		: Math.max(0, currentIndex - 1);

	if (targetIndex === currentIndex) return state;
	const [layer] = sorted.splice(currentIndex, 1);
	sorted.splice(targetIndex, 0, layer);
	return {
		...state,
		layers: sorted.map((candidate, order) => ({ ...candidate, order, updatedAt: Date.now() }))
	};
}

export function setActiveLayerId(state: BoardState, id: string, patchListener: PatchListener | null): BoardState {
	const nextLayerId = resolveWhiteboardLayerId(state.layers, id);
	const next = { ...state, activeLayerId: nextLayerId };
	if (patchListener) patchListener('layer:select', { id });
	return next;
}

export function setActiveLayerIdSilent(state: BoardState, id: string): BoardState {
	return { ...state, activeLayerId: resolveWhiteboardLayerId(state.layers, id) };
}

export function assignSelectionToLayer(
	state: BoardState,
	layerId: string,
	patchListener: PatchListener | null
): BoardState {
	const targetLayerId = resolveWhiteboardLayerId(state.layers, layerId);
	const selectionIds = [...state.selection];
	if (selectionIds.length === 0) return state;
	const next: BoardState = {
		...state,
		elements: state.elements.map((element) =>
			state.selection.has(element.id) ? { ...element, layerId: targetLayerId, updatedAt: Date.now() } : element
		),
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	if (patchListener) patchListener('replace', { document: null });
	return next;
}
