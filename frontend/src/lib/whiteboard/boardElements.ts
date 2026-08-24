import type { WhiteboardLayer } from './boardTypes';
import type { BoardElement } from './elementTypes';
import { generateElementId } from './elementTypes';
import { resolveWhiteboardLayerId, resolveWritableWhiteboardLayerId } from './layers';
import { cloneElement, cloneElements, estimateBytes, estimateLayerBytes, pushUndo, type UndoEntry } from './boardUndo';
import { cloneWhiteboardLayers } from './layers';

type PatchType = 'create' | 'update' | 'delete' | 'reorder' | 'replace';
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

function applyElementMutations(
	state: BoardState,
	fn: (state: BoardState) => BoardState,
	patchListener: PatchListener | null,
	patchType: PatchType,
	patchPayload: unknown
): BoardState {
	const next = fn(state);
	if (patchListener) patchListener(patchType, patchPayload);
	return next;
}

export function addElement(
	state: BoardState,
	el: BoardElement,
	patchListener: PatchListener | null
): BoardState {
	let committed: BoardElement | null = null;
	const next = { ...state };
	next.undoStack = pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack);
	const targetLayerId = resolveWritableWhiteboardLayerId(next.layers, el.layerId || next.activeLayerId);
	committed = { ...el, layerId: targetLayerId } as BoardElement;
	next.elements = [...next.elements, committed];
	next.isDirty = true;
	next.redoStack = [];
	if (committed && patchListener) patchListener('create', committed);
	return next;
}

export interface UpdateElementOptions {
	recordHistory?: boolean;
	emitPatch?: boolean;
}

export function updateElement(
	state: BoardState,
	id: string,
	partial: Partial<BoardElement>,
	options: UpdateElementOptions = {},
	patchListener: PatchListener | null = null
): BoardState {
	const { recordHistory = true, emitPatch = true } = options;
	const idx = state.elements.findIndex((e) => e.id === id);
	if (idx === -1) return state;

	const next: BoardState = {
		...state,
		elements: [...state.elements],
		undoStack: recordHistory ? pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack) : state.undoStack,
		redoStack: recordHistory ? [] : state.redoStack,
		isDirty: true
	};
	const layerId = partial.layerId ? resolveWhiteboardLayerId(next.layers, partial.layerId) : next.elements[idx].layerId;
	next.elements[idx] = { ...next.elements[idx], ...partial, layerId, updatedAt: Date.now() } as BoardElement;
	if (emitPatch && patchListener) patchListener('update', { id, changes: partial });
	return next;
}

export interface BatchEntry {
	id: string;
	partial: Partial<BoardElement>;
}

export function updateElementsBatch(
	state: BoardState,
	entries: BatchEntry[],
	options: UpdateElementOptions = {},
	patchListener: PatchListener | null = null
): BoardState {
	if (entries.length === 0) return state;
	const { recordHistory = true, emitPatch = true } = options;

	const byId = new Map<string, Partial<BoardElement>>();
	for (const entry of entries) byId.set(entry.id, entry.partial);

	// Skip the clone entirely if no targeted element exists in this state.
	const exists = state.elements.some((e) => byId.has(e.id));
	if (!exists) return state;

	const next: BoardState = {
		...state,
		elements: [...state.elements],
		undoStack: recordHistory ? pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack) : state.undoStack,
		redoStack: recordHistory ? [] : state.redoStack,
		isDirty: true
	};

	for (let i = 0; i < next.elements.length; i++) {
		const el = next.elements[i];
		const partial = byId.get(el.id);
		if (!partial) continue;
		const layerId = partial.layerId ? resolveWhiteboardLayerId(next.layers, partial.layerId) : el.layerId;
		next.elements[i] = { ...el, ...partial, layerId, updatedAt: Date.now() } as BoardElement;
		if (emitPatch && patchListener) patchListener('update', { id: el.id, changes: partial });
	}
	return next;
}

export function deleteElements(
	state: BoardState,
	ids: string[],
	patchListener: PatchListener | null
): BoardState {
	if (ids.length === 0) return state;
	const idSet = new Set(ids);
	const next: BoardState = {
		...state,
		elements: state.elements.filter((e) => !idSet.has(e.id)),
		selection: new Set([...state.selection].filter((id) => !idSet.has(id))),
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	if (patchListener) patchListener('delete', { ids });
	return next;
}

export function reorderElement(
	state: BoardState,
	id: string,
	dir: 'front' | 'back' | 'forward' | 'backward',
	patchListener: PatchListener | null
): BoardState {
	const sorted = [...state.elements].sort((a, b) => a.zIndex - b.zIndex);
	const idx = sorted.findIndex((e) => e.id === id);
	if (idx === -1) return state;

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

	const next: BoardState = {
		...state,
		elements: sorted,
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	if (patchListener) patchListener('reorder', { id, dir });
	return next;
}

export function duplicateElements(
	state: BoardState,
	ids: string[],
	patchListener: PatchListener | null
): BoardState {
	const newEls: BoardElement[] = [];
	let offset = 1;
	for (const id of ids) {
		const src = state.elements.find((e) => e.id === id);
		if (!src) continue;
		const maxZ = state.elements
			.filter((element) => element.layerId === src.layerId)
			.reduce((m, e) => Math.max(m, e.zIndex), 0);
		const baseDup = {
			...src,
			id: generateElementId(),
			x: src.x + 20,
			y: src.y + 20,
			zIndex: maxZ + offset,
			layerId: resolveWhiteboardLayerId(state.layers, src.layerId),
			updatedAt: Date.now()
		};
		const dup = src.type === 'stroke'
			? ({ ...baseDup, points: src.points.map((point) => ({ ...point, x: point.x + 20, y: point.y + 20 })) } as BoardElement)
			: (baseDup as BoardElement);
		newEls.push(dup);
		offset++;
	}

	const next: BoardState = {
		...state,
		elements: [...state.elements, ...newEls],
		selection: new Set(newEls.map((e) => e.id)),
		undoStack: pushUndo(state.elements, state.layers, state.activeLayerId, state.undoStack),
		redoStack: [],
		isDirty: true
	};
	for (const el of newEls) {
		if (patchListener) patchListener('create', el);
	}
	return next;
}

export function addElementSilent(state: BoardState, el: BoardElement): BoardState {
	if (state.elements.some((existing) => existing.id === el.id)) return state;
	const normalized: BoardElement = { ...el } as BoardElement;
	if (el.type === 'stroke') {
		(normalized as Extract<BoardElement, { type: 'stroke' }>).points = el.points.map((point) => ({ ...point }));
	}
	return { ...state, elements: [...state.elements, normalized] };
}

export function updateElementSilent(state: BoardState, id: string, partial: Partial<BoardElement>): BoardState {
	const idx = state.elements.findIndex((e) => e.id === id);
	if (idx === -1) return state;
	const els = [...state.elements];
	els[idx] = {
		...els[idx],
		...partial,
		layerId: partial.layerId ? resolveWhiteboardLayerId(state.layers, partial.layerId) : els[idx].layerId
	} as BoardElement;
	return { ...state, elements: els };
}

export function deleteElementsSilent(state: BoardState, ids: string[]): BoardState {
	const idSet = new Set(ids);
	return {
		...state,
		elements: state.elements.filter((e) => !idSet.has(e.id)),
		selection: new Set([...state.selection].filter((id) => !idSet.has(id)))
	};
}
