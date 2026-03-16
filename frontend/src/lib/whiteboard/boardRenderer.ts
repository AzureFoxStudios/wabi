import type { WhiteboardViewport } from './boardTypes';
import type { BoardElement, StrokeElement } from './elementTypes';
import type { BBox, Handle } from './coords';
import { boardToScreen } from './coords';
import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';

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
	viewport: WhiteboardViewport
): void {
	ctx.save();
	ctx.scale(viewport.zoom, viewport.zoom);
	ctx.translate(-viewport.x, -viewport.y);

	const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex);
	for (const el of sorted) {
		ctx.globalAlpha = el.opacity;
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
// Element renderers
// ---------------------------------------------------------------------------

function renderStroke(ctx: CanvasRenderingContext2D, el: StrokeElement): void {
	const pts = el.points;
	if (pts.length === 0) return;

	ctx.strokeStyle = el.strokeColor;
	ctx.lineWidth = el.strokeWidth;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.beginPath();

	if (pts.length === 1) {
		ctx.arc(pts[0].x, pts[0].y, el.strokeWidth / 2, 0, Math.PI * 2);
		ctx.fillStyle = el.strokeColor;
		ctx.fill();
		return;
	}

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

	ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
	const dotR = Math.max(0.8, viewport.zoom * 0.8);

	for (let x = startX; x < w; x += effectiveGrid) {
		for (let y = startY; y < h; y += effectiveGrid) {
			ctx.beginPath();
			ctx.arc(x, y, dotR, 0, Math.PI * 2);
			ctx.fill();
		}
	}
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
