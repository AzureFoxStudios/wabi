import type { WhiteboardLayer } from './boardTypes';
import type { BoardElement } from './elementTypes';
import { cloneWhiteboardLayers, createDefaultWhiteboardLayer, normalizeWhiteboardLayer, normalizeWhiteboardLayers, resolveWhiteboardLayerId, sortWhiteboardLayers } from './layers';

const MAX_UNDO = 50;
const MAX_UNDO_BYTES = 4 * 1024 * 1024;

export interface UndoEntry {
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	activeLayerId: string;
	estimatedBytes: number;
}

export function cloneElement(el: BoardElement): BoardElement {
	if (el.type === 'stroke') {
		return { ...el, points: el.points.map((point) => ({ ...point })) };
	}
	return { ...el };
}

export function cloneElements(elements: BoardElement[]): BoardElement[] {
	return elements.map(cloneElement);
}

export function estimateBytes(elements: BoardElement[]): number {
	let bytes = 0;
	for (const el of elements) {
		bytes += 200;
		if (el.type === 'stroke') bytes += el.points.length * 24;
	}
	return bytes;
}

export function estimateLayerBytes(layers: WhiteboardLayer[]): number {
	return layers.length * 128;
}

export function pushUndo(
	elements: BoardElement[],
	layers: WhiteboardLayer[],
	activeLayerId: string,
	undoStack: UndoEntry[]
): UndoEntry[] {
	const entry: UndoEntry = {
		elements: cloneElements(elements),
		layers: cloneWhiteboardLayers(layers),
		activeLayerId,
		estimatedBytes: estimateBytes(elements) + estimateLayerBytes(layers)
	};
	let stack = [...undoStack, entry];
	while (stack.length > MAX_UNDO) stack.shift();
	let total = 0;
	for (let i = stack.length - 1; i >= 0; i--) total += stack[i].estimatedBytes;
	while (total > MAX_UNDO_BYTES && stack.length > 1) {
		total -= stack[0].estimatedBytes;
		stack.shift();
	}
	return stack;
}

export function normalizeElementLayerId(element: BoardElement, layers: WhiteboardLayer[]): BoardElement {
	const layerId = resolveWhiteboardLayerId(layers, element.layerId);
	return element.layerId === layerId ? element : ({ ...element, layerId } as BoardElement);
}

export function normalizeElements(elements: BoardElement[], layers: WhiteboardLayer[]): BoardElement[] {
	return elements.map((element) => normalizeElementLayerId(cloneElement(element), layers));
}

export interface BoardDocument {
	boardId: string;
	version: number;
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	activeLayerId: string;
	viewport: { x: number; y: number; zoom: number };
}

export function buildBoardStateFromDocument(doc: BoardDocument) {
	const layers = normalizeWhiteboardLayers(doc.layers || [], [createDefaultWhiteboardLayer()]);
	const activeLayerId = resolveWhiteboardLayerId(layers, doc.activeLayerId || layers[0]?.id || '');
	const elements = normalizeElements(doc.elements || [], layers);
	return {
		boardId: doc.boardId,
		version: doc.version,
		elements,
		layers,
		activeLayerId,
		viewport: { ...doc.viewport },
		selection: new Set<string>(),
		undoStack: [] as UndoEntry[],
		redoStack: [] as UndoEntry[],
		isDirty: false
	};
}
