import type { WhiteboardViewport } from './boardTypes';
import type { BoardElement, Point, StrokeElement, MathElement } from './elementTypes';
import type { BBox, Handle } from './coords';
import { boardToScreen } from './coords';
import type { WhiteboardLayer } from './boardTypes';
import { sortWhiteboardLayers, WHITEBOARD_BLEND_MODES } from './layers';
import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { strokeWidthAt } from './tools';
import { renderMathToCanvas } from './mathRender';
import { renderRasterLayer } from './rasterLayers';

// ---------------------------------------------------------------------------
// Image cache (module-level, shared across renders)
// ---------------------------------------------------------------------------

const imageCache = new Map<string, HTMLImageElement>();
const imageLoadCache = new Map<string, Promise<void>>();

function resolveImageUrl(src: string): string {
	try {
		return new URL(src, getServerUrl()).toString();
	} catch {
		return src;
	}
}

function isProtectedWhiteboardImage(src: string): boolean {
	try {
		const resolved = new URL(resolveImageUrl(src));
		return /\/api\/whiteboard\/boards\/[^/]+\/files\/[^/]+$/.test(resolved.pathname);
	} catch {
		return false;
	}
}

async function loadProtectedImage(img: HTMLImageElement, src: string): Promise<void> {
	const token = getAuthToken();
	const sessionId = token ? null : getGuestSessionId();
	const headers: HeadersInit = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (!token && sessionId) {
		headers['X-Session-Id'] = sessionId;
	}

	const response = await fetch(resolveImageUrl(src), {
		method: 'GET',
		headers
	});
	if (!response.ok) {
		throw new Error(`Failed to load protected whiteboard image (${response.status})`);
	}
	const blob = await response.blob();
	const objectUrl = URL.createObjectURL(blob);
	img.onload = () => {
		URL.revokeObjectURL(objectUrl);
	};
	img.onerror = () => {
		URL.revokeObjectURL(objectUrl);
	};
	img.src = objectUrl;
}

