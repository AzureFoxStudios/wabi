
import { tick } from 'svelte';

export function rotatePoint(
	x: number,
	y: number,
	degrees: number,
	centerX: number,
	centerY: number
): { x: number; y: number } {
	const radians = (degrees * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const dx = x - centerX;
	const dy = y - centerY;
	return {
		x: dx * cosine - dy * sine + centerX,
		y: dx * sine + dy * cosine + centerY
	};
}

export function mapPointToViewPoint(
	x: number,
	y: number,
	viewRotation: number,
	mapBaseHeight: number,
	mapBaseWidth: number
): { x: number; y: number } {
	return rotatePoint(x, y, viewRotation, mapBaseWidth / 2, mapBaseHeight / 2);
}

export function screenPointToMapPoint(
	pointerX: number,
	pointerY: number,
	mapPanX: number,
	mapPanY: number,
	mapZoom: number,
	viewRotation: number,
	mapBaseHeight: number,
	mapBaseWidth: number
): { x: number; y: number } {
	const localX = (pointerX - mapPanX) / mapZoom;
	const localY = (pointerY - mapPanY) / mapZoom;
	return rotatePoint(localX, localY, -viewRotation, mapBaseWidth / 2, mapBaseHeight / 2);
}

export function zoomViewportAroundPoint(
	nextZoom: number,
	pointerX: number,
	pointerY: number,
	mapPanX: number,
	mapPanY: number,
	mapZoom: number,
	viewRotation: number,
	mapBaseHeight: number,
	mapBaseWidth: number,
	minZoom: number,
	maxZoom: number
): { mapZoom: number; mapPanX: number; mapPanY: number } {
	const clampedZoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
	const mapPoint = screenPointToMapPoint(
		pointerX,
		pointerY,
		mapPanX,
		mapPanY,
		mapZoom,
		viewRotation,
		mapBaseHeight,
		mapBaseWidth
	);
	const rotatedPoint = mapPointToViewPoint(
		mapPoint.x,
		mapPoint.y,
		viewRotation,
		mapBaseHeight,
		mapBaseWidth
	);
	return {
		mapZoom: clampedZoom,
		mapPanX: pointerX - rotatedPoint.x * clampedZoom,
		mapPanY: pointerY - rotatedPoint.y * clampedZoom
	};
}

export function computeFitZoom(rectWidth: number, rectHeight: number, mapBaseWidth: number, mapBaseHeight: number): number {
	return Math.min(rectWidth / mapBaseWidth, rectHeight / mapBaseHeight);
}

export async function scheduleViewportReset(customMapViewport: HTMLDivElement | null, surfaceMode: string, mapImageUrl: string | null, resetFn: () => void): Promise<void> {
	await tick();
	if (surfaceMode === 'custom' && mapImageUrl) {
		resetFn();
	}
}
