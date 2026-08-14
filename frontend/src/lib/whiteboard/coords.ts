import type { WhiteboardViewport } from './boardTypes';
import type { WhiteboardLayer } from './boardTypes';
import type { BoardElement, Point } from './elementTypes';

// ---------------------------------------------------------------------------
// Viewport transforms
// ---------------------------------------------------------------------------

export function boardToScreen(bx: number, by: number, vp: WhiteboardViewport): { x: number; y: number } {
	return { x: (bx - vp.x) * vp.zoom, y: (by - vp.y) * vp.zoom };
}

export function screenToBoard(sx: number, sy: number, vp: WhiteboardViewport): { x: number; y: number } {
	return { x: sx / vp.zoom + vp.x, y: sy / vp.zoom + vp.y };
}

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

export interface BBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function getElementBBox(el: BoardElement): BBox {
	if (el.type === 'stroke' && el.points.length > 0) {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const p of el.points) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}
	return { x: el.x, y: el.y, width: el.width, height: el.height };
}

export function getSelectionBBox(elements: BoardElement[]): BBox | null {
	if (elements.length === 0) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const el of elements) {
		const b = getElementBBox(el);
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(px - ax, py - ay);
	let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitTestElement(el: BoardElement, px: number, py: number, tolerance: number): boolean {
	if (el.type === 'stroke') {
		const pts = el.points;
		for (let i = 0; i < pts.length - 1; i++) {
			if (distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tolerance) {
				return true;
			}
		}
		if (pts.length === 1 && Math.hypot(px - pts[0].x, py - pts[0].y) <= tolerance) {
			return true;
		}
		return false;
	}

	// For line/arrow, test against the line segment
	if (el.type === 'line' || el.type === 'arrow') {
		const x2 = el.x + el.width;
		const y2 = el.y + el.height;
		return distToSegment(px, py, el.x, el.y, x2, y2) <= tolerance;
	}

	// For shapes with fill, test bbox
	const bbox = getElementBBox(el);
	const pad = tolerance;
	return (
		px >= bbox.x - pad &&
		px <= bbox.x + bbox.width + pad &&
		py >= bbox.y - pad &&
		py <= bbox.y + bbox.height + pad
	);
}

export function pickElement(
	elements: BoardElement[],
	px: number,
	py: number,
	tolerance: number,
	layers: WhiteboardLayer[] = []
): BoardElement | null {
	let best: BoardElement | null = null;
	let bestZ = -Infinity;
	for (const el of elements) {
		if (el.locked) continue;
		const layer = layers.find((candidate) => candidate.id === el.layerId);
		if (layer && layer.visible === false) continue;
		if (hitTestElement(el, px, py, tolerance) && el.zIndex > bestZ) {
			best = el;
			bestZ = el.zIndex;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Selection handles
// ---------------------------------------------------------------------------

export type HandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export interface Handle {
	position: HandlePosition;
	x: number;
	y: number;
}

export function getSelectionHandles(bbox: BBox, vp: WhiteboardViewport, size: number): Handle[] {
	const tl = boardToScreen(bbox.x, bbox.y, vp);
	const br = boardToScreen(bbox.x + bbox.width, bbox.y + bbox.height, vp);
	const mx = (tl.x + br.x) / 2;
	const my = (tl.y + br.y) / 2;
	const cx = (tl.x + br.x) / 2;
	const cy = (tl.y + br.y) / 2;
	const rotDist = Math.max(40, Math.hypot(br.x - tl.x, br.y - tl.y) / 2 + 16);
	const rotX = cx;
	const rotY = cy - rotDist;
	return [
		{ position: 'nw', x: tl.x, y: tl.y },
		{ position: 'n', x: mx, y: tl.y },
		{ position: 'ne', x: br.x, y: tl.y },
		{ position: 'e', x: br.x, y: my },
		{ position: 'se', x: br.x, y: br.y },
		{ position: 's', x: mx, y: br.y },
		{ position: 'sw', x: tl.x, y: br.y },
		{ position: 'w', x: tl.x, y: my },
		{ position: 'rotate', x: rotX, y: rotY }
	];
}

export function hitTestHandle(handles: Handle[], sx: number, sy: number, size: number): Handle | null {
	let best: Handle | null = null;
	let bestDist = Infinity;
	const radius = Math.max(10, size / 2);
	for (const h of handles) {
		const dist = Math.hypot(sx - h.x, sy - h.y);
		if (dist <= radius && dist < bestDist) {
			best = h;
			bestDist = dist;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function normalizeRect(x: number, y: number, w: number, h: number): BBox {
	return {
		x: w < 0 ? x + w : x,
		y: h < 0 ? y + h : y,
		width: Math.abs(w),
		height: Math.abs(h)
	};
}

export function clampZoom(zoom: number): number {
	return Math.max(0.1, Math.min(10, zoom));
}
