import { get } from 'svelte/store';
import { boardStore } from './boardStore';
import { uploadWhiteboardImage } from './imageImports';
import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';

// Bitmap ceiling for a raster (Paint) layer, in device px.
// Dropped from 4096 to 2048: 4x less RAM per layer (2048*2048*4 = 16MB vs
// 4096*4096*4 = 64MB), still sharp for brush work at typical zooms. Painting
// clamps to these bounds (see paintRasterDab), so any dab whose center falls
// outside [0, RASTER_WIDTH] x [0, RASTER_HEIGHT] is skipped before drawImage.
const RASTER_WIDTH = 2048;
const RASTER_HEIGHT = 2048;
const stampCache = new Map<string, HTMLCanvasElement>();
const layerBitmaps = new Map<string, HTMLCanvasElement>();
const hydratingLayers = new Map<string, Promise<void>>();

interface DirtyRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}
const rasterDirtyBounds = new Map<string, DirtyRect>();

// ---------------------------------------------------------------------------
// Raster undo checkpoints
//
// A parallel, independent stack (the vector element stack in boardUndo.ts is
// untouched). One entry per stroke: the pixels that were UNDER the stroke's
// dirty rect before it was painted. pixels === null means the region was blank
// before the stroke — undo clears the rect instead of blitting pixels, which
// keeps fresh-stroke entries from costing 64MB copies.
// ---------------------------------------------------------------------------

interface RasterUndoEntry {
	layerId: string;
	rect: { x: number; y: number; w: number; h: number };
	pixels: ImageData | null;
	bytes: number;
}

const MAX_RASTER_UNDO_ENTRIES = 30;
const MAX_RASTER_UNDO_BYTES = 8 * 1024 * 1024;

let rasterUndoStack: RasterUndoEntry[] = [];
let rasterRedoStack: RasterUndoEntry[] = [];

function pushRasterUndoEntry(entry: RasterUndoEntry): void {
	rasterUndoStack.push(entry);
	rasterRedoStack = [];
	while (rasterUndoStack.length > MAX_RASTER_UNDO_ENTRIES) rasterUndoStack.shift();
	let total = 0;
	for (const e of rasterUndoStack) total += e.bytes;
	while (total > MAX_RASTER_UNDO_BYTES && rasterUndoStack.length > 1) {
		total -= rasterUndoStack[0].bytes;
		rasterUndoStack.shift();
	}
}

export function rasterCanUndo(): boolean {
	return rasterUndoStack.length > 0;
}

/**
 * Current accumulated dirty bounds for a layer's ACTIVE stroke (board space),
 * or null when nothing has been painted this stroke. The renderer uses this
 * to clip recomposites to just the region the in-flight stroke touched.
 */
export function getRasterStrokeDirtyBounds(layerId: string): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} | null {
	const b = rasterDirtyBounds.get(layerId);
	if (!b || b.maxX <= b.minX || b.maxY <= b.minY) return null;
	return { ...b };
}

/**
 * Snapshot the region about to be painted. Call BEFORE the stroke's first dab.
 * The current dirty bounds (if any) describe exactly what the stroke will touch;
 * a fresh layer yields a blank-region entry.
 */
export function beginRasterStroke(layerId: string): void {
	if (!layerBitmaps.has(layerId)) return;
	const bounds = rasterDirtyBounds.get(layerId);
	const bitmap = getLayerBitmap(layerId);
	const ctx = bitmap.getContext('2d')!;
	let entry: RasterUndoEntry;
	if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
		entry = { layerId, rect: { x: 0, y: 0, w: 0, h: 0 }, pixels: null, bytes: 0 };
	} else {
		const x = Math.max(0, Math.floor(bounds.minX));
		const y = Math.max(0, Math.floor(bounds.minY));
		const w = Math.min(RASTER_WIDTH, Math.ceil(bounds.maxX)) - x;
		const h = Math.min(RASTER_HEIGHT, Math.ceil(bounds.maxY)) - y;
		const pixels = ctx.getImageData(x, y, w, h);
		entry = { layerId, rect: { x, y, w, h }, pixels, bytes: pixels.data.byteLength };
	}
	pushRasterUndoEntry(entry);
}

