import type { DeletionCountdownMode } from './accessibility';

/** Expiry removes rows in every display mode; only Live animates labels. */
export function retentionClockShouldTick(
	mode: DeletionCountdownMode,
	now: number,
	earliestPendingDeadline: number | null,
	hasVisibleCountdown: boolean
): boolean {
	if (earliestPendingDeadline !== null && now >= earliestPendingDeadline) return true;
	return mode === 'live' && hasVisibleCountdown;
}
