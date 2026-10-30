/**
 * How the composer lines up with the stream it shares the page with (design contract §7.20,
 * D20, D21).
 *
 * - The field ends where the day and NEW rules end. Those rules live inside the stream's
 *   scroller, so on a stage narrower than gutter + page their right edge moves in by the
 *   scroller's scrollbar (8px with classic bars, 0 with overlay bars). The composer has no
 *   scrollbar of its own, so it measures the scroller's and adds it to its right margin.
 * - When the field grows (more lines, a reply bar, file previews), the scroller above it gets
 *   shorter by the same amount. A stream that was showing its newest message stays there
 *   instead of hiding that message under the field.
 */

const STAGES = '.chat-container, .dm-message-view, .dm-conversation, .right-panel';
const SCROLLERS = ':scope > .messages, .dm-conversation-messages, .dm-messages';

/** The stream scroller that shares a stage with this composer, or null. */
export function streamScrollerFor(composer: Element | null | undefined): HTMLElement | null {
	const stage = composer?.closest(STAGES);
	if (!stage) return null;
	const scroller = stage.querySelector<HTMLElement>(SCROLLERS);
	return scroller && !scroller.contains(composer as Node) ? scroller : null;
}

type BoxMetrics = { offsetWidth: number; clientWidth: number; borderLeft?: number; borderRight?: number };

/** The width a vertical scrollbar takes from a scroller's content box (0 for overlay bars). */
export function scrollbarInset(box: BoxMetrics): number {
	const inset = box.offsetWidth - box.clientWidth - (box.borderLeft ?? 0) - (box.borderRight ?? 0);
	return Number.isFinite(inset) ? Math.max(0, Math.round(inset)) : 0;
}

/** `scrollbarInset` for a live element (its own borders are not a scrollbar). */
export function streamScrollbarInset(scroller: HTMLElement): number {
	const style = typeof getComputedStyle === 'function' ? getComputedStyle(scroller) : null;
	return scrollbarInset({
		offsetWidth: scroller.offsetWidth,
		clientWidth: scroller.clientWidth,
		borderLeft: style ? parseFloat(style.borderLeftWidth) || 0 : 0,
		borderRight: style ? parseFloat(style.borderRightWidth) || 0 : 0
	});
}

type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * The composer just grew by `grew` px and the scroller shrank by as much. When the stream was at
 * its newest message before that (within `slack`), keep it there. Returns whether it scrolled.
 */
export function followStreamBottom(scroller: ScrollBox, grew: number, slack = 2): boolean {
	if (!(grew > 0)) return false;
	const gapNow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
	if (gapNow <= slack) return false;
	if (gapNow - grew > slack) return false;
	scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
	return true;
}
