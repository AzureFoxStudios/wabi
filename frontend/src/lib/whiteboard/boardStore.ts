import { writable, derived, get } from 'svelte/store';
import type { WhiteboardViewport } from './boardTypes';
import type { BoardElement } from './elementTypes';
import { DEFAULT_STYLE, generateElementId } from './elementTypes';

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
	estimatedBytes: number;
}

export interface BoardState {
	boardId: string;
	version: number;
	elements: BoardElement[];
	viewport: WhiteboardViewport;
	activeTool: ToolType;
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

function estimateBytes(elements: BoardElement[]): number {
	// Rough estimate: 200 bytes per element + points for strokes
	let bytes = 0;
	for (const el of elements) {
		bytes += 200;
		if (el.type === 'stroke') bytes += el.points.length * 24;
	}
	return bytes;
}

function defaultState(): BoardState {
	return {
		boardId: '',
		version: 0,
		elements: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		activeTool: 'pen',
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

const _store = writable<BoardState>(defaultState());

// Patch listener: external code (boardSync) can subscribe to know when local
// mutations happen so it can emit patches. We don't import boardSync here to
// avoid circular deps.
type PatchType = 'create' | 'update' | 'delete' | 'reorder' | 'replace';
type PatchListener = (type: PatchType, payload: unknown) => void;
let _patchListener: PatchListener | null = null;

export function setPatchListener(fn: PatchListener | null): void {
	_patchListener = fn;
}

function notifyPatch(type: PatchType, payload: unknown): void {
	if (_patchListener) _patchListener(type, payload);
}

// ---------------------------------------------------------------------------
// Undo helpers
// ---------------------------------------------------------------------------

function pushUndo(state: BoardState): BoardState {
	const entry: UndoEntry = {
		elements: cloneElements(state.elements),
		estimatedBytes: estimateBytes(state.elements)
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function loadDocument(doc: BoardDocument): void {
	_store.update((s) => ({
		...s,
		boardId: doc.boardId,
		version: doc.version,
		elements: cloneElements(doc.elements),
		viewport: { ...doc.viewport },
		selection: new Set(),
		undoStack: [],
		redoStack: [],
		isDirty: false
	}));
}

function reset(): void {
	_store.set(defaultState());
}

function setBoardId(id: string): void {
	_store.update((s) => ({ ...s, boardId: id }));
}

function setTool(tool: ToolType): void {
	_store.update((s) => ({ ...s, activeTool: tool }));
}

function setStyle(partial: Partial<BoardStyle>): void {
	_store.update((s) => ({ ...s, style: { ...s.style, ...partial } }));
}

function pushHistoryCheckpoint(): void {
	_store.update((s) => pushUndo(s));
}

// --- Element mutations (with undo + dirty + patch) ---

function addElement(el: BoardElement): void {
	_store.update((s) => {
		const next = pushUndo(s);
		next.elements = [...next.elements, el];
		next.isDirty = true;
		return next;
	});
	notifyPatch('create', el);
}

function updateElement(
	id: string,
	partial: Partial<BoardElement>,
	options: UpdateElementOptions = {}
): void {
	const { recordHistory = true, emitPatch = true } = options;
	_store.update((s) => {
		const idx = s.elements.findIndex((e) => e.id === id);
		if (idx === -1) return s;
		const next = recordHistory ? pushUndo(s) : { ...s, elements: [...s.elements] };
		const updated = { ...next.elements[idx], ...partial, updatedAt: Date.now() } as BoardElement;
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
	_store.update((s) => {
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
	_store.update((s) => {
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
	_store.update((s) => {
		const next = pushUndo(s);
		const maxZ = next.elements.reduce((m, e) => Math.max(m, e.zIndex), 0);
		const newEls: BoardElement[] = [];
		let offset = 1;
		for (const id of ids) {
			const src = next.elements.find((e) => e.id === id);
			if (!src) continue;
			const baseDup = {
				...src,
				id: generateElementId(),
				x: src.x + 20,
				y: src.y + 20,
				zIndex: maxZ + offset,
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
	const s = get(_store);
	for (const id of [...s.selection]) {
		const el = s.elements.find((e) => e.id === id);
		if (el) notifyPatch('create', el);
	}
}

// --- Silent mutations (for remote patches — no undo, no dirty, no patch) ---

function addElementSilent(el: BoardElement): void {
	_store.update((s) => {
		if (s.elements.some((existing) => existing.id === el.id)) {
			return s;
		}
		return { ...s, elements: [...s.elements, cloneElement(el)] };
	});
}

function updateElementSilent(id: string, partial: Partial<BoardElement>): void {
	_store.update((s) => {
		const idx = s.elements.findIndex((e) => e.id === id);
		if (idx === -1) return s;
		const els = [...s.elements];
		els[idx] = { ...els[idx], ...partial } as BoardElement;
		return { ...s, elements: els };
	});
}

function deleteElementsSilent(ids: string[]): void {
	const idSet = new Set(ids);
	_store.update((s) => ({
		...s,
		elements: s.elements.filter((e) => !idSet.has(e.id)),
		selection: new Set([...s.selection].filter((id) => !idSet.has(id)))
	}));
}

// --- Selection ---

function select(ids: string[]): void {
	_store.update((s) => ({ ...s, selection: new Set(ids) }));
}

function selectAll(): void {
	_store.update((s) => ({ ...s, selection: new Set(s.elements.filter((e) => !e.locked).map((e) => e.id)) }));
}

function clearSelection(): void {
	_store.update((s) => ({ ...s, selection: new Set() }));
}

function toggleSelection(id: string): void {
	_store.update((s) => {
		const next = new Set(s.selection);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return { ...s, selection: next };
	});
}

// --- Viewport ---

function setViewport(vp: WhiteboardViewport): void {
	_store.update((s) => ({ ...s, viewport: vp }));
}

function panBy(dx: number, dy: number): void {
	_store.update((s) => ({
		...s,
		viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy }
	}));
}

function zoomTo(zoom: number, cx: number, cy: number): void {
	_store.update((s) => {
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
	_store.update((s) => {
		if (s.undoStack.length === 0) return s;
		const stack = [...s.undoStack];
		const entry = stack.pop()!;
		const redoEntry: UndoEntry = {
			elements: cloneElements(s.elements),
			estimatedBytes: estimateBytes(s.elements)
		};
		return {
			...s,
			elements: cloneElements(entry.elements),
			undoStack: stack,
			redoStack: [...s.redoStack, redoEntry],
			isDirty: true
		};
	});
	notifyPatch('replace', { document: getDocument() });
}

function redo(): void {
	_store.update((s) => {
		if (s.redoStack.length === 0) return s;
		const stack = [...s.redoStack];
		const entry = stack.pop()!;
		const undoEntry: UndoEntry = {
			elements: cloneElements(s.elements),
			estimatedBytes: estimateBytes(s.elements)
		};
		return {
			...s,
			elements: cloneElements(entry.elements),
			undoStack: [...s.undoStack, undoEntry],
			redoStack: stack,
			isDirty: true
		};
	});
	notifyPatch('replace', { document: getDocument() });
}

// --- Document access ---

function getDocument(): BoardDocument {
	const s = get(_store);
	return {
		boardId: s.boardId,
		version: s.version,
		elements: cloneElements(s.elements),
		viewport: { ...s.viewport }
	};
}

function markClean(): void {
	_store.update((s) => ({ ...s, isDirty: false }));
}

// ---------------------------------------------------------------------------
// Derived stores
// ---------------------------------------------------------------------------

export const elements = derived(_store, (s) => s.elements);
export const viewport = derived(_store, (s) => s.viewport);
export const activeTool = derived(_store, (s) => s.activeTool);
export const selection = derived(_store, (s) => s.selection);
export const currentStyle = derived(_store, (s) => s.style);
export const isDirty = derived(_store, (s) => s.isDirty);
export const canUndo = derived(_store, (s) => s.undoStack.length > 0);
export const canRedo = derived(_store, (s) => s.redoStack.length > 0);

// ---------------------------------------------------------------------------
// Exported store object
// ---------------------------------------------------------------------------

export const boardStore = {
	subscribe: _store.subscribe,
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
