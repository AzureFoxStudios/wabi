/** Pure geometry for the designer: snapping a moving box to the slide and to other objects, and group bounds. All values are fractions of the slide. */
export interface Box { x: number; y: number; w: number; h: number }
export interface Guides { x: number[]; y: number[] }
export interface Snapped { dx: number; dy: number; guides: Guides }

/** About 1% of the slide, as asked for. */
export const SNAP_THRESHOLD = 0.01;
const EPSILON = 1e-6;

/** The smallest box holding every box, or null for none. */
export function boundsOf(boxes: Box[]): Box | null {
	if (!boxes.length) return null;
	const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
	const right = Math.max(...boxes.map((b) => b.x + b.w)), bottom = Math.max(...boxes.map((b) => b.y + b.h));
	return { x, y, w: right - x, h: bottom - y };
}

/** Edge and centre lines of a box along one axis. */
const lines = (start: number, size: number) => [start, start + size / 2, start + size];

function axis(start: number, size: number, targets: number[], threshold: number): { shift: number; guides: number[] } {
	const mine = lines(start, size);
	let shift = 0, best = Infinity;
	for (const line of mine) for (const target of targets) {
		const gap = target - line;
		if (Math.abs(gap) <= threshold && Math.abs(gap) < best - EPSILON) { best = Math.abs(gap); shift = gap; }
	}
	if (best === Infinity) return { shift: 0, guides: [] };
	const moved = mine.map((line) => line + shift);
	const guides = [...new Set(targets.filter((target) => moved.some((line) => Math.abs(line - target) < EPSILON)).map((t) => Math.round(t * 1e6) / 1e6))];
	return { shift, guides };
}

/**
 * Where a moving box lands. `box` is its proposed position; the result is the extra shift that
 * puts its edges or centre on the slide's edges and centre, or on another object's, when within
 * `threshold`, plus the lines to draw. The axes snap independently.
 */
export function snapBox(box: Box, others: Box[], threshold = SNAP_THRESHOLD): Snapped {
	const xs = [0, 0.5, 1], ys = [0, 0.5, 1];
	for (const other of others) { xs.push(...lines(other.x, other.w)); ys.push(...lines(other.y, other.h)); }
	const horizontal = axis(box.x, box.w, xs, threshold), vertical = axis(box.y, box.h, ys, threshold);
	return { dx: horizontal.shift, dy: vertical.shift, guides: { x: horizontal.guides, y: vertical.guides } };
}

/** Keep a moving group inside the slide: the shift is limited by the group's bounds, never per object. */
export function clampShift(bounds: Box, dx: number, dy: number): { dx: number; dy: number } {
	return {
		dx: Math.max(-bounds.x, Math.min(1 - bounds.x - bounds.w, dx)),
		dy: Math.max(-bounds.y, Math.min(1 - bounds.y - bounds.h, dy))
	};
}

/**
 * The whole drag step: clamp to the slide, then snap unless disabled (Alt) or the pointer has
 * barely moved (a click must never nudge an object). Snapping that would push the group off
 * the slide is clamped again.
 */
export function dragShift(bounds: Box, others: Box[], dx: number, dy: number, options: { snap: boolean; moved: boolean; threshold?: number }): Snapped {
	if (!options.moved) return { dx: 0, dy: 0, guides: { x: [], y: [] } };
	const first = clampShift(bounds, dx, dy);
	if (!options.snap) return { ...first, guides: { x: [], y: [] } };
	const target = { x: bounds.x + first.dx, y: bounds.y + first.dy, w: bounds.w, h: bounds.h };
	const snapped = snapBox(target, others, options.threshold);
	const next = clampShift(bounds, first.dx + snapped.dx, first.dy + snapped.dy);
	// A guide is only drawn when the clamp left the shift alone on that axis.
	return {
		...next,
		guides: {
			x: Math.abs(next.dx - (first.dx + snapped.dx)) < EPSILON ? snapped.guides.x : [],
			y: Math.abs(next.dy - (first.dy + snapped.dy)) < EPSILON ? snapped.guides.y : []
		}
	};
}
