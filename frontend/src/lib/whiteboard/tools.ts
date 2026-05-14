import { get } from 'svelte/store';
import type { BoardElement, Point, StrokeElement } from './elementTypes';
import { generateElementId } from './elementTypes';
import { boardStore, type BoardStyle, type ToolType } from './boardStore';
import {
	pickElement,
	hitTestHandle,
	getSelectionHandles,
	getSelectionBBox,
	getElementBBox,
	normalizeRect,
	type HandlePosition,
	type BBox
} from './coords';
import { resolveWritableWhiteboardLayerId } from './layers';

// ---------------------------------------------------------------------------
// Tool event / interaction interfaces
// ---------------------------------------------------------------------------

export interface ToolPointerEvent {
	boardX: number;
	boardY: number;
	screenX: number;
	screenY: number;
	pressure: number;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	button: number;
}

export interface ToolInteraction {
	onPointerMove(e: ToolPointerEvent): void;
	onPointerUp(e: ToolPointerEvent): void;
	getPreview(): BoardElement | null;
	getSelectionRect(): BBox | null;
}

export interface ToolHandler {
	id: ToolType;
	cursor: string;
	onPointerDown(e: ToolPointerEvent): ToolInteraction | null;
}

// ---------------------------------------------------------------------------
// Helper: create base element from current style
// ---------------------------------------------------------------------------

function makeBase(style: BoardStyle, type: string, x: number, y: number, elements: BoardElement[]): any {
	const state = get(boardStore);
	const activeLayerId = resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId);
	const maxZ = elements
		.filter((element) => !activeLayerId || element.layerId === activeLayerId)
		.reduce((m, e) => Math.max(m, e.zIndex), 0);
	return {
		id: generateElementId(),
		type,
		x,
		y,
		width: 0,
		height: 0,
		rotation: 0,
		zIndex: maxZ + 1,
		layerId: activeLayerId,
		opacity: 1,
		strokeColor: style.strokeColor,
		strokeWidth: style.strokeWidth,
		fillColor: style.fillColor,
		createdBy: '',
		updatedAt: Date.now(),
		locked: false
	};
}

// ---------------------------------------------------------------------------
// Pen tool
// ---------------------------------------------------------------------------

function simplifyPoints(pts: Point[], minDist: number): Point[] {
	if (pts.length <= 2) return pts;
	const result: Point[] = [pts[0]];
	for (let i = 1; i < pts.length; i++) {
		const prev = result[result.length - 1];
		const dx = pts[i].x - prev.x;
		const dy = pts[i].y - prev.y;
		if (dx * dx + dy * dy >= minDist * minDist) {
			result.push(pts[i]);
		}
	}
	// Always keep last point
	if (result[result.length - 1] !== pts[pts.length - 1]) {
		result.push(pts[pts.length - 1]);
	}
	return result;
}

export function createPenTool(): ToolHandler {
	return {
		id: 'pen',
		cursor: 'crosshair',
		onPointerDown(e) {
			const state = get(boardStore);
			const base = makeBase(state.style, 'stroke', e.boardX, e.boardY, state.elements);
			const points: Point[] = [{ x: e.boardX, y: e.boardY, pressure: e.pressure }];
			let preview: StrokeElement = { ...base, points: [...points] };

			return {
				onPointerMove(e) {
					points.push({ x: e.boardX, y: e.boardY, pressure: e.pressure });
					preview = { ...preview, points: [...points] };
				},
				onPointerUp() {
					const simplified = simplifyPoints(points, 2);
					const bbox = computeStrokeBBox(simplified);
					const el: StrokeElement = {
						...base,
						...bbox,
						points: simplified
					};
					boardStore.addElement(el);
					preview = null as any;
				},
				getPreview() { return preview; },
				getSelectionRect() { return null; }
			};
		}
	};
}

