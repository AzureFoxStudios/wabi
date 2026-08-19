/**
 * rightPeekGestures.ts
 * Shared hover-handoff timer for the right panel peek.
 * The stub strip and the peeked panel body both arm/cancel the same 150ms
 * dismiss timer so the pointer can move from a stub onto the panel without
 * the peek collapsing (spec §3, interaction row 2).
 */

import { dismissPeek } from './layoutStoreRightPanel';

const DISMISS_GRACE_MS = 150;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function armPeekDismiss(_event?: MouseEvent | null, ms = DISMISS_GRACE_MS): void {
	cancelPeekDismiss();
	dismissTimer = setTimeout(() => {
		dismissTimer = null;
		dismissPeek();
	}, ms);
}

export function cancelPeekDismiss(_event?: MouseEvent | null): void {
	if (dismissTimer) {
		clearTimeout(dismissTimer);
		dismissTimer = null;
	}
}