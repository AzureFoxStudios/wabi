import type { SpatialAudioMode } from './mediaRuntime';
import type { SpatialPosition, SpatialRenderMode } from './audio/spatialEngine';

export function normalizeSpatialMode(mode: SpatialAudioMode, isDesktopLike: boolean): SpatialRenderMode | 'off' {
	if (mode === 'off') return 'off';
	if (mode === 'pan_distance') return 'pan_distance';
	if (mode === 'full_3d') return 'full_3d';
	return isDesktopLike ? 'full_3d' : 'pan_distance';
}

export function isLowPowerRuntime(): boolean {
	if (typeof navigator === 'undefined') return false;
	const cores = navigator.hardwareConcurrency || 4;
	return cores <= 4;
}

export function resolveSpatialRuntimeMode(
	requested: SpatialAudioMode
): { effective: SpatialRenderMode | 'off'; reason: string | null } {
	const isDesktopLike =
		typeof window !== 'undefined' && !/Mobi|Android|iPhone|iPad/i.test(window.navigator.userAgent || '');
	const desired = normalizeSpatialMode(requested, isDesktopLike);
	if (desired === 'off') {
		return { effective: 'off', reason: null };
	}
	if (desired === 'full_3d' && isLowPowerRuntime()) {
		return { effective: 'pan_distance', reason: 'weak_device' };
	}
	return { effective: desired, reason: null };
}

export function computeSpatialPosition(index: number, total: number, emphasisFront = false): SpatialPosition {
	const safeTotal = Math.max(total, 1);
	const angle = (Math.PI * 2 * index) / safeTotal;
	const radius = safeTotal <= 2 ? 2.2 : 3.3;
	const baseX = Math.sin(angle) * radius;
	const baseZ = -Math.cos(angle) * radius;
	return {
		x: baseX,
		y: 0,
		z: emphasisFront ? Math.min(baseZ + 1.2, -0.4) : baseZ
	};
}

export function sortByUserId<T extends { userId: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => a.userId.localeCompare(b.userId));
}

export function assignStableSeatOrder(
	ids: string[],
	seatMap: Map<string, number>
): { orderedIds: string[]; slotCount: number } {
	const active = new Set(ids);
	for (const key of Array.from(seatMap.keys())) {
		if (!active.has(key)) {
			seatMap.delete(key);
		}
	}
	const usedSeats = new Set<number>();
	for (const id of ids) {
		const seat = seatMap.get(id);
		if (typeof seat === 'number') {
			usedSeats.add(seat);
		}
	}
	let nextSeat = 0;
	for (const id of ids) {
		if (seatMap.has(id)) continue;
		while (usedSeats.has(nextSeat)) nextSeat += 1;
		seatMap.set(id, nextSeat);
		usedSeats.add(nextSeat);
	}
	const orderedIds = [...ids].sort((a, b) => (seatMap.get(a) ?? 0) - (seatMap.get(b) ?? 0));
	const highestSeat = usedSeats.size ? Math.max(...usedSeats) : -1;
	return {
		orderedIds,
		slotCount: Math.max(ids.length, highestSeat + 1, 1)
	};
}

// ---------------------------------------------------------------------------
// Phase 3 — manual seat persistence (personal, per call, localStorage)
// ---------------------------------------------------------------------------

import type { CallSpatialPosition } from './callSessionTypes';

function spatialSeatsStorageKey(sessionId: string): string {
	return `wabi:spatial-seats:${sessionId}`;
}

export function loadSpatialSeats(sessionId: string): Record<string, CallSpatialPosition> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(spatialSeatsStorageKey(sessionId));
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, CallSpatialPosition>;
		const seats: Record<string, CallSpatialPosition> = {};
		for (const [userId, pos] of Object.entries(parsed)) {
			if (pos && typeof pos.x === 'number' && typeof pos.z === 'number') {
				seats[userId] = { x: pos.x, y: pos.y ?? 0, z: pos.z };
			}
		}
		return seats;
	} catch {
		return {};
	}
}

export function saveSpatialSeats(sessionId: string, seats: Record<string, CallSpatialPosition>): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(spatialSeatsStorageKey(sessionId), JSON.stringify(seats));
	} catch {
		// storage full / private mode — seats just won't persist
	}
}
