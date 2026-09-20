/**
 * rightPeekGestures.ts
 * Shared hover controller for the right-panel peek.
 *
 * Model: the peek stays open while the pointer is over the strip OR the panel
 * zone; leaving both retracts it after a short grace. Dismissal is suppressed
 * while the slide animation plays — pointer events fired mid-flight (the
 * strip rides the panel) are artifacts of elements moving under the cursor,
 * not intent, and must never collapse the panel.
 *
 * The stub strip and the peeked panel zone both feed this controller, so the
 * pointer can move between them without the peek collapsing.
 */

import { dismissPeek } from './layoutStoreRightPanel';

const DISMISS_GRACE_MS = 180;
const ANIMATION_FALLBACK_MS = 340;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let animationFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let animating = false;
let pointerInside = false;

export function armPeekDismiss(_event?: MouseEvent | null, ms = DISMISS_GRACE_MS): void {
	if (animating) return;
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

/** The pointer is over the strip or the panel zone. */
export function setPeekPointerInside(inside: boolean): void {
	pointerInside = inside;
	if (inside) cancelPeekDismiss();
}

/**
 * Mark the peek slide-in as in flight. Called when the panel zone mounts.
 * While in flight, dismissals are suppressed; if the pointer never followed
 * the panel in, it retracts on its own once the animation settles.
 */
export function beginPeekAnimation(): void {
	animating = true;
	pointerInside = false;
	if (animationFallbackTimer) clearTimeout(animationFallbackTimer);
	animationFallbackTimer = setTimeout(() => endPeekAnimation(), ANIMATION_FALLBACK_MS);
}

export function endPeekAnimation(): void {
	if (animationFallbackTimer) {
		clearTimeout(animationFallbackTimer);
		animationFallbackTimer = null;
	}
	if (!animating) return;
	animating = false;
	// Landed with nobody following it in — schedule the retract so a stray
	// hover can't leave an orphaned peek open over the chat.
	if (!pointerInside) armPeekDismiss();
}

/**
 * Svelte action for the panel zone: gates dismissal on the slide-in
 * animation. `animationend` is the happy path; the timeout covers
 * reduced-motion setups where the animation never runs or never ends.
 */
export function peekAnimationGate(node: HTMLElement): { destroy: () => void } {
	beginPeekAnimation();
	// One frame after the slide settles, re-read :hover: a cursor that sat
	// perfectly still while the panel slid under it gets no mouseenter until
	// the next real move, so events alone would read "nobody home" and
	// retract a peek the user is actively hovering.
	const settle = () => {
		requestAnimationFrame(() => {
			setPeekPointerInside(node.matches(':hover'));
			endPeekAnimation();
		});
	};
	const onAnimationEnd = (event: AnimationEvent) => {
		if (event.target !== node) return;
		if (node.classList.contains('closing')) return;
		settle();
	};
	node.addEventListener('animationend', onAnimationEnd);
	return {
		destroy: () => {
			node.removeEventListener('animationend', onAnimationEnd);
			if (animationFallbackTimer) {
				clearTimeout(animationFallbackTimer);
				animationFallbackTimer = null;
			}
			animating = false;
		}
	};
}