export function rasterUndo(): void {
	const entry = rasterUndoStack.pop();
	if (!entry) return;
	rasterRedoStack.push(entry);
	const bitmap = layerBitmaps.get(entry.layerId);
	if (!bitmap) return;
	const ctx = bitmap.getContext('2d')!;
	if (entry.pixels) {
		ctx.putImageData(entry.pixels, entry.rect.x, entry.rect.y);
	} else if (entry.rect.w > 0 && entry.rect.h > 0) {
		ctx.clearRect(entry.rect.x, entry.rect.y, entry.rect.w, entry.rect.h);
	} else {
		ctx.clearRect(0, 0, RASTER_WIDTH, RASTER_HEIGHT);
	}
	// Re-dirty the restored region so the next commit re-uploads corrected pixels,
	// and advance the revision silently (no vector-stack push, no patch emission).
	const r = entry.pixels ? entry.rect : { x: 0, y: 0, w: RASTER_WIDTH, h: RASTER_HEIGHT };
	expandDirtyBounds(entry.layerId, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) / 2);
	boardStore.updateLayerSilent(entry.layerId, { mode: 'raster', revision: (get(boardStore).layers.find((l) => l.id === entry.layerId)?.revision || 0) + 1 });
}

function expandDirtyBounds(layerId: string, x: number, y: number, reach: number): void {
	const rect = rasterDirtyBounds.get(layerId);
	if (rect) {
		if (x - reach < rect.minX) rect.minX = x - reach;
		if (y - reach < rect.minY) rect.minY = y - reach;
		if (x + reach > rect.maxX) rect.maxX = x + reach;
		if (y + reach > rect.maxY) rect.maxY = y + reach;
	} else {
		rasterDirtyBounds.set(layerId, { minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach });
	}
}

function getLayerBitmap(layerId: string): HTMLCanvasElement {
	let bitmap = layerBitmaps.get(layerId);
	if (bitmap) return bitmap;
	bitmap = document.createElement('canvas');
	bitmap.width = RASTER_WIDTH;
	bitmap.height = RASTER_HEIGHT;
	bitmap.dataset.whiteboardRasterLayer = layerId;
	layerBitmaps.set(layerId, bitmap);
	return bitmap;
}

function parseColor(color: string): string {
	return color && color !== 'transparent' ? color : '#111827';
}

function getStamp(size: number, hardness: number, color: string): HTMLCanvasElement {
	const diameter = Math.max(2, Math.ceil(size));
	const key = `${diameter}:${Math.round(hardness * 100)}:${color}`;
	const cached = stampCache.get(key);
	if (cached) return cached;

	const stamp = document.createElement('canvas');
	stamp.width = diameter;
	stamp.height = diameter;
	const ctx = stamp.getContext('2d')!;
	const radius = diameter / 2;
	const edge = Math.max(0, Math.min(1, hardness));
	const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
	gradient.addColorStop(0, parseColor(color));
	gradient.addColorStop(Math.max(0.01, edge), parseColor(color));
	gradient.addColorStop(1, 'transparent');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, diameter, diameter);
	stampCache.set(key, stamp);
	return stamp;
}

export function paintRasterDab(
	layerId: string,
	x: number,
	y: number,
	size: number,
	color: string,
	opacity: number,
	hardness: number,
	pressure = 1,
	eraser = false
): void {
	const bitmap = getLayerBitmap(layerId);
	const ctx = bitmap.getContext('2d')!;
	const effectiveSize = Math.max(1, size * (0.4 + 0.6 * Math.max(0, Math.min(1, pressure))));
	const reach = effectiveSize / 2;
	// Cheap guard: skip dabs whose center falls outside the bitmap bounds.
	if (x < 0 || y < 0 || x > RASTER_WIDTH || y > RASTER_HEIGHT) return;
	expandDirtyBounds(layerId, x, y, reach);
	const stamp = getStamp(effectiveSize, hardness, color);
	ctx.save();
	ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
	ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
	ctx.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2);
	ctx.restore();
}

export function paintRasterSegment(
	layerId: string,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	size: number,
	color: string,
	opacity: number,
	hardness: number,
	pressure = 1,
	eraser = false
): void {
	const distance = Math.hypot(toX - fromX, toY - fromY);
	const spacing = Math.max(1, size * 0.18);
	const steps = Math.max(1, Math.ceil(distance / spacing));
	for (let i = 1; i <= steps; i += 1) {
		const t = i / steps;
		paintRasterDab(layerId, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, size, color, opacity, hardness, pressure, eraser);
	}
}

