export const MAP_BASE_WIDTH = 1000;
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 4;

export interface ViewportPoint {
	x: number;
	y: number;
}

export interface ViewportState {
	zoom: number;
	panX: number;
	panY: number;
	rotation: number;
	mapBaseHeight: number;
}

export function normalizeRotationDegrees(value: number): number {
	const normalized = ((value % 360) + 360) % 360;
	return Number(normalized.toFixed(3));
}

export function clampNormalized(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function rotatePoint(x: number, y: number, degrees: number, mapBaseHeight: number): ViewportPoint {
	const radians = (degrees * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const centerX = MAP_BASE_WIDTH / 2;
	const centerY = mapBaseHeight / 2;
	const dx = x - centerX;
	const dy = y - centerY;
	return {
		x: dx * cosine - dy * sine + centerX,
		y: dx * sine + dy * cosine + centerY
	};
}

export function mapPointToViewPoint(x: number, y: number, rotation: number, mapBaseHeight: number): ViewportPoint {
	return rotatePoint(x, y, rotation, mapBaseHeight);
}

export function screenPointToMapPoint(pointerX: number, pointerY: number, zoom: number, panX: number, panY: number, rotation: number, mapBaseHeight: number): ViewportPoint {
	const localX = (pointerX - panX) / zoom;
	const localY = (pointerY - panY) / zoom;
	return rotatePoint(localX, localY, -rotation, mapBaseHeight);
}

export function zoomViewportAroundPoint(
	state: ViewportState,
	nextZoom: number,
	pointerX: number,
	pointerY: number
): ViewportState {
	const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
	const mapPoint = screenPointToMapPoint(pointerX, pointerY, state.zoom, state.panX, state.panY, state.rotation, state.mapBaseHeight);
	const rotatedPoint = mapPointToViewPoint(mapPoint.x, mapPoint.y, state.rotation, state.mapBaseHeight);
	return {
		...state,
		zoom: clampedZoom,
		panX: pointerX - rotatedPoint.x * clampedZoom,
		panY: pointerY - rotatedPoint.y * clampedZoom
	};
}

export function computeFitZoom(containerWidth: number, containerHeight: number): number {
	const fitZoom = Math.min(containerWidth / MAP_BASE_WIDTH, containerHeight / (MAP_BASE_WIDTH * 0.6));
	return Math.max(MIN_ZOOM, Math.min(Math.max(fitZoom, 0.55), 1.35));
}
