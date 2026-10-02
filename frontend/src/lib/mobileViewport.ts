export type VisualViewportMeasurement = {
	layoutHeight: number;
	viewportHeight: number;
	viewportOffsetTop?: number;
};

/** Compute the portion of the layout viewport obscured below the visual viewport. */
export function computeKeyboardInset({
	layoutHeight,
	viewportHeight,
	viewportOffsetTop = 0
}: VisualViewportMeasurement): number {
	const layout = Number.isFinite(layoutHeight) ? layoutHeight : 0;
	const viewport = Number.isFinite(viewportHeight) ? viewportHeight : layout;
	const offset = Number.isFinite(viewportOffsetTop) ? viewportOffsetTop : 0;
	return Math.max(0, Math.round(layout - viewport - offset));
}

/** Browser chrome/jitter below this threshold is not treated as an IME. */
export function isKeyboardInsetOpen(inset: number, minimumInset = 80): boolean {
	return Number.isFinite(inset) && inset > minimumInset;
}