function computeStrokeBBox(pts: Point[]): { x: number; y: number; width: number; height: number } {
	if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------
// Shape tools (line, rect, ellipse, arrow)
// ---------------------------------------------------------------------------

function createShapeTool(toolType: 'line' | 'rect' | 'ellipse' | 'arrow'): ToolHandler {
	return {
		id: toolType,
		cursor: 'crosshair',
		onPointerDown(e) {
			const state = get(boardStore);
			const base = makeBase(state.style, toolType, e.boardX, e.boardY, state.elements);
			if (toolType === 'rect') (base as any).borderRadius = 0;
			if (toolType === 'arrow') (base as any).arrowHead = 'end';

			const startX = e.boardX;
			const startY = e.boardY;
			let preview: BoardElement = { ...base };

			return {
				onPointerMove(ev) {
					let w = ev.boardX - startX;
					let h = ev.boardY - startY;
					// Shift = constrain aspect ratio
					if (ev.shiftKey) {
						const size = Math.max(Math.abs(w), Math.abs(h));
						w = size * Math.sign(w || 1);
						h = size * Math.sign(h || 1);
					}
					if (toolType === 'line' || toolType === 'arrow') {
						preview = { ...base, width: w, height: h } as BoardElement;
					} else {
						const norm = normalizeRect(startX, startY, w, h);
						preview = { ...base, x: norm.x, y: norm.y, width: norm.width, height: norm.height } as BoardElement;
					}
				},
				onPointerUp(ev) {
					let w = ev.boardX - startX;
					let h = ev.boardY - startY;
					if (ev.shiftKey) {
						const size = Math.max(Math.abs(w), Math.abs(h));
						w = size * Math.sign(w || 1);
						h = size * Math.sign(h || 1);
					}
					// Skip tiny accidental clicks
					if (Math.abs(w) < 3 && Math.abs(h) < 3) return;

					let el: BoardElement;
					if (toolType === 'line' || toolType === 'arrow') {
						el = { ...base, width: w, height: h } as BoardElement;
					} else {
						const norm = normalizeRect(startX, startY, w, h);
						el = { ...base, x: norm.x, y: norm.y, width: norm.width, height: norm.height } as BoardElement;
					}
					boardStore.addElement(el);
				},
				getPreview() { return preview; },
				getSelectionRect() { return null; }
			};
		}
	};
}

export const createLineTool = () => createShapeTool('line');
export const createRectTool = () => createShapeTool('rect');
export const createEllipseTool = () => createShapeTool('ellipse');
export const createArrowTool = () => createShapeTool('arrow');

// ---------------------------------------------------------------------------
// Text tool
// ---------------------------------------------------------------------------

export interface TextPlacement {
	x: number;
	y: number;
	style: BoardStyle;
	elementId: string;
	maxZ: number;
	layerId: string;
}

let textPlacementCallback: ((placement: TextPlacement) => void) | null = null;

export function onTextPlacement(cb: (placement: TextPlacement) => void): () => void {
	textPlacementCallback = cb;
	return () => { textPlacementCallback = null; };
}

export function createTextTool(): ToolHandler {
	return {
		id: 'text',
		cursor: 'text',
		onPointerDown(e) {
			const state = get(boardStore);
			const activeLayerId = resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId);
			const maxZ = state.elements
				.filter((element) => element.layerId === activeLayerId)
				.reduce((m, el) => Math.max(m, el.zIndex), 0);
			if (textPlacementCallback) {
				textPlacementCallback({
					x: e.boardX,
					y: e.boardY,
					style: { ...state.style },
					elementId: generateElementId(),
					maxZ: maxZ + 1,
					layerId: activeLayerId
				});
			}
			return null;
		}
	};
}

// ---------------------------------------------------------------------------
// Select tool
// ---------------------------------------------------------------------------

export function createSelectTool(): ToolHandler {
	return {
		id: 'select',
		cursor: 'default',
		onPointerDown(e) {
			const state = get(boardStore);
			const vp = state.viewport;

			// Check if clicking a resize handle on current selection
			if (state.selection.size > 0) {
				const selectedEls = state.elements.filter((el) => state.selection.has(el.id));
				const selBBox = getSelectionBBox(selectedEls);
				if (selBBox) {
					const handles = getSelectionHandles(selBBox, vp, 8);
					const hitHandle = hitTestHandle(handles, e.screenX, e.screenY, 12);
					if (hitHandle) {
						return createResizeInteraction(selectedEls, selBBox, hitHandle.position, e);
					}
				}
			}

			// Hit test for element
			const tolerance = 6 / vp.zoom;
			const hit = pickElement(state.elements, e.boardX, e.boardY, tolerance, state.layers);

			if (hit) {
				// Select and start move
				if (!state.selection.has(hit.id)) {
					if (e.shiftKey) {
						boardStore.toggleSelection(hit.id);
					} else {
						boardStore.select([hit.id]);
					}
				}
				return createMoveInteraction(e);
			}

			// Empty click: start rubber band selection
			boardStore.clearSelection();
			return createRubberBandInteraction(e);
		}
	};
}

function createMoveInteraction(startEvent: ToolPointerEvent): ToolInteraction {
	let lastBX = startEvent.boardX;
	let lastBY = startEvent.boardY;
	let didStartMove = false;

	return {
		onPointerMove(e) {
			const dx = e.boardX - lastBX;
			const dy = e.boardY - lastBY;
			if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
			if (!didStartMove) {
				boardStore.pushHistoryCheckpoint();
				didStartMove = true;
			}
			lastBX = e.boardX;
			lastBY = e.boardY;

			const state = get(boardStore);
			for (const id of state.selection) {
				const el = state.elements.find((e) => e.id === id);
				if (!el) continue;
				if (el.type === 'stroke') {
					const pts = (el as any).points.map((p: Point) => ({ ...p, x: p.x + dx, y: p.y + dy }));
					boardStore.updateElement(
						id,
						{ x: el.x + dx, y: el.y + dy, points: pts } as any,
						{ recordHistory: false }
					);
				} else {
					boardStore.updateElement(id, { x: el.x + dx, y: el.y + dy }, { recordHistory: false });
				}
			}
		},
		onPointerUp() {},
		getPreview() { return null; },
		getSelectionRect() { return null; }
	};
}