export function preloadImage(src: string): HTMLImageElement {
	let img = imageCache.get(src);
	if (!img) {
		img = new Image();
		if (!isProtectedWhiteboardImage(src)) {
			img.crossOrigin = 'anonymous';
			img.src = src;
		}
		imageCache.set(src, img);
	}
	if (isProtectedWhiteboardImage(src) && !img.src && !imageLoadCache.has(src)) {
		imageLoadCache.set(
			src,
			loadProtectedImage(img, src)
				.catch((error) => {
					console.warn('[Whiteboard] Failed to preload protected image:', error);
				})
				.finally(() => {
					imageLoadCache.delete(src);
				})
		);
	}
	return img;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderElements(
	ctx: CanvasRenderingContext2D,
	elements: BoardElement[],
	viewport: WhiteboardViewport,
	layers: WhiteboardLayer[] = []
): void {
	ctx.save();
	ctx.scale(viewport.zoom, viewport.zoom);
	ctx.translate(-viewport.x, -viewport.y);

	const layerOrder = new Map<string, number>();
	const layerOpacity = new Map<string, number>();
	const visibleLayers = new Map<string, WhiteboardLayer>();
	for (const layer of sortWhiteboardLayers(layers)) {
		layerOrder.set(layer.id, layer.order);
		layerOpacity.set(layer.id, layer.opacity);
		visibleLayers.set(layer.id, layer);
	}
	const sorted = [...elements].sort((a, b) => {
		const aLayer = layerOrder.get(a.layerId || '') ?? 0;
		const bLayer = layerOrder.get(b.layerId || '') ?? 0;
		if (aLayer !== bLayer) return aLayer - bLayer;
		return a.zIndex - b.zIndex;
	});
	for (const el of sorted) {
		const layer = visibleLayers.get(el.layerId || '') || null;
		if (layer && layer.visible === false) continue;
		ctx.globalAlpha = Math.max(0, Math.min(1, el.opacity * (layer ? layerOpacity.get(layer.id) ?? 1 : 1)));
		switch (el.type) {
			case 'stroke': renderStroke(ctx, el); break;
			case 'line': renderLine(ctx, el); break;
			case 'rect': renderRect(ctx, el); break;
			case 'ellipse': renderEllipse(ctx, el); break;
			case 'arrow': renderArrow(ctx, el); break;
			case 'text': renderText(ctx, el); break;
			case 'image': renderImage(ctx, el); break;
			case 'math': renderMath(ctx, el); break;
		}
	}
	ctx.globalAlpha = 1;
	ctx.restore();
}

// ---------------------------------------------------------------------------
// Layer blend compositing (canonical render path)
// ---------------------------------------------------------------------------

interface LayerOffscreen {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	// Backing pixel dimensions of the bitmap.
	pxW: number;
	pxH: number;
	dpr: number;
	// Board-space rectangle this bitmap covers (top-left origin + size, board units).
	originX: number;
	originY: number;
	contentW: number;
	contentH: number;
	blendMode: string;
	contentKey: string;
	// Monotonic clock for LRU eviction.
	lastUsed: number;
}

// Cached per-layer offscreen canvases, keyed by layer id. Each bitmap holds a
// layer's vector content rasterized in BOARD space (independent of the current
// viewport), so pan/zoom only re-blits the cached bitmap instead of
// re-rasterizing. The cache key is content identity only (see contentKey
// construction in renderLayersWithBlend), never the viewport.
const layerCanvasCache = new Map<string, LayerOffscreen>();

// Extra board-space padding around a layer's content bbox so strokes / soft
// edges / shadows are never clipped by the bitmap boundary.
const LAYER_MARGIN = 256;

// Cap on simultaneously cached layer bitmaps; least-recently-used are evicted.
const MAX_CACHED_LAYER_BITMAPS = 8;

let layerCacheClock = 0;

function getLayerCanvas(
	layerId: string,
	pxW: number,
	pxH: number,
	dpr: number,
	originX: number,
	originY: number,
	contentW: number,
	contentH: number,
	blendMode: string
): LayerOffscreen {
	const cached = layerCanvasCache.get(layerId);
	if (
		cached &&
		cached.pxW === pxW &&
		cached.pxH === pxH &&
		cached.dpr === dpr &&
		cached.originX === originX &&
		cached.originY === originY &&
		cached.contentW === contentW &&
		cached.contentH === contentH &&
		cached.blendMode === blendMode
	) {
		return cached;
	}
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(pxW));
	canvas.height = Math.max(1, Math.round(pxH));
	const entry: LayerOffscreen = {
		canvas,
		ctx: canvas.getContext('2d')!,
		pxW,
		pxH,
		dpr,
		originX,
		originY,
		contentW,
		contentH,
		blendMode,
		contentKey: '',
		lastUsed: ++layerCacheClock
	};
	layerCanvasCache.set(layerId, entry);
	enforceLayerCacheCap();
	return entry;
}

