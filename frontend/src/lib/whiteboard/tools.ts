import { get } from 'svelte/store';
import type { BoardElement, Point, StrokeElement, MathElement } from './elementTypes';
import { generateElementId } from './elementTypes';
import { boardStore, type BoardStyle, type ToolType } from './boardStore';
import {
	pickElement,
	hitTestElement,
	hitTestHandle,
	getSelectionHandles,
	getSelectionBBox,
	getElementBBox,
	normalizeRect,
	type HandlePosition,
	type BBox
} from './coords';
import { resolveWritableWhiteboardLayerId } from './layers';
import { beginRasterStroke, commitRasterLayer, paintRasterDab, paintRasterSegment, rasterCanUndo, rasterUndo } from './rasterLayers';
import { measureMathElement, preloadMathElement } from './mathRender';

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
	id: ToolType | 'math';
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
		opacity: typeof style.opacity === 'number' ? style.opacity : 1,
		strokeColor: style.strokeColor,
		strokeWidth: style.strokeWidth,
		fillColor: style.fillColor,
		hardness: typeof style.hardness === 'number' ? style.hardness : 1,
		brushPreset: (style as { brushPreset?: string }).brushPreset,
		strokeDash: (style as { strokeDash?: number[] }).strokeDash,
		borderRadius: (style as { borderRadius?: number }).borderRadius,
		createdBy: '',
		updatedAt: Date.now(),
		locked: false
	};
}

// ---------------------------------------------------------------------------
// Brush helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Map a normalized pressure value to a stroke width.
 *   width(p) = size * (minSize + (1 - minSize) * p)
 * Undefined pressure (legacy strokes, pressure-less input) renders full width.
 */
export function strokeWidthAt(pressure: number | undefined, size: number, minSize = 0.4): number {
	const p = typeof pressure === 'number' && Number.isFinite(pressure)
		? Math.max(0, Math.min(1, pressure))
		: 1;
	return size * (minSize + (1 - minSize) * p);
}

/**
 * Smooth a raw polyline of input points into a denser, rounded polyline using
 * centripetal Catmull-Rom interpolation. Sampled ~`segments` times per input
 * segment with a `tension` scaling on the tangents (0.5 default = soft rounding).
 * Pure function: same inputs always produce the same outputs.
 */
export function smoothStrokePoints(points: Point[], tension = 0.5, segments = 6): Point[] {
	if (points.length === 0) return [];
	if (points.length === 1) return [{ ...points[0] }];

	const alpha = 0.5; // centripetal
	const firstInput = points[0];
	const result: Point[] = [{
		...firstInput,
		pressure: typeof firstInput.pressure === 'number' ? firstInput.pressure : 1
	}];
	const seg = Math.max(1, Math.round(segments));

	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(points.length - 1, i + 2)];

		for (let j = 1; j <= seg; j++) {
			result.push(sampleCatmullRom(p0, p1, p2, p3, j / seg, alpha, tension));
		}
	}

	// Force the final point to be exact so the stroke ends precisely under the cursor.
	const lastInput = points[points.length - 1];
	result[result.length - 1] = {
		...lastInput,
		pressure: typeof lastInput.pressure === 'number'
			? lastInput.pressure
			: interpolatePressure(points[points.length - 2], lastInput, 1)
	};
	return result;
}

function distanceBetween(a: Point, b: Point): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

function interpolatePressure(p1: Point, p2: Point, t: number): number {
	const a = typeof p1.pressure === 'number' ? p1.pressure : 1;
	const b = typeof p2.pressure === 'number' ? p2.pressure : 1;
	return a + (b - a) * t;
}

/**
 * Centripetal Catmull-Rom segment evaluated in Hermite form between p1 and p2,
 * using knot intervals derived from chord length (alpha = 0.5). `tension` scales
 * the tangent vectors: 0 = classic Catmull-Rom, 1 = zero tangents (straight).
 */
function sampleCatmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number, alpha: number, tension: number): Point {
	const t0 = 0;
	const t1 = t0 + Math.pow(distanceBetween(p0, p1), alpha);
	const t2 = t1 + Math.pow(distanceBetween(p1, p2), alpha);
	const t3 = t2 + Math.pow(distanceBetween(p2, p3), alpha);

	const delta = t2 - t1;
	if (delta < 1e-9) return { ...p2, pressure: interpolatePressure(p1, p2, 1) };

	const invT2T0 = t2 - t0 || 1;
	const invT3T1 = t3 - t1 || 1;
	const scale = 1 - tension;

	// Tangent vectors at p1 and p2 (centripetal knot parameterization).
	const m1x = scale * ((p2.x - p0.x) / invT2T0);
	const m1y = scale * ((p2.y - p0.y) / invT2T0);
	const m2x = scale * ((p3.x - p1.x) / invT3T1);
	const m2y = scale * ((p3.y - p1.y) / invT3T1);

	// Cubic Hermite basis over [t1, t2].
	const t2_ = t * t;
	const t3_ = t2_ * t;
	const h00 = 2 * t3_ - 3 * t2_ + 1;
	const h10 = t3_ - 2 * t2_ + t;
	const h01 = -2 * t3_ + 3 * t2_;
	const h11 = t3_ - t2_;

	return {
		x: h00 * p1.x + h10 * delta * m1x + h01 * p2.x + h11 * delta * m2x,
		y: h00 * p1.y + h10 * delta * m1y + h01 * p2.y + h11 * delta * m2y,
		pressure: interpolatePressure(p1, p2, t)
	};
}

// ---------------------------------------------------------------------------
// Raster brush tool
// ---------------------------------------------------------------------------

function createRasterBrushTool(): ToolHandler {
	return {
		id: 'pen',
		cursor: 'crosshair',
		onPointerDown(e) {
			const state = get(boardStore);
			const layer = state.layers.find((candidate) => candidate.id === state.activeLayerId);
			if (!layer || layer.mode !== 'raster') return null;
			const size = Math.max(1, state.style.strokeWidth || 1);
			const color = state.style.strokeColor;
			const opacity = state.style.opacity ?? 1;
			const hardness = state.style.hardness ?? 1;
			const eraser = false;
			let lastX = e.boardX;
			let lastY = e.boardY;
			beginRasterStroke(layer.id);
			paintRasterDab(layer.id, lastX, lastY, size, color, opacity, hardness, e.pressure, eraser);
			return {
				onPointerMove(ev) {
					paintRasterSegment(layer.id, lastX, lastY, ev.boardX, ev.boardY, size, color, opacity, hardness, ev.pressure, eraser);
					lastX = ev.boardX;
					lastY = ev.boardY;
				},
				onPointerUp() {
					void commitRasterLayer(state.boardId, layer.id);
				},
				getPreview() { return null; },
				getSelectionRect() { return null; }
			};
		}
	};
}

// ---------------------------------------------------------------------------
// Pen tool
// ---------------------------------------------------------------------------

