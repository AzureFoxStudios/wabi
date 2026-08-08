import type { WhiteboardViewport } from './boardTypes';
import type { BoardElement, Point, StrokeElement } from './elementTypes';
import type { BBox, Handle } from './coords';
import { boardToScreen } from './coords';
import type { WhiteboardLayer } from './boardTypes';
import { sortWhiteboardLayers, WHITEBOARD_BLEND_MODES } from './layers';
import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { strokeWidthAt } from './tools';

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
	width: number;
	height: number;
	dpr: number;
}

// Cached per-layer offscreen canvases, keyed by layer id. Recreated only when
// a layer id is new or the canvas dimensions change; callers trigger full
// re-renders on element/layer changes (existing render loop).
const layerCanvasCache = new Map<string, LayerOffscreen>();

function getLayerCanvas(layerId: string, width: number, height: number, dpr: number): LayerOffscreen {
	const cached = layerCanvasCache.get(layerId);
	if (cached && cached.width === width && cached.height === height && cached.dpr === dpr) {
		return cached;
	}
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width * dpr));
	canvas.height = Math.max(1, Math.round(height * dpr));
	const entry: LayerOffscreen = { canvas, ctx: canvas.getContext('2d')!, width, height, dpr };
	layerCanvasCache.set(layerId, entry);
	return entry;
}

/**
 * Draw a flat list of elements (no layer filtering) into a transformed context.
 * Elements are sorted by zIndex within the group; each element's own opacity is
 * applied via globalAlpha. Used by renderLayersWithBlend to rasterize a single
 * layer onto its offscreen canvas.
 */
function drawElementsToCtx(ctx: CanvasRenderingContext2D, els: BoardElement[], viewport: WhiteboardViewport): void {
	ctx.save();
	ctx.scale(viewport.zoom, viewport.zoom);
	ctx.translate(-viewport.x, -viewport.y);
	const sorted = [...els].sort((a, b) => a.zIndex - b.zIndex);
	for (const el of sorted) {
		ctx.globalAlpha = Math.max(0, Math.min(1, el.opacity ?? 1));
		switch (el.type) {
			case 'stroke': renderStroke(ctx, el); break;
			case 'line': renderLine(ctx, el); break;
			case 'rect': renderRect(ctx, el); break;
			case 'ellipse': renderEllipse(ctx, el); break;
			case 'arrow': renderArrow(ctx, el); break;
			case 'text': renderText(ctx, el); break;
			case 'image': renderImage(ctx, el); break;
		}
	}
	ctx.globalAlpha = 1;
	ctx.restore();
}

/**
 * Bottom-to-top layer compositing with per-layer opacity + blend mode.
 *
 * Each visible layer is rasterized to its cached offscreen canvas (dpr-scaled),
 * then composited onto the main context with globalAlpha = layer.opacity and
 * globalCompositeOperation = layer.blendMode. The grid is intentionally NOT part
 * of any layer — render it on the main canvas before calling this.
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
	// (source-over), mirroring renderElements' layer-order 0 default.
	if (orphaned.length > 0) {
		drawElementsToCtx(ctx, orphaned, viewport);
	}

	for (const layer of sortWhiteboardLayers(layers)) {
		if (layer.visible === false) continue;
		const els = byLayer.get(layer.id);
		if (!els || els.length === 0) continue;

		const off = getLayerCanvas(layer.id, canvasW, canvasH, dpr);
		off.ctx.clearRect(0, 0, off.canvas.width, off.canvas.height);
		drawElementsToCtx(off.ctx, els, viewport);

		ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity ?? 1));
		ctx.globalCompositeOperation = (WHITEBOARD_BLEND_MODES.includes(
			layer.blendMode as (typeof WHITEBOARD_BLEND_MODES)[number]
		)
			? layer.blendMode
			: 'source-over') as GlobalCompositeOperation;
		ctx.drawImage(off.canvas, 0, 0, canvasW, canvasH);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';
	}

	// Drop cached offscreens for layers that no longer exist.
	for (const id of layerCanvasCache.keys()) {
		if (!layerIds.has(id)) layerCanvasCache.delete(id);
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
	ctx.beginPath();
	ctx.moveTo(el.x, el.y);
	ctx.lineTo(el.x + el.width, el.y + el.height);
	ctx.stroke();
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
		ctx.stroke();
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
		ctx.stroke();
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
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();

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

function renderImage(ctx: CanvasRenderingContext2D, el: BoardElement): void {
	const ie = el as any;
	const img = preloadImage(ie.src);
	if (img.complete && img.naturalWidth > 0) {
		ctx.drawImage(img, el.x, el.y, el.width, el.height);
	} else {
		// Placeholder while loading
		ctx.strokeStyle = el.strokeColor;
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 4]);
		ctx.strokeRect(el.x, el.y, el.width, el.height);
		ctx.setLineDash([]);
	}
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export function renderGrid(ctx: CanvasRenderingContext2D, viewport: WhiteboardViewport, w: number, h: number, gridSize: number): void {
	const effectiveGrid = gridSize * viewport.zoom;
	if (effectiveGrid < 6) return; // Too dense

	const startX = -(viewport.x * viewport.zoom) % effectiveGrid;
	const startY = -(viewport.y * viewport.zoom) % effectiveGrid;
	const majorEvery = effectiveGrid * 5;
	const majorOffsetX = -(viewport.x * viewport.zoom) % majorEvery;
	const majorOffsetY = -(viewport.y * viewport.zoom) % majorEvery;

	ctx.save();
	ctx.lineWidth = 1;
	ctx.strokeStyle = 'rgba(100, 116, 139, 0.14)';
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

	ctx.strokeStyle = 'rgba(71, 85, 105, 0.24)';
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
	const size = 8;
	for (const h of handles) {
		ctx.fillStyle = '#ffffff';
		ctx.strokeStyle = '#6366f1';
		ctx.lineWidth = 1.5;
		ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
		ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
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

		// Cursor dot
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(screen.x, screen.y, 4, 0, Math.PI * 2);
		ctx.fill();

		// Username label
		ctx.font = '11px sans-serif';
		const tw = ctx.measureText(c.username).width;
		const lx = screen.x + 8;
		const ly = screen.y - 6;
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.85;
		const pad = 3;
		ctx.beginPath();
		ctx.roundRect(lx - pad, ly - 11 - pad, tw + pad * 2, 14 + pad, 4);
		ctx.fill();
		ctx.globalAlpha = 1;
		ctx.fillStyle = '#ffffff';
		ctx.fillText(c.username, lx, ly);
	}
}
