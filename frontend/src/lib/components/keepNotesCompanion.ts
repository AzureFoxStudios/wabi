/**
 * Pure helpers for the Notes companion's chrome (KeepNotesView, design contract §4.5, §7.21,
 * §8.4). NotesWorkspace owns the notebook markup; the companion only reads it:
 * - the ink tools (Pen, Eraser, Shapes) are the one part of the editor tools that may scroll
 *   sideways in a narrow panel, with an alpha-mask fade on each edge that has more, and an end
 *   that always cuts through a tool so the fade reads as "more";
 * - a mouse wheel over the editor tools moves that strip, so nothing needs Shift to reach;
 * - the footer's save word shows only while a save is not settled.
 */

/** Overflow up to this many pixels is the last tool's own padding, never part of a glyph. */
export const STRIP_SLACK_PX = 4;

/** One wheel "line" in pixels (WheelEvent.DOM_DELTA_LINE). */
const LINE_PX = 16;

export interface StripEdges {
	/** More tools are scrolled out of view before the start edge. */
	before: boolean;
	/** More tools are scrolled out of view past the end edge. */
	after: boolean;
}

/** Which edges of a sideways strip have tools out of view (and so carry the fade). */
export function stripEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): StripEdges {
	const max = scrollWidth - clientWidth;
	if (!(max > STRIP_SLACK_PX)) return { before: false, after: false };
	return { before: scrollLeft > 1, after: scrollLeft < max - 1 };
}

/**
 * A tool cut at the strip's end keeps between this share and its complement in view, so its
 * label reads as cut (it continues) and never as a gap or as a whole word.
 */
export const STRIP_PEEK_SHARE = 0.35;

/**
 * The width to give a strip that cannot show all its tools, so that its end cuts through a tool
 * rather than the gap between two: the cut tool fades out under the end mask and shows that
 * the row continues. When less than STRIP_PEEK_SHARE of the first hidden tool would show, the
 * cut moves back into the tool before it, leaving 1 − STRIP_PEEK_SHARE of it in view (the space
 * given up widens the gap before the strip). Returns null when every tool fits, so the strip
 * keeps its natural width.
 */
export function stripPeekWidth(available: number, widths: readonly number[]): number | null {
	const total = widths.reduce((sum, width) => sum + width, 0);
	if (total <= available + STRIP_SLACK_PX) return null;
	let used = 0;
	for (let index = 0; index < widths.length; index++) {
		const width = widths[index];
		if (used + width <= available) {
			used += width;
			continue;
		}
		if (index === 0 || available - used >= width * STRIP_PEEK_SHARE) return Math.max(0, available);
		return used - widths[index - 1] * STRIP_PEEK_SHARE;
	}
	return null;
}

export interface StripWheel {
	deltaX: number;
	deltaY: number;
	/** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
	deltaMode: number;
	/** The pointer is over the strip itself (not a pinned tool beside it). */
	inStrip: boolean;
	scrollLeft: number;
	/** scrollWidth − clientWidth of the strip. */
	maxScroll: number;
	/** The strip's visible width, used for page-sized wheel steps. */
	pageWidth: number;
}

/**
 * How far a wheel turn over the editor tools should move the strip sideways, or 0 to leave the
 * event to the browser: when nothing is out of view, when the strip is already at that end, or
 * for a sideways gesture over the strip itself (a trackpad swipe or Shift + wheel there already
 * scrolls it natively, with momentum).
 */
export function stripWheelDelta({ deltaX, deltaY, deltaMode, inStrip, scrollLeft, maxScroll, pageWidth }: StripWheel): number {
	if (!(maxScroll > 0)) return 0;
	const sideways = Math.abs(deltaX) >= Math.abs(deltaY);
	if (sideways && inStrip) return 0;
	const raw = sideways ? deltaX : deltaY;
	if (!raw) return 0;
	const scale = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? Math.max(pageWidth, 1) : 1;
	const delta = raw * scale;
	if (delta < 0 && scrollLeft <= 0) return 0;
	if (delta > 0 && scrollLeft >= maxScroll - 0.5) return 0;
	return Math.max(-scrollLeft, Math.min(maxScroll - scrollLeft, delta));
}

/**
 * Whether the note's save word reports a settled save ("Saved on this device", "Saved 09:41").
 * "Saving…", "Unsaved changes", "Conflicting changes" and "Could not save" are not settled.
 */
export function isSettledSave(text: string): boolean {
	return /^Saved\b/.test(text.trim());
}