export function createPenTool(): ToolHandler {
	const activeState = get(boardStore);
	const activeLayer = activeState.layers.find((layer) => layer.id === activeState.activeLayerId);
	if (activeLayer?.mode === 'raster') return createRasterBrushTool();

	return {
		id: 'pen',
		cursor: 'crosshair',
		onPointerDown(e) {
			const state = get(boardStore);
			const base = makeBase(state.style, 'stroke', e.boardX, e.boardY, state.elements);
			const MIN_POINT_DIST = 1.5; // thinning in board space
			const raw: Point[] = [{ x: e.boardX, y: e.boardY, pressure: e.pressure }];
			const smoothed = () => smoothStrokePoints(raw);
			let preview: StrokeElement = { ...base, points: smoothed() };

			return {
				onPointerMove(e) {
					const last = raw[raw.length - 1];
					const dx = e.boardX - last.x;
					const dy = e.boardY - last.y;
					if (dx * dx + dy * dy >= MIN_POINT_DIST * MIN_POINT_DIST) {
						raw.push({ x: e.boardX, y: e.boardY, pressure: e.pressure });
					}
					preview = { ...preview, points: smoothed() };
				},
				onPointerUp() {
					const points = smoothStrokePoints(raw);
					const bbox = computeStrokeBBox(points);
					const el: StrokeElement = {
						...base,
						...bbox,
						points
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
			if (toolType === 'rect') (base as any).borderRadius = typeof state.style.borderRadius === 'number' ? state.style.borderRadius : 0;
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
// Math tool
// ---------------------------------------------------------------------------

export interface MathPlacement {
	x: number;
	y: number;
	style: BoardStyle;
	elementId: string;
	maxZ: number;
	layerId: string;
}

let mathPlacementCallback: ((placement: MathPlacement) => void) | null = null;

export function onMathPlacement(cb: (placement: MathPlacement) => void): () => void {
	mathPlacementCallback = cb;
	return () => { mathPlacementCallback = null; };
}

export function createMathTool(): ToolHandler {
	return {
		id: 'math',
		cursor: 'text',
		onPointerDown(e) {
			const state = get(boardStore);
			const activeLayerId = resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId);
			const maxZ = state.elements
				.filter((element) => element.layerId === activeLayerId)
				.reduce((m, el) => Math.max(m, el.zIndex), 0);
			if (mathPlacementCallback) {
				mathPlacementCallback({
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

/**
 * Build a MathElement at the given placement from LaTeX + font size. Width and
 * height come from measureMathElement so the element's bbox matches the
 * rendered glyph (selection, hit-testing, export). Warms the render cache.
 */
export function buildMathElement(placement: MathPlacement, latex: string, fontSize: number): MathElement {
	const trimmed = latex.trim();
	const size = measureMathElement(trimmed, fontSize);
	const style = placement.style;
	const el: MathElement = {
		id: placement.elementId,
		type: 'math',
		x: placement.x,
		y: placement.y,
		width: size.width,
		height: size.height,
		rotation: 0,
		zIndex: placement.maxZ,
		layerId: placement.layerId,
		opacity: typeof style.opacity === 'number' ? style.opacity : 1,
		strokeColor: style.strokeColor,
		strokeWidth: style.strokeWidth,
		fillColor: style.fillColor,
		createdBy: '',
		updatedAt: Date.now(),
		locked: false,
		latex: trimmed,
		fontSize
	};
	preloadMathElement(trimmed, fontSize);
	return el;
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

					// Check if clicking a resize/rotate handle on current selection
					if (state.selection.size > 0) {
						const selectedEls = state.elements.filter((el) => state.selection.has(el.id));
						const selBBox = getSelectionBBox(selectedEls);
						if (selBBox) {
							const handles = getSelectionHandles(selBBox, vp, 12);
							const hitHandle = hitTestHandle(handles, e.screenX, e.screenY, 22);
							if (hitHandle) {
								if (hitHandle.position === 'rotate') {
									return createRotateInteraction(selectedEls, selBBox, e);
								}
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
	let didStartMove = false;
	let baseline: Map<string, { type: string; x: number; y: number; points: Point[] | null }> | null = null;
	let pending: Array<{ id: string; partial: Partial<BoardElement> }> = [];
	let rafId: number | null = null;

	function flush() {
		rafId = null;
		if (pending.length === 0) return;
		boardStore.updateElementsBatch(pending, { recordHistory: false });
		pending = [];
	}
	function schedule() {
		if (rafId == null) rafId = requestAnimationFrame(flush);
	}

	return {
		onPointerMove(e) {
			if (!didStartMove) {
				boardStore.pushHistoryCheckpoint();
				didStartMove = true;
				const state = get(boardStore);
				baseline = new Map();
				for (const id of state.selection) {
					const el = state.elements.find((x) => x.id === id);
					if (!el) continue;
					baseline.set(id, {
						type: el.type,
						x: el.x,
						y: el.y,
						points: el.type === 'stroke' ? el.points.map((p) => ({ ...p })) : null
					});
				}
			}
			if (!baseline) return;

			const totalDx = e.boardX - startEvent.boardX;
			const totalDy = e.boardY - startEvent.boardY;
			if (Math.abs(totalDx) < 0.001 && Math.abs(totalDy) < 0.001) return;

			pending = [];
			for (const [id, base] of baseline) {
				if (base.type === 'stroke' && base.points) {
					const pts = base.points.map((p) => ({ ...p, x: p.x + totalDx, y: p.y + totalDy }));
					pending.push({ id, partial: { x: base.x + totalDx, y: base.y + totalDy, points: pts } as Partial<BoardElement> });
				} else {
					pending.push({ id, partial: { x: base.x + totalDx, y: base.y + totalDy } });
				}
			}
			schedule();
		},
		onPointerUp() {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			flush();
		},
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

	let pending: Array<{ id: string; partial: Partial<BoardElement> }> = [];
	let rafId: number | null = null;

	function flush() {
		rafId = null;
		if (pending.length === 0) return;
		boardStore.updateElementsBatch(pending, { recordHistory: false });
		pending = [];
	}
	function schedule() {
		if (rafId == null) rafId = requestAnimationFrame(flush);
	}

	return {
		onPointerMove(e) {
			const dx = e.boardX - startBX;
			const dy = e.boardY - startBY;
			if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
			if (!didStartResize) {
				boardStore.pushHistoryCheckpoint();
				didStartResize = true;
			}

			// Shift = uniform scale
			const uniformScale = e.shiftKey || handle === 'se' || handle === 'sw' || handle === 'ne' || handle === 'nw';

			let newX = origX, newY = origY, newW = origW, newH = origH;

			if (handle.includes('e')) newW = origW + dx;
			if (handle.includes('w')) { newX = origX + dx; newW = origW - dx; }
			if (handle.includes('s')) newH = origH + dy;
			if (handle.includes('n')) { newY = origY + dy; newH = origH - dy; }

			// Shift-drag corner handle: uniform scale
			if (uniformScale && (handle === 'se' || handle === 'sw' || handle === 'ne' || handle === 'nw')) {
				const cornerScale = handle.startsWith('s') ? (newH / origH) : ((origH - newH) / origH);
				const dir = handle.startsWith('s') ? 1 : -1;
				const scale = Math.max(0.1, dir === 1 ? newH / origH : origH / Math.max(1, newH));
				// Use the dominant axis for uniform scaling
				const primaryScale = Math.abs(newW / origW) > Math.abs(newH / origH)
					? newW / origW : newH / origH;
				if (handle.startsWith('w')) { newX = origX + origW * (1 - primaryScale); }
				if (handle.startsWith('n')) { newY = origY + origH * (1 - primaryScale); }
				newW = origW * primaryScale;
				newH = origH * primaryScale;
			}

			if (newW < 8) { if (handle.includes('w')) newX = origX + origW - 8; newW = 8; }
			if (newH < 8) { if (handle.includes('n')) newY = origY + origH - 8; newH = 8; }

			// Apply scaled positions to all selected elements
			pending = [];
			for (const orig of origPositions) {
				const nextX = newX + orig.relX * newW;
				const nextY = newY + orig.relY * newH;
				const nextWidth = orig.relW * newW;
				const nextHeight = orig.relH * newH;
				if (orig.type === 'stroke' && orig.originalPoints) {
					const scaleX = origW === 0 ? 1 : newW / origW;
					const scaleY = origH === 0 ? 1 : newH / origH;
					pending.push({
						id: orig.id,
						partial: {
							x: nextX,
							y: nextY,
							width: nextWidth,
							height: nextHeight,
							points: orig.originalPoints.map((point) => ({
								...point,
								x: newX + (point.x - origX) * scaleX,
								y: newY + (point.y - origY) * scaleY
							}))
						} as Partial<BoardElement>
					});
					continue;
				}
				pending.push({
					id: orig.id,
					partial: {
						x: nextX,
						y: nextY,
						width: nextWidth,
						height: nextHeight
					}
				});
			}
			schedule();
		},
		onPointerUp() {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			flush();
		},
		getPreview() { return null; },
		getSelectionRect() { return null; }
	};
}

function createRotateInteraction(
	selectedEls: BoardElement[],
	origBBox: BBox,
	startEvent: ToolPointerEvent
): ToolInteraction {
	const startBX = startEvent.boardX;
	const startBY = startEvent.boardY;
	const origCX = origBBox.x + origBBox.width / 2;
	const origCY = origBBox.y + origBBox.height / 2;
	const startScreenX = startEvent.screenX;
	const startScreenY = startEvent.screenY;
	const state = get(boardStore);
	const vp = state.viewport;
	const startAngle = Math.atan2(startScreenY - vp.y - origCY * vp.zoom, startScreenX - vp.x - origCX * vp.zoom);
	let didStartRotate = false;
	let pending: Array<{ id: string; partial: Partial<BoardElement> }> = [];
	let rafId: number | null = null;

	function flush() {
		rafId = null;
		if (pending.length === 0) return;
		boardStore.updateElementsBatch(pending, { recordHistory: false });
		pending = [];
	}
	function schedule() {
		if (rafId == null) rafId = requestAnimationFrame(flush);
	}

	return {
		onPointerMove(e) {
			if (!didStartRotate) {
				boardStore.pushHistoryCheckpoint();
				didStartRotate = true;
			}
			const dx = e.screenX - startScreenX;
			const dy = e.screenY - startScreenY;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
			const currentAngle = Math.atan2(e.screenY - vp.y - origCY * vp.zoom, e.screenX - vp.x - origCX * vp.zoom);
			let deltaAngle = currentAngle - startAngle;
			// Snap to 15-degree increments when shift is held
			if (e.shiftKey) {
				const snap = Math.PI / 12; // 15 degrees
				deltaAngle = Math.round(deltaAngle / snap) * snap;
			}
			const cos = Math.cos(deltaAngle);
			const sin = Math.sin(deltaAngle);
			pending = [];
			for (const el of selectedEls) {
				const relX = el.x - origCX;
				const relY = el.y - origCY;
				const newX = origCX + relX * cos - relY * sin;
				const newY = origCY + relX * sin + relY * cos;
				if (el.type === 'stroke' && el.points) {
					const pts = el.points.map((p) => ({
						...p,
						x: origCX + (p.x - origCX) * cos - (p.y - origCY) * sin,
						y: origCY + (p.x - origCX) * sin + (p.y - origCY) * cos
					}));
					pending.push({ id: el.id, partial: { x: newX, y: newY, points: pts, rotation: (el.rotation || 0) + deltaAngle } as Partial<BoardElement> });
				} else {
					pending.push({ id: el.id, partial: { x: newX, y: newY, rotation: (el.rotation || 0) + deltaAngle } });
				}
			}
			schedule();
		},
		onPointerUp() {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			flush();
			if (didStartRotate) boardStore.pushHistoryCheckpoint();
		},
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
// Eraser tool
// ---------------------------------------------------------------------------

function createRasterEraserTool(): ToolHandler {
	return {
		id: 'eraser',
		cursor: 'cell',
		onPointerDown(e) {
			const state = get(boardStore);
			const layer = state.layers.find((candidate) => candidate.id === state.activeLayerId);
			if (!layer || layer.mode !== 'raster') return null;
			const size = Math.max(4, state.style.strokeWidth || 1);
			const hardness = state.style.hardness ?? 1;
			const opacity = state.style.opacity ?? 1;
			let lastX = e.boardX;
			let lastY = e.boardY;
			beginRasterStroke(layer.id);
			paintRasterDab(layer.id, lastX, lastY, size, '#000', opacity, hardness, e.pressure, true);
			return {
				onPointerMove(ev) {
					paintRasterSegment(layer.id, lastX, lastY, ev.boardX, ev.boardY, size, '#000', opacity, hardness, ev.pressure, true);
					lastX = ev.boardX;
					lastY = ev.boardY;
				},
				onPointerUp() { void commitRasterLayer(state.boardId, layer.id); },
				getPreview() { return null; },
				getSelectionRect() { return null; }
			};
		}
	};
}

export function createEraserTool(): ToolHandler {
	const activeState = get(boardStore);
	const activeLayer = activeState.layers.find((layer) => layer.id === activeState.activeLayerId);
	if (activeLayer?.mode === 'raster') return createRasterEraserTool();
	const ERASER_RADIUS = 20; // board-space radius

	return {
		id: 'eraser',
		cursor: 'cell',
		onPointerDown(e) {
			return {
				onPointerMove(ev) {
					const state = get(boardStore);
					const eraserX = ev.boardX;
					const eraserY = ev.boardY;
					const toDelete: string[] = [];

					// hitTestElement covers every element type: stroke points,
					// line/arrow segments, and bbox shapes (rect/ellipse/text/
					// image/math). Touching a shape deletes the whole element.
					for (const el of state.elements) {
						if (el.locked) continue;
						if (hitTestElement(el, eraserX, eraserY, ERASER_RADIUS)) {
							toDelete.push(el.id);
						}
					}

					if (toDelete.length > 0) {
						boardStore.deleteElements(toDelete);
					}
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

export function getToolHandler(toolType: ToolType | 'math'): ToolHandler {
	switch (toolType) {
		case 'pen': return createPenTool();
		case 'line': return createLineTool();
		case 'rect': return createRectTool();
		case 'ellipse': return createEllipseTool();
		case 'arrow': return createArrowTool();
		case 'text': return createTextTool();
		case 'math': return createMathTool();
		case 'eraser': return createEraserTool();
		case 'select': return createSelectTool();
		case 'pan': return createPanTool();
		default: return createPenTool();
	}
}
