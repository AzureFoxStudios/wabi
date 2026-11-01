/**
 * Fit a calendar day's lines to its cell (design contract §8.6: never clipped; overflow becomes
 * "+N more"). The cell's list holds every event and task of the day (`[data-fit-item]`). The
 * action measures how many whole lines fit in the list's height and hides the rest with
 * `data-fit-hidden` (display: none, so they leave the tab order and the accessibility tree too);
 * the day dialog shows them all. "+N more" sits in the day's head row beside the date, not in the
 * list, so every line of the list's height is spent on titles. Titles may take one or two text
 * lines, so the cap comes from the cell's real height, never a fixed count.
 *
 * It re-measures when the list changes size (a resized window, a narrower stage, another text
 * size), when its lines change, and once the fonts have loaded. The list must not take its height
 * from its content (calendar-view-part1.css gives it `contain: size` and the cell's free height),
 * so hiding lines never resizes the row and measuring never loops.
 */
import { fitCount } from '$lib/business/plannerCalendar';

export interface FitOptions {
	/** The day this list belongs to (passed back to `onfit`). */
	key: string;
	/** Called with the number of lines behind "+N more" whenever it changes. */
	onfit: (key: string, hidden: number) => void;
}

const HIDDEN = 'data-fit-hidden';

export function fitDayLines(list: HTMLElement, options: FitOptions) {
	let current = options;
	let reported = -1;

	function measure(): void {
		const items = Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-fit-item]'));
		// Lay every line out once (synchronously, nothing paints in between) to read its edge.
		for (const item of items) item.removeAttribute(HIDDEN);
		const top = list.getBoundingClientRect().top;
		const bottoms = items.map((item) => item.getBoundingClientRect().bottom - top);
		// "+N more" is in the head row, so the list needs no room kept for it.
		const shown = fitCount(bottoms, list.clientHeight, 0, 0);
		items.forEach((item, index) => {
			if (index >= shown) item.setAttribute(HIDDEN, '');
		});
		const hidden = items.length - shown;
		if (hidden !== reported) {
			reported = hidden;
			current.onfit(current.key, hidden);
		}
	}

	const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
	resize?.observe(list);
	// Lines added, removed or renamed; attribute changes (our own hiding) are not observed.
	const changes = typeof MutationObserver === 'function' ? new MutationObserver(() => measure()) : null;
	changes?.observe(list, { childList: true, subtree: true, characterData: true });
	let alive = true;
	void document.fonts?.ready.then(() => {
		if (alive) measure();
	});
	measure();

	return {
		update(next: FitOptions) {
			const moved = next.key !== current.key;
			current = next;
			if (moved) reported = -1;
			measure();
		},
		destroy() {
			alive = false;
			resize?.disconnect();
			changes?.disconnect();
			// The day lost its last line: nothing is behind "+N more" any more.
			if (reported > 0) current.onfit(current.key, 0);
		}
	};
}