export function renderRasterLayer(
	ctx: CanvasRenderingContext2D,
	layerId: string,
	viewport: { x: number; y: number; zoom: number }
): boolean {
	const bitmap = layerBitmaps.get(layerId);
	if (!bitmap) return false;
	ctx.save();
	ctx.scale(viewport.zoom, viewport.zoom);
	ctx.translate(-viewport.x, -viewport.y);
	ctx.drawImage(bitmap, 0, 0);
	ctx.restore();
	return true;
}

export function hydrateRasterLayer(layerId: string, assetUrl: string): Promise<void> {
	const existing = hydratingLayers.get(layerId);
	if (existing) return existing;
	const task = (async () => {
		const headers: HeadersInit = {};
		const token = getAuthToken();
		const sessionId = token ? null : getGuestSessionId();
		if (token) headers.Authorization = `Bearer ${token}`;
		if (!token && sessionId) headers['X-Session-Id'] = sessionId;
		const response = await fetch(new URL(assetUrl, getServerUrl()), { headers });
		if (!response.ok) throw new Error(`Raster layer asset load failed (${response.status})`);
		const blob = await response.blob();
		const objectUrl = URL.createObjectURL(blob);
		try {
			const image = new Image();
			image.src = objectUrl;
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = () => reject(new Error('Raster layer image decode failed'));
			});
			const ctx = getLayerBitmap(layerId).getContext('2d')!;
			const layer = get(boardStore).layers.find((candidate) => candidate.id === layerId);
			const offsetX = layer?.assetOffsetX;
			const offsetY = layer?.assetOffsetY;
			const pixelWidth = layer?.pixelWidth;
			const pixelHeight = layer?.pixelHeight;
			const useOffset =
				typeof offsetX === 'number' &&
				typeof offsetY === 'number' &&
				((pixelWidth ?? RASTER_WIDTH) < RASTER_WIDTH || (pixelHeight ?? RASTER_HEIGHT) < RASTER_HEIGHT);
			if (useOffset) {
				ctx.drawImage(image, offsetX, offsetY);
			} else {
				ctx.drawImage(image, 0, 0, RASTER_WIDTH, RASTER_HEIGHT);
			}
		} finally {
			URL.revokeObjectURL(objectUrl);
		}
	})().finally(() => hydratingLayers.delete(layerId));
	hydratingLayers.set(layerId, task);
	return task;
}

export async function commitRasterLayer(boardId: string, layerId: string): Promise<void> {
	const bitmap = layerBitmaps.get(layerId);
	if (!bitmap || !boardId) return;

	let sx = 0;
	let sy = 0;
	let sw = RASTER_WIDTH;
	let sh = RASTER_HEIGHT;
	let offsetX = 0;
	let offsetY = 0;

	const bounds = rasterDirtyBounds.get(layerId) || null;
	if (bounds) {
		const minX = Math.max(0, Math.floor(bounds.minX));
		const minY = Math.max(0, Math.floor(bounds.minY));
		const maxX = Math.min(RASTER_WIDTH, Math.ceil(bounds.maxX));
		const maxY = Math.min(RASTER_HEIGHT, Math.ceil(bounds.maxY));
		sw = Math.max(1, maxX - minX);
		sh = Math.max(1, maxY - minY);
		sx = minX;
		sy = minY;
		offsetX = minX;
		offsetY = minY;
	}

	const cropped = document.createElement('canvas');
	cropped.width = sw;
	cropped.height = sh;
	const cctx = cropped.getContext('2d')!;
	cctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

	const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, 'image/png'));
	if (!blob) return;
	const upload = await uploadWhiteboardImage(boardId, new File([blob], `${layerId}.png`, { type: 'image/png' }));
	const state = get(boardStore);
	const layer = state.layers.find((candidate) => candidate.id === layerId);
	if (!layer) return;
	boardStore.updateLayer(layerId, {
		mode: 'raster',
		assetId: upload.fileId,
		assetUrl: upload.fileUrl,
		pixelWidth: sw,
		pixelHeight: sh,
		assetOffsetX: offsetX,
		assetOffsetY: offsetY,
		revision: (layer.revision || 0) + 1
	});
	rasterDirtyBounds.delete(layerId);
}

export function clearRasterLayerCache(layerId?: string): void {
	if (layerId) layerBitmaps.delete(layerId);
	else layerBitmaps.clear();
}

export const RASTER_BITMAP_SIZE = { width: RASTER_WIDTH, height: RASTER_HEIGHT } as const;

export function hasRasterBitmap(layerId: string): boolean {
	return layerBitmaps.has(layerId);
}

export function ensureRasterBitmap(layerId: string): HTMLCanvasElement {
	return getLayerBitmap(layerId);
}