function enforceLayerCacheCap(): void {
	if (layerCanvasCache.size <= MAX_CACHED_LAYER_BITMAPS) return;
	const entries = [...layerCanvasCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
	const toEvict = layerCanvasCache.size - MAX_CACHED_LAYER_BITMAPS;
	for (let i = 0; i < toEvict && i < entries.length; i++) {
		layerCanvasCache.delete(entries[i][0]);
	}
}

/**
 * Draw a flat, zIndex-sorted list of elements into the current context using
 * the element renderers. Each element's own opacity is applied via globalAlpha.
 * Shared by both the viewport-based orphan path and the board-space layer
 * rasterizer, so cached bitmaps are pixel-identical to a direct draw.
 */
function drawSortedElements(ctx: CanvasRenderingContext2D, els: BoardElement[]): void {
	const sorted = [...els].sort((a, b) => a.zIndex - b.zIndex);
	for (const el of sorted) {
		ctx.globalAlpha = Math.max(0, Math.min(1, el.opacity ?? 1));
		// Locked element indicator: diagonal strike-through
		if (el.locked) {
			ctx.strokeStyle = 'rgba(255,255,255,0.45)';
			ctx.lineWidth = 1;
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.moveTo(el.x + 2, el.y + 2);
			ctx.lineTo(el.x + (el.width || 0) - 2, el.y + (el.height || 0) - 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(el.x + (el.width || 0) - 2, el.y + 2);
			ctx.lineTo(el.x + 2, el.y + (el.height || 0) - 2);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		switch (el.type) {
			case 'stroke': renderStroke(ctx, el); break;
			case 'line': renderLine(ctx, el); break;
			case 'rect': renderRect(ctx, el); break;
			case 'ellipse': renderEllipse(ctx, el); break;
			case 'arrow': renderArrow(ctx, el); break;
			case 'text': renderText(ctx, el); break;
			case 'image': renderImage(ctx, el); break;
			case 'math': renderMath(ctx, el); break;
		}
	}
	ctx.globalAlpha = 1;
}

/**
 * Draw a flat list of elements (no layer filtering) into a viewport-transformed
 * context. Used for orphaned elements (those whose layerId no longer resolves),
 * drawn directly onto the already-dpr-scaled main context, so dpr = 1 here.
 */
function drawElementsToCtx(
	ctx: CanvasRenderingContext2D,
	els: BoardElement[],
	viewport: WhiteboardViewport,
	dpr = 1
): void {
	ctx.save();
	ctx.scale(dpr, dpr);
	ctx.scale(viewport.zoom, viewport.zoom);
	ctx.translate(-viewport.x, -viewport.y);
	drawSortedElements(ctx, els);
	ctx.restore();
}

/**
 * Compute the board-space bounding box of a single element. Strokes use their
 * point cloud; all other element types use their x/y/width/height rect (which
 * may have negative extents, e.g. ellipses). A small pad guards stroke width
 * and soft-edge shadow bleed; the layer-level LAYER_MARGIN provides the bulk of
 * the safety margin.
 */
function getElementBBox(el: BoardElement): { minX: number; minY: number; maxX: number; maxY: number } {
	if (el.type === 'stroke') {
		const pts = (el as StrokeElement).points;
		if (pts.length === 0) {
			return { minX: el.x, minY: el.y, maxX: el.x + (el.width || 0), maxY: el.y + (el.height || 0) };
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of pts) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		const size = el.strokeWidth || 1;
		const hardness = typeof el.hardness === 'number' ? Math.max(0, Math.min(1, el.hardness)) : 1;
		const soft = hardness < 0.999 ? (1 - hardness) * size * 2 : 0;
		const pad = size / 2 + soft;
		return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
	}
	const x = el.x;
	const y = el.y;
	const w = el.width || 0;
	const h = el.height || 0;
	const minX = Math.min(x, x + w);
	const maxX = Math.max(x, x + w);
	const minY = Math.min(y, y + h);
	const maxY = Math.max(y, y + h);
	const pad = (el.type === 'line' || el.type === 'arrow') ? (el.strokeWidth || 1) / 2 : 0;
	return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function computeLayerBBox(els: BoardElement[]): { minX: number; minY: number; maxX: number; maxY: number } {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const el of els) {
		const b = getElementBBox(el);
		if (b.minX < minX) minX = b.minX;
		if (b.minY < minY) minY = b.minY;
		if (b.maxX > maxX) maxX = b.maxX;
		if (b.maxY > maxY) maxY = b.maxY;
	}
	if (!Number.isFinite(minX)) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Rasterize a layer's elements into BOARD space: scale by dpr, then translate so
 * the layer's bitmap origin (originX/originY, already including LAYER_MARGIN)
 * maps to bitmap pixel (0,0). The viewport is intentionally NOT applied — pan/zoom
 * are handled at composite time by transforming the cached bitmap.
 */
function rasterizeLayerToCanvas(
	ctx: CanvasRenderingContext2D,
	els: BoardElement[],
	originX: number,
	originY: number,
	dpr: number
): void {
	ctx.save();
	ctx.scale(dpr, dpr);
	ctx.translate(-originX, -originY);
	drawSortedElements(ctx, els);
	ctx.restore();
}

/**
 * Bottom-to-top layer compositing with per-layer opacity + blend mode.
 *
 * Each visible vector layer is rasterized into a BOARD-space offscreen bitmap
 * (sized to the layer's content bbox + LAYER_MARGIN, dpr-scaled) the first time
 * its content identity changes, then cached. At composite time the cached bitmap
 * is transformed by the current viewport and blitted — so pan/zoom only re-blits,
 * it never re-rasterizes. Layer opacity is applied via globalAlpha at composite
 * time (never baked into the cache key), so the opacity slider recomposites
 * without re-rasterizing. The grid is intentionally NOT part of any layer —
 * render it on the main canvas before calling this.
 */
export function renderLayersWithBlend(
	ctx: CanvasRenderingContext2D,
	elements: BoardElement[],
	viewport: WhiteboardViewport,
	layers: WhiteboardLayer[],
	canvasW: number,
	canvasH: number,
	dpr: number
): void {
	const layerIds = new Set(layers.map((layer) => layer.id));
	const orphaned: BoardElement[] = [];
	const byLayer = new Map<string, BoardElement[]>();
	for (const el of elements) {
		const lid = el.layerId || '';
		if (!layerIds.has(lid)) {
			orphaned.push(el);
			continue;
		}
		let bucket = byLayer.get(lid);
		if (!bucket) {
			bucket = [];
			byLayer.set(lid, bucket);
		}
		bucket.push(el);
	}

	// Elements whose layerId no longer resolves to a layer render at the bottom
	// (source-over), mirroring renderElements' layer-order 0 default. Drawn onto
	// the already-dpr-scaled main context, so dpr = 1 here.
	if (orphaned.length > 0) {
		drawElementsToCtx(ctx, orphaned, viewport, 1);
	}

	for (const layer of sortWhiteboardLayers(layers)) {
		if (layer.visible === false) continue;
		const els = byLayer.get(layer.id);
		if (layer.mode === 'raster') {
			// Raster-layer path is unchanged: drawn directly to the main context.
			ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
			ctx.globalCompositeOperation = (WHITEBOARD_BLEND_MODES.includes(layer.blendMode as (typeof WHITEBOARD_BLEND_MODES)[number])
				? layer.blendMode
				: 'source-over') as GlobalCompositeOperation;
			renderRasterLayer(ctx, layer.id, viewport);
			ctx.globalAlpha = 1;
			ctx.globalCompositeOperation = 'source-over';
			continue;
		}
		// Empty vector layers allocate no offscreen bitmap.
		if (!els || els.length === 0) continue;

		const blendMode = WHITEBOARD_BLEND_MODES.includes(
			layer.blendMode as (typeof WHITEBOARD_BLEND_MODES)[number]
		)
			? layer.blendMode
			: 'source-over';

		// Content-identity cache key — viewport is deliberately absent so pan/zoom
		// reuse the cached bitmap. Layer opacity is also absent (applied at
		// composite), so the opacity slider recomposites without re-rasterizing.
		const contentKey = `${blendMode}:${dpr}|${els
			.map((el) => `${el.id}:${el.updatedAt}:${el.zIndex}:${el.opacity}:${el.locked}`)
			.join('|')}`;

		const box = computeLayerBBox(els);
		const originX = box.minX - LAYER_MARGIN;
		const originY = box.minY - LAYER_MARGIN;
		const contentW = box.maxX - box.minX + LAYER_MARGIN * 2;
		const contentH = box.maxY - box.minY + LAYER_MARGIN * 2;
		const pxW = Math.max(1, Math.ceil(contentW * dpr));
		const pxH = Math.max(1, Math.ceil(contentH * dpr));

		const off = getLayerCanvas(layer.id, pxW, pxH, dpr, originX, originY, contentW, contentH, blendMode);
		if (off.contentKey !== contentKey) {
			off.ctx.clearRect(0, 0, off.canvas.width, off.canvas.height);
			rasterizeLayerToCanvas(off.ctx, els, originX, originY, dpr);
			off.contentKey = contentKey;
		}
		off.lastUsed = ++layerCacheClock;

		// Composite: the main context is already dpr-scaled by the caller. Apply
		// the viewport transform, then blit the board-space bitmap at its board
		// rect. This is mathematically equivalent to drawing the elements with
		// scale(dpr) · scale(zoom) · translate(-vp) directly — pan/zoom only
		// change this transform, never the cached pixels.
		ctx.save();
		ctx.scale(viewport.zoom, viewport.zoom);
		ctx.translate(-viewport.x, -viewport.y);
		ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
		ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
		ctx.drawImage(off.canvas, originX, originY, contentW, contentH);
		ctx.restore();
	}

	// Drop cached offscreens for layers that no longer exist, AND for layers whose
	// element set became empty this frame (they allocate no bitmap while empty).
	for (const id of [...layerCanvasCache.keys()]) {
		if (!layerIds.has(id)) {
			layerCanvasCache.delete(id);
			continue;
		}
		const bucket = byLayer.get(id);
		if (!bucket || bucket.length === 0) {
			layerCanvasCache.delete(id);
		}
	}
}

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------

function renderStroke(ctx: CanvasRenderingContext2D, el: StrokeElement): void {
	const pts = el.points;
	if (pts.length === 0) return;

	const size = el.strokeWidth || 1;
	const color = el.strokeColor;
	// Backward compatible: hardness defaults to 1 (existing hard-edge behavior).
	const hardness = typeof el.hardness === 'number' ? Math.max(0, Math.min(1, el.hardness)) : 1;

	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	// Soft edge: bloom via shadowBlur when hardness < 1.
	ctx.shadowColor = color;
	ctx.shadowBlur = hardness < 0.999 ? (1 - hardness) * size * 2 : 0;

	if (pts.length === 1) {
		const r = Math.max(0.5, strokeWidthAt(pts[0].pressure, size) / 2);
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.shadowBlur = 0;
		return;
	}

	if (hasPressureData(pts)) {
		drawVariableWidthStroke(ctx, pts, size, color);
	} else {
		ctx.strokeStyle = color;
		ctx.lineWidth = size;
		ctx.beginPath();
		ctx.moveTo(pts[0].x, pts[0].y);
		// Quadratic Bezier through midpoints for smooth curves
		for (let i = 1; i < pts.length - 1; i++) {
			const mx = (pts[i].x + pts[i + 1].x) / 2;
			const my = (pts[i].y + pts[i + 1].y) / 2;
			ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
		}
		ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
		ctx.stroke();
	}

	ctx.shadowBlur = 0;
}

function hasPressureData(pts: Point[]): boolean {
	return pts.some((p) => typeof p.pressure === 'number');
}

/**
 * Draw a stroke whose width follows pressure: width(p) = size * (minSize + (1 - minSize) * p).
 * Each segment is a filled quad (two points offset by the local normal on each side),
 * so adjacent segments never overlap — globalAlpha (element opacity) stays correct.
 * Round caps are stamped at both ends.
 */
function drawVariableWidthStroke(
	ctx: CanvasRenderingContext2D,
	pts: Point[],
	size: number,
	color: string
): void {
	ctx.fillStyle = color;

	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		if (len < 1e-6) continue;

		const nx = -dy / len;
		const ny = dx / len;
		const ra = Math.max(0.25, strokeWidthAt(a.pressure, size) / 2);
		const rb = Math.max(0.25, strokeWidthAt(b.pressure, size) / 2);

		ctx.beginPath();
		ctx.moveTo(a.x + nx * ra, a.y + ny * ra);
		ctx.lineTo(b.x + nx * rb, b.y + ny * rb);
		ctx.lineTo(b.x - nx * rb, b.y - ny * rb);
		ctx.lineTo(a.x - nx * ra, a.y - ny * ra);
		ctx.closePath();
		ctx.fill();
	}

	// Round caps
	for (const end of [pts[0], pts[pts.length - 1]]) {
		const r = Math.max(0.25, strokeWidthAt(end.pressure, size) / 2);
		ctx.beginPath();
		ctx.arc(end.x, end.y, r, 0, Math.PI * 2);
		ctx.fill();
	}
}

function renderLine(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	ctx.strokeStyle = el.strokeColor;
	ctx.lineWidth = el.strokeWidth;
	ctx.lineCap = 'round';
	const dash = (el as any).strokeDash;
	if (dash && dash.length > 0) ctx.setLineDash(dash as number[]);
	ctx.beginPath();
	ctx.moveTo(el.x, el.y);
	ctx.lineTo(el.x + el.width, el.y + el.height);
	ctx.stroke();
	ctx.setLineDash([]);
}

function renderRect(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const r = (el as any).borderRadius || 0;
	ctx.beginPath();
	if (r > 0) {
		ctx.roundRect(el.x, el.y, el.width, el.height, r);
	} else {
		ctx.rect(el.x, el.y, el.width, el.height);
	}
	if (el.fillColor && el.fillColor !== 'transparent') {
		ctx.fillStyle = el.fillColor;
		ctx.fill();
	}
	if (el.strokeWidth > 0) {
		ctx.strokeStyle = el.strokeColor;
		ctx.lineWidth = el.strokeWidth;
		const dash = (el as any).strokeDash;
		if (dash && dash.length > 0) ctx.setLineDash(dash as number[]);
		ctx.stroke();
		ctx.setLineDash([]);
	}
}

function renderEllipse(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const rx = Math.abs(el.width) / 2;
	const ry = Math.abs(el.height) / 2;
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	if (el.fillColor && el.fillColor !== 'transparent') {
		ctx.fillStyle = el.fillColor;
		ctx.fill();
	}
	if (el.strokeWidth > 0) {
		ctx.strokeStyle = el.strokeColor;
		ctx.lineWidth = el.strokeWidth;
		const dash = (el as any).strokeDash;
		if (dash && dash.length > 0) ctx.setLineDash(dash as number[]);
		ctx.stroke();
		ctx.setLineDash([]);
	}
}

function renderArrow(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const x1 = el.x, y1 = el.y;
	const x2 = el.x + el.width, y2 = el.y + el.height;
	const headLen = Math.max(10, el.strokeWidth * 4);
	const angle = Math.atan2(y2 - y1, x2 - x1);

	ctx.strokeStyle = el.strokeColor;
	ctx.lineWidth = el.strokeWidth;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	const dash = (el as any).strokeDash;
	if (dash && dash.length > 0) ctx.setLineDash(dash as number[]);
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.setLineDash([]);

	const arrowHead = (el as any).arrowHead || 'end';
	if (arrowHead === 'end' || arrowHead === 'both') {
		drawArrowHead(ctx, x2, y2, angle, headLen, el.strokeColor);
	}
	if (arrowHead === 'both') {
		drawArrowHead(ctx, x1, y1, angle + Math.PI, headLen, el.strokeColor);
	}
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, len: number, color: string): void {
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(x - len * Math.cos(angle - Math.PI / 6), y - len * Math.sin(angle - Math.PI / 6));
	ctx.lineTo(x - len * Math.cos(angle + Math.PI / 6), y - len * Math.sin(angle + Math.PI / 6));
	ctx.closePath();
	ctx.fill();
}

function renderText(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const te = el as any;
	const fontSize = te.fontSize || 16;
	const fontFamily = te.fontFamily || 'sans-serif';
	ctx.font = `${fontSize}px ${fontFamily}`;
	ctx.fillStyle = el.strokeColor;
	ctx.textAlign = te.textAlign || 'left';
	ctx.textBaseline = 'top';

	const text: string = te.text || '';
	const lines = text.split('\n');
	const lineHeight = fontSize * 1.3;
	for (let i = 0; i < lines.length; i++) {
		let tx = el.x;
		if (te.textAlign === 'center') tx = el.x + el.width / 2;
		else if (te.textAlign === 'right') tx = el.x + el.width;
		ctx.fillText(lines[i], tx, el.y + i * lineHeight);
	}
}

function drawImagePlaceholder(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	ctx.strokeStyle = el.strokeColor;
	ctx.lineWidth = 1;
	ctx.setLineDash([4, 4]);
	ctx.strokeRect(el.x, el.y, el.width, el.height);
	ctx.setLineDash([]);
}

function renderImage(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const ie = el as any;
	const img = preloadImage(ie.src);
	try {
		if (img.complete && img.naturalWidth > 0) {
			ctx.drawImage(img, el.x, el.y, el.width, el.height);
		} else {
			// Placeholder while loading (or when the load never completes).
			drawImagePlaceholder(ctx, el);
		}
	} catch (error) {
		// drawImage can throw on a tainted/failed cross-origin load; never let a
		// single broken image take down the whole render loop.
		drawImagePlaceholder(ctx, el);
	}
}

function renderMath(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const me = el as MathElement;
	// renderElements / drawElementsToCtx already fold the element opacity into
	// globalAlpha. Divide it back out so renderMathToCanvas can multiply the
	// element opacity in (per its signature) without double-applying.
	const layerAlpha = me.opacity > 0 ? ctx.globalAlpha / me.opacity : 1;
	ctx.globalAlpha = Number.isFinite(layerAlpha) ? layerAlpha : 1;
	renderMathToCanvas(ctx, me.latex, me.x, me.y, me.fontSize, me.strokeColor, me.opacity);
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export function renderGrid(ctx: CanvasRenderingContext2D, viewport: WhiteboardViewport, w: number, h: number, gridSize: number): void {
	const effectiveGrid = gridSize * viewport.zoom;
	if (effectiveGrid < 6) return;

	const startX = -(viewport.x * viewport.zoom) % effectiveGrid;
	const startY = -(viewport.y * viewport.zoom) % effectiveGrid;
	const majorEvery = effectiveGrid * 5;
	const majorOffsetX = -(viewport.x * viewport.zoom) % majorEvery;
	const majorOffsetY = -(viewport.y * viewport.zoom) % majorEvery;

	ctx.save();
	ctx.lineWidth = 1;
	ctx.strokeStyle = 'rgba(30, 41, 59, 0.10)';
	for (let x = startX; x < w; x += effectiveGrid) {
		ctx.beginPath();
		ctx.moveTo(Math.round(x) + 0.5, 0);
		ctx.lineTo(Math.round(x) + 0.5, h);
		ctx.stroke();
	}
	for (let y = startY; y < h; y += effectiveGrid) {
		ctx.beginPath();
		ctx.moveTo(0, Math.round(y) + 0.5);
		ctx.lineTo(w, Math.round(y) + 0.5);
		ctx.stroke();
	}

	ctx.strokeStyle = 'rgba(30, 41, 59, 0.22)';
	for (let x = majorOffsetX; x < w; x += majorEvery) {
		ctx.beginPath();
		ctx.moveTo(Math.round(x) + 0.5, 0);
		ctx.lineTo(Math.round(x) + 0.5, h);
		ctx.stroke();
	}
	for (let y = majorOffsetY; y < h; y += majorEvery) {
		ctx.beginPath();
		ctx.moveTo(0, Math.round(y) + 0.5);
		ctx.lineTo(w, Math.round(y) + 0.5);
		ctx.stroke();
	}

	if (effectiveGrid >= 10) {
		ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
		ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
		ctx.textBaseline = 'top';
		for (let x = majorOffsetX; x < w; x += majorEvery) {
			const boardX = Math.round(viewport.x + x / viewport.zoom);
			ctx.fillText(String(boardX), Math.round(x) + 4, 4);
		}
		ctx.textBaseline = 'bottom';
		for (let y = majorOffsetY; y < h; y += majorEvery) {
			const boardY = Math.round(viewport.y + y / viewport.zoom);
			ctx.fillText(String(boardY), 4, Math.round(y) - 2);
		}
	}
	ctx.restore();
}

// ---------------------------------------------------------------------------
// Selection overlays
// ---------------------------------------------------------------------------

export function renderSelectionBox(ctx: CanvasRenderingContext2D, bbox: BBox, viewport: WhiteboardViewport): void {
	const tl = boardToScreen(bbox.x, bbox.y, viewport);
	const br = boardToScreen(bbox.x + bbox.width, bbox.y + bbox.height, viewport);
	const sw = br.x - tl.x;
	const sh = br.y - tl.y;

	ctx.strokeStyle = '#6366f1';
	ctx.lineWidth = 1.5;
	ctx.setLineDash([6, 3]);
	ctx.strokeRect(tl.x, tl.y, sw, sh);
	ctx.setLineDash([]);
}

export function renderHandles(ctx: CanvasRenderingContext2D, handles: Handle[]): void {
	const size = 12;
	for (const h of handles) {
		if (h.position === 'rotate') {
			// Rotate handle: circle with crosshair
			ctx.fillStyle = '#ffffff';
			ctx.strokeStyle = '#6366f1';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(h.x, h.y, size / 2 + 2, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
			// Line from bbox center to rotate handle
			ctx.strokeStyle = 'rgba(99,102,241,0.4)';
			ctx.lineWidth = 1;
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.moveTo(h.x, h.y);
			ctx.lineTo(h.x, h.y + 6);
			ctx.stroke();
			ctx.setLineDash([]);
		} else {
			ctx.fillStyle = '#ffffff';
			ctx.strokeStyle = '#6366f1';
			ctx.lineWidth = 1.5;
			ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
			ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
		}
	}
}

export function renderDrawPreview(
	ctx: CanvasRenderingContext2D,
	previewEl: BoardElement,
	viewport: WhiteboardViewport
): void {
	ctx.save();
	ctx.scale(viewport.zoom, viewport.zoom);
	ctx.translate(-viewport.x, -viewport.y);
	ctx.globalAlpha = previewEl.opacity;
	switch (previewEl.type) {
		case 'stroke': renderStroke(ctx, previewEl); break;
		case 'line': renderLine(ctx, previewEl); break;
		case 'rect': renderRect(ctx, previewEl); break;
		case 'ellipse': renderEllipse(ctx, previewEl); break;
		case 'arrow': renderArrow(ctx, previewEl); break;
		case 'text': renderText(ctx, previewEl); break;
		case 'image': renderImage(ctx, previewEl); break;
		case 'math': renderMath(ctx, previewEl); break;
	}
	ctx.restore();
}

export function renderSelectionRect(ctx: CanvasRenderingContext2D, rect: BBox, viewport: WhiteboardViewport): void {
	const tl = boardToScreen(rect.x, rect.y, viewport);
	const br = boardToScreen(rect.x + rect.width, rect.y + rect.height, viewport);
	ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
	ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
	ctx.lineWidth = 1;
	ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
	ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

// ---------------------------------------------------------------------------
// Remote cursors
// ---------------------------------------------------------------------------

interface RemoteCursor {
	userId: string;
	username: string;
	color: string;
	x: number;
	y: number;
}

export function renderRemoteCursors(ctx: CanvasRenderingContext2D, cursors: RemoteCursor[], viewport: WhiteboardViewport): void {
	for (const c of cursors) {
		const screen = boardToScreen(c.x, c.y, viewport);
		const color = c.color || '#6366f1';

		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.85)';
		ctx.lineWidth = 1.5;
		ctx.stroke();

		ctx.font = '11px sans-serif';
		const tw = ctx.measureText(c.username).width;
		const lx = screen.x + 8;
		const ly = screen.y - 6;
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.88;
		const pad = 3;
		ctx.beginPath();
		ctx.roundRect(lx - pad, ly - 11 - pad, tw + pad * 2, 14 + pad, 4);
		ctx.fill();
		ctx.globalAlpha = 1;
		ctx.fillStyle = '#ffffff';
		ctx.fillText(c.username, lx, ly);
	}
}