function createResizeInteraction(
	selectedEls: BoardElement[],
	origBBox: BBox,
	handle: HandlePosition,
	startEvent: ToolPointerEvent
): ToolInteraction {
	const startBX = startEvent.boardX;
	const startBY = startEvent.boardY;
	const origX = origBBox.x;
	const origY = origBBox.y;
	const origW = origBBox.width;
	const origH = origBBox.height;
	let didStartResize = false;

	// Snapshot original positions relative to selection bbox
	const origPositions = selectedEls.map((el) => ({
		id: el.id,
		type: el.type,
		originalX: el.x,
		originalY: el.y,
		originalWidth: el.width,
		originalHeight: el.height,
		originalPoints:
			el.type === 'stroke' ? el.points.map((point) => ({ ...point })) : null,
		relX: (el.x - origX) / (origW || 1),
		relY: (el.y - origY) / (origH || 1),
		relW: el.width / (origW || 1),
		relH: el.height / (origH || 1)
	}));

	return {
		onPointerMove(e) {
			const dx = e.boardX - startBX;
			const dy = e.boardY - startBY;
			if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
			if (!didStartResize) {
				boardStore.pushHistoryCheckpoint();
				didStartResize = true;
			}

			let newX = origX, newY = origY, newW = origW, newH = origH;

			if (handle.includes('e')) newW = origW + dx;
			if (handle.includes('w')) { newX = origX + dx; newW = origW - dx; }
			if (handle.includes('s')) newH = origH + dy;
			if (handle.includes('n')) { newY = origY + dy; newH = origH - dy; }

			// Prevent negative sizes
			if (newW < 1) { newW = 1; }
			if (newH < 1) { newH = 1; }

			// Apply scaled positions to all selected elements
			for (const orig of origPositions) {
				const nextX = newX + orig.relX * newW;
				const nextY = newY + orig.relY * newH;
				const nextWidth = orig.relW * newW;
				const nextHeight = orig.relH * newH;
				if (orig.type === 'stroke' && orig.originalPoints) {
					const scaleX = origW === 0 ? 1 : newW / origW;
					const scaleY = origH === 0 ? 1 : newH / origH;
					boardStore.updateElement(
						orig.id,
						{
							x: nextX,
							y: nextY,
							width: nextWidth,
							height: nextHeight,
							points: orig.originalPoints.map((point) => ({
								...point,
								x: newX + (point.x - origX) * scaleX,
								y: newY + (point.y - origY) * scaleY
							}))
						} as Partial<BoardElement>,
						{ recordHistory: false }
					);
					continue;
				}
				boardStore.updateElement(
					orig.id,
					{
						x: nextX,
						y: nextY,
						width: nextWidth,
						height: nextHeight
					},
					{ recordHistory: false }
				);
			}
		},
		onPointerUp() {},
		getPreview() { return null; },
		getSelectionRect() { return null; }
	};
}

function createRubberBandInteraction(startEvent: ToolPointerEvent): ToolInteraction {
	const startBX = startEvent.boardX;
	const startBY = startEvent.boardY;
	let rect: BBox | null = null;

	return {
		onPointerMove(e) {
			rect = normalizeRect(startBX, startBY, e.boardX - startBX, e.boardY - startBY);
			// Select all elements inside the rect
			const state = get(boardStore);
			const ids: string[] = [];
			for (const el of state.elements) {
				const layer = state.layers.find((candidate) => candidate.id === el.layerId);
				if (el.locked || layer?.locked || layer?.visible === false) continue;
				const bb = getElementBBox(el);
				if (
					bb.x >= rect.x && bb.y >= rect.y &&
					bb.x + bb.width <= rect.x + rect.width &&
					bb.y + bb.height <= rect.y + rect.height
				) {
					ids.push(el.id);
				}
			}
			boardStore.select(ids);
		},
		onPointerUp() {
			rect = null;
		},
		getPreview() { return null; },
		getSelectionRect() { return rect; }
	};
}

// ---------------------------------------------------------------------------
// Pan tool
// ---------------------------------------------------------------------------

export function createPanTool(): ToolHandler {
	return {
		id: 'pan',
		cursor: 'grab',
		onPointerDown(e) {
			let lastSX = e.screenX;
			let lastSY = e.screenY;

			return {
				onPointerMove(ev) {
					const state = get(boardStore);
					const dx = (ev.screenX - lastSX) / state.viewport.zoom;
					const dy = (ev.screenY - lastSY) / state.viewport.zoom;
					lastSX = ev.screenX;
					lastSY = ev.screenY;
					boardStore.panBy(-dx, -dy);
				},
				onPointerUp() {},
				getPreview() { return null; },
				getSelectionRect() { return null; }
			};
		}
	};
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export function getToolHandler(toolType: ToolType): ToolHandler {
	switch (toolType) {
		case 'pen': return createPenTool();
		case 'line': return createLineTool();
		case 'rect': return createRectTool();
		case 'ellipse': return createEllipseTool();
		case 'arrow': return createArrowTool();
		case 'text': return createTextTool();
		case 'select': return createSelectTool();
		case 'pan': return createPanTool();
		default: return createPenTool();
	}
}
