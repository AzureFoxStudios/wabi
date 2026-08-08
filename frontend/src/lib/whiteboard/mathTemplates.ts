// ---------------------------------------------------------------------------
// mathTemplates.ts — curated symbol template bank for the stroke-to-LaTeX
// recognizer (Phase 5.2, Wave 4b).
//
// Templates are generated programmatically at module load from tiny shape
// primitives (lines, arcs, circles, cubics) — no hand-written point dumps —
// then normalized with the SAME pipeline the recognizer applies to input
// strokes (resample -> centroid -> indicative-angle rotation -> unit box),
// so k-NN feature distances are comparable.
//
// Pure data + pure geometry. No DOM, no network, no store imports.
// ---------------------------------------------------------------------------

export interface Point2 {
	x: number;
	y: number;
}

export interface SymbolTemplate {
	/** Stable id used by the structure parser (e.g. 'x', '2', '√', '+'). */
	symbolId: string;
	/** LaTeX the symbol renders as (e.g. '\alpha', '\times', 'x'). */
	latex: string;
	/**
	 * One entry per stroke of the symbol. Each stroke is the flattened
	 * 64x2 (128-dim) normalized feature vector described by
	 * `normalizePointsToVector`.
	 */
	strokes: number[][];
}

/** Feature dimensionality: 64 points x (x, y). */
export const NORM_POINTS = 64;

/** Extra geometric dims appended per stroke feature (relative length). */
export const EXTRA_FEATURE_DIMS = 1;

/** Full per-stroke feature length (128 shape + extras). */
export const FEATURE_DIM = NORM_POINTS * 2 + EXTRA_FEATURE_DIMS;

/** Total path length of a polyline (used for the relative-length dim). */
export function strokePathLength(pts: Point2[]): number {
	return pathLength(pts);
}

// ---------------------------------------------------------------------------
// Normalization pipeline (shared by templates and input strokes)
// ---------------------------------------------------------------------------

function pathLength(pts: Point2[]): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) {
		total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
	}
	return total;
}

/**
 * Resample a polyline to exactly `n` points, evenly spaced by arc length.
 * Interpolates between input vertices so sparse polylines stay smooth.
 */
export function resamplePath(pts: Point2[], n: number): Point2[] {
	if (pts.length === 0) return [];
	if (pts.length === 1 || n <= 1) {
		return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
	}

	const cum: number[] = [0];
	for (let i = 1; i < pts.length; i++) {
		cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
	}
	const total = cum[cum.length - 1];
	if (total <= 1e-9) {
		return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
	}

	const out: Point2[] = [{ x: pts[0].x, y: pts[0].y }];
	for (let k = 1; k < n - 1; k++) {
		const target = (total * k) / (n - 1);
		// Find the segment containing `target`.
		let idx = 0;
		while (idx < cum.length - 2 && cum[idx + 1] < target) idx++;
		const segLen = cum[idx + 1] - cum[idx];
		const t = segLen <= 1e-9 ? 0 : (target - cum[idx]) / segLen;
		out.push({
			x: pts[idx].x + (pts[idx + 1].x - pts[idx].x) * t,
			y: pts[idx].y + (pts[idx + 1].y - pts[idx].y) * t
		});
	}
	out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
	return out;
}

/**
 * Normalize a raw polyline into a flattened `n*2` feature vector:
 *   1. resample to `n` arc-length-even points
 *   2. translate centroid to origin
 *   3. rotate to the indicative angle (line from centroid to first point)
 *   4. scale so the max bbox dimension is 1
 *
 * Rotation is skipped for extreme-aspect shapes (width/height outside
 * [1/3, 3]) so that axis-aligned line symbols like '-' vs '|' keep their
 * orientation — the rotation would otherwise collapse them into identical
 * vectors.
 *
 * Returns null for degenerate input (single point, zero extent).
 */
export function normalizePointsToVector(pts: Point2[], n: number = NORM_POINTS): number[] | null {
	if (pts.length === 0) return null;

	const resampled = resamplePath(pts, n);

	let cx = 0;
	let cy = 0;
	for (const p of resampled) {
		cx += p.x;
		cy += p.y;
	}
	cx /= resampled.length;
	cy /= resampled.length;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const centered: Point2[] = [];
	for (const p of resampled) {
		const x = p.x - cx;
		const y = p.y - cy;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
		centered.push({ x, y });
	}

	const w = maxX - minX;
	const h = maxY - minY;
	if (Math.max(w, h) <= 1e-9) return null;

	const aspect = w / h;
	let ptsToScale: Point2[] = centered;

	// Indicative-angle rotation (only for rotation-stable aspect ratios).
	if (aspect >= 1 / 3 && aspect <= 3) {
		const first = centered[0];
		const theta = Math.atan2(first.y, first.x);
		const rot = Math.PI / 2 - theta;
		const cos = Math.cos(rot);
		const sin = Math.sin(rot);
		ptsToScale = centered.map((p) => ({
			x: p.x * cos - p.y * sin,
			y: p.x * sin + p.y * cos
		}));
	}

	// Scale by the extent of the ROTATED points: rotation can stretch the
	// bounding box from a diagonal to an axis, so sizing must happen after.
	let sMinX = Infinity;
	let sMinY = Infinity;
	let sMaxX = -Infinity;
	let sMaxY = -Infinity;
	for (const p of ptsToScale) {
		if (p.x < sMinX) sMinX = p.x;
		if (p.y < sMinY) sMinY = p.y;
		if (p.x > sMaxX) sMaxX = p.x;
		if (p.y > sMaxY) sMaxY = p.y;
	}
	const size = Math.max(sMaxX - sMinX, sMaxY - sMinY, 1e-9);

	const flat: number[] = new Array(n * 2);
	for (let i = 0; i < n; i++) {
		flat[i * 2] = ptsToScale[i].x / size;
		flat[i * 2 + 1] = ptsToScale[i].y / size;
	}
	return flat;
}

// ---------------------------------------------------------------------------
// Shape primitives (draw in an abstract ~[0,10]x[0,10] space, y down)
// ---------------------------------------------------------------------------

function L(x0: number, y0: number, x1: number, y1: number): Point2[] {
	return [
		{ x: x0, y: y0 },
		{ x: x1, y: y1 }
	];
}

function P(...coords: number[]): Point2[] {
	const pts: Point2[] = [];
	for (let i = 0; i + 1 < coords.length; i += 2) pts.push({ x: coords[i], y: coords[i + 1] });
	return pts;
}

function A(cx: number, cy: number, r: number, a0: number, a1: number, steps = 28): Point2[] {
	const out: Point2[] = [];
	for (let i = 0; i <= steps; i++) {
		const a = a0 + ((a1 - a0) * i) / steps;
		out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
	}
	return out;
}

function C(cx: number, cy: number, r: number, steps = 36): Point2[] {
	return A(cx, cy, r, 0, Math.PI * 2, steps);
}

function B(
	p0x: number, p0y: number,
	p1x: number, p1y: number,
	p2x: number, p2y: number,
	p3x: number, p3y: number,
	steps = 26
): Point2[] {
	const out: Point2[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push({
			x: u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x,
			y: u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y
		});
	}
	return out;
}

/** Tiny mark used for dots (cdot, i-dot, etc). */
function DOT(cx: number, cy: number): Point2[] {
	return L(cx - 0.5, cy - 0.5, cx + 0.5, cy + 0.5);
}

function makeTemplate(symbolId: string, latex: string, strokes: Point2[][]): SymbolTemplate {
	const norm: number[][] = [];
	const lengths: number[] = [];
	for (const s of strokes) {
		const v = normalizePointsToVector(s);
		if (v) {
			norm.push(v);
			lengths.push(pathLength(s));
		}
	}
	// Safety: never hand back a template with zero stroke features.
	if (norm.length === 0) {
		return { symbolId, latex, strokes: [new Array(FEATURE_DIM).fill(0)] };
	}
	// Append the relative stroke length (0..1) as a cheap disambiguator for
	// multi-stroke symbols whose shapes normalize identically (e.g. + vs t).
	const maxLen = Math.max(...lengths) || 1;
	for (let i = 0; i < norm.length; i++) {
		norm[i] = norm[i].concat(lengths[i] / maxLen);
	}
	return { symbolId, latex, strokes: norm };
}

/**
 * Normalize a whole symbol's raw strokes into feature vectors with the same
 * relative-length extension `makeTemplate` applies, so input features line up
 * with template features dim-for-dim.
 */
export function normalizeSymbolStrokes(rawStrokes: Point2[][]): number[][] {
	const vectors: number[][] = [];
	const lengths: number[] = [];
	for (const s of rawStrokes) {
		const v = normalizePointsToVector(s);
		if (v) {
			vectors.push(v);
			lengths.push(pathLength(s));
		}
	}
	if (vectors.length === 0) return [new Array(FEATURE_DIM).fill(0)];
	const maxLen = Math.max(...lengths) || 1;
	for (let i = 0; i < vectors.length; i++) {
		vectors[i] = vectors[i].concat(lengths[i] / maxLen);
	}
	return vectors;
}

// ---------------------------------------------------------------------------
// Template bank
// ---------------------------------------------------------------------------

export const MATH_TEMPLATES: SymbolTemplate[] = [
	// --- digits 0-9 ------------------------------------------------------
	makeTemplate('0', '0', [C(5, 5, 3)]),
	makeTemplate('1', '1', [P(3.5, 2, 5, 1, 5, 9)]),
	makeTemplate('2', '2', [P(2, 2.8, 5, 1, 7.8, 3, 4.5, 6, 2, 8.5, 8, 8.5)]),
	makeTemplate('3', '3', [B(8, 1.2, 2.5, 3.5, 8, 6, 2.5, 9)]),
	makeTemplate('4', '4', [P(6.5, 1.5, 3.2, 9), P(1.5, 4.5, 6.5, 4.5, 6.5, 9)]),
	makeTemplate('5', '5', [P(6.5, 1.5, 2, 1.5, 2, 4.5, 6, 4.5, 6, 9, 2.5, 9)]),
	makeTemplate('6', '6', [P(2.2, 2.5, 4, 1.5, 5.5, 3, 5.5, 5, 4, 6.5, 2.2, 6.5, 2.2, 8.5, 4, 9.5, 6, 9.5, 6, 7)]),
	makeTemplate('7', '7', [P(2, 1.5, 8, 1.5, 5, 5, 5, 9)]),
	makeTemplate('8', '8', [C(5, 3.2, 2), C(5, 6.8, 2)]),
	makeTemplate('9', '9', [C(5, 3.2, 2.2), P(4.5, 5.4, 4.5, 9)]),

	// --- lowercase letters ----------------------------------------------
	makeTemplate('x', 'x', [L(2, 1.5, 8, 8.5), L(8, 1.5, 2, 8.5)]),
	makeTemplate('y', 'y', [P(8, 1.5, 5, 5.5, 4, 9), L(2, 1.5, 5, 5.5)]),
	makeTemplate('z', 'z', [P(2, 1.5, 8, 1.5, 2, 9, 8, 9)]),
	makeTemplate('a', 'a', [P(3, 4, 2.2, 2, 5, 1.5, 6.5, 3.5, 6.5, 5, 6, 8)]),
	makeTemplate('b', 'b', [L(2, 1, 2, 9), B(2, 4, 1.8, 2, 6, 2, 6, 5.5)]),
	makeTemplate('c', 'c', [A(5, 5, 3, 0.2, 1.8 * Math.PI)]),
	makeTemplate('d', 'd', [B(6.5, 1.5, 6.5, 2.5, 2, 2, 2, 6.5), P(6.5, 5, 6.5, 9)]),
	makeTemplate('e', 'e', [A(5, 5, 3, 0.25 * Math.PI, 1.75 * Math.PI), L(2.3, 5, 7, 5)]),
	makeTemplate('t', 't', [L(5, 2, 5, 9), L(3, 3, 7, 3)]),
	makeTemplate('f', 'f', [P(6, 1, 3, 1.2, 3, 8.5, 5, 8.5), L(1.5, 4, 5, 4)]),
	makeTemplate('g', 'g', [P(3, 2, 6, 2, 6, 5.5, 3, 5.5, 3, 9)]),
	makeTemplate('h', 'h', [P(2, 9, 2, 2, 6, 2, 6, 9)]),
	makeTemplate('i', 'i', [L(4, 2, 4, 8), DOT(4, 8.5)]),
	makeTemplate('k', 'k', [L(2, 9, 2, 2), P(6.5, 2, 4, 5, 6.5, 9)]),
	makeTemplate('m', 'm', [P(2, 9, 2, 2, 4.5, 2, 5, 9, 5, 2, 8, 2, 8, 9)]),
	makeTemplate('n', 'n', [P(2, 9, 2, 2, 6.5, 2, 6.5, 9)]),
	makeTemplate('p', 'p', [L(2, 1, 2, 9), B(2, 5, 1.8, 4, 5.5, 4, 5.5, 6.5)]),
	makeTemplate('r', 'r', [L(2, 9, 2, 2), B(2, 2, 2, 1.5, 5.5, 1.5, 5.5, 4)]),
	makeTemplate('s', 's', [B(7.5, 1.5, 2, 3.5, 7.5, 6.5, 2, 8.5)]),
	makeTemplate('u', 'u', [B(2, 2, 2, 7.5, 6.5, 7.5, 6.5, 2)]),
	makeTemplate('v', 'v', [P(2, 2, 5, 8, 8, 2)]),
	makeTemplate('w', 'w', [P(2, 2, 3.5, 8, 5, 3.5, 6.5, 8, 8, 2)]),

	// --- uppercase letters ----------------------------------------------
	makeTemplate('A', 'A', [P(2, 9, 5, 1.5, 8, 9), L(3.2, 6, 6.8, 6)]),
	makeTemplate('B', 'B', [L(2, 1.5, 2, 9), P(2, 1.5, 5, 1.5, 5, 4.5, 2, 4.5), P(2, 5, 6, 5, 6, 8.5, 2, 8.5)]),
	makeTemplate('C', 'C', [A(5, 5, 3.4, 0.2, 1.8 * Math.PI)]),
	makeTemplate('D', 'D', [B(2, 1.5, 7, 1.5, 7, 9, 2, 9)]),
	makeTemplate('E', 'E', [L(2, 1.5, 7, 1.5), L(2, 1.5, 2, 9), L(2, 5.2, 6, 5.2), L(2, 9, 7, 9)]),
	makeTemplate('F', 'F', [L(2, 1.5, 7, 1.5), L(2, 1.5, 2, 9), L(2, 5.2, 5.5, 5.2)]),
	makeTemplate('G', 'G', [A(5, 5, 3.4, 0.2, 1.35 * Math.PI), P(7.5, 4.6, 8.5, 4.6, 8.5, 7)]),
	makeTemplate('H', 'H', [L(2, 1.5, 2, 9), L(6.5, 1.5, 6.5, 9), L(2, 5.2, 6.5, 5.2)]),
	makeTemplate('I', 'I', [L(4, 1.5, 4, 9)]),
	makeTemplate('L', 'L', [L(2, 1.5, 2, 9), L(2, 9, 7, 9)]),
	makeTemplate('M', 'M', [P(2, 9, 2, 1.5, 5, 5, 8, 1.5, 8, 9)]),
	makeTemplate('N', 'N', [P(2, 9, 2, 1.5, 7, 9, 7, 1.5)]),
	makeTemplate('O', 'O', [C(5, 5, 3.2)]),
	makeTemplate('P', 'P', [L(2, 1.5, 2, 9), P(2, 1.5, 4.5, 1.5, 4.5, 5.2, 2, 5.2)]),
	makeTemplate('R', 'R', [L(2, 1.5, 2, 9), P(2, 1.5, 4.5, 1.5, 4.5, 5.2, 2, 5.2), L(4.3, 5.2, 7, 9)]),
	makeTemplate('S', 'S', [B(7.5, 1.5, 2, 3.5, 7.5, 6.5, 2, 8.5)]),
	makeTemplate('T', 'T', [L(2, 1.5, 8, 1.5), L(5, 1.5, 5, 9)]),
	makeTemplate('U', 'U', [B(2, 2, 2, 7.5, 7, 7.5, 7, 2)]),
	makeTemplate('V', 'V', [P(2, 1.5, 5, 9, 8, 1.5)]),
	makeTemplate('W', 'W', [P(2, 1.5, 3.5, 9, 5, 3, 6.5, 9, 8, 1.5)]),

	// --- operators -------------------------------------------------------
	makeTemplate('+', '+', [L(5, 1.5, 5, 8.5), L(1.5, 5, 8.5, 5)]),
	makeTemplate('-', '-', [L(1.5, 5, 8.5, 5)]),
	makeTemplate('×', '\\times', [L(1.5, 1.5, 8.5, 8.5), L(8.5, 1.5, 1.5, 8.5)]),
	makeTemplate('÷', '\\div', [DOT(5, 2), L(1.5, 5, 8.5, 5), DOT(5, 8)]),
	makeTemplate('=', '=', [L(2, 3.5, 8, 3.5), L(2, 6.5, 8, 6.5)]),
	makeTemplate('≠', '\\neq', [L(2, 3.5, 8, 3.5), L(2, 6.5, 8, 6.5), L(1.5, 5, 8.5, 5)]),
	makeTemplate('<', '<', [P(7, 1.5, 2, 5, 7, 8.5)]),
	makeTemplate('>', '>', [P(2, 1.5, 7, 5, 2, 8.5)]),
	makeTemplate('≤', '\\leq', [P(7, 1.5, 2, 5, 7, 8.5), L(2, 9.2, 8, 9.2)]),
	makeTemplate('≥', '\\geq', [P(2, 1.5, 7, 5, 2, 8.5), L(2, 9.2, 8, 9.2)]),
	makeTemplate('±', '\\pm', [L(5, 1.5, 5, 8.5), L(1.5, 5, 8.5, 5), L(2, 9.5, 8, 9.5)]),
	makeTemplate('∓', '\\mp', [L(5, 2, 5, 8.5), L(1.5, 5, 8.5, 5), L(2, 9.5, 8, 9.5)]),

	// --- greek -----------------------------------------------------------
	makeTemplate('α', '\\alpha', [P(3, 1.5, 5.5, 2.5, 5.5, 5.5, 3, 6.5, 3, 9)]),
	makeTemplate('β', '\\beta', [L(2, 1, 2, 9), B(2, 4, 1.8, 1.5, 5.5, 1.5, 5.5, 4.5)]),
	makeTemplate('γ', '\\gamma', [P(6, 1.5, 3, 6, 3, 9)]),
	makeTemplate('δ', '\\delta', [C(5, 6, 2.5), L(3, 1.5, 5, 3.5)]),
	makeTemplate('ε', '\\varepsilon', [P(6.5, 2, 3, 2, 2.5, 3, 4.5, 3.2, 2.8, 5, 3, 6.5, 5.5, 6.5)]),
	makeTemplate('θ', '\\theta', [C(5, 5, 2.8), L(5, 1.5, 5, 8.5)]),
	makeTemplate('λ', '\\lambda', [P(6.5, 1.5, 4.5, 4.5, 2, 9), L(2, 9, 7, 3.5)]),
	makeTemplate('μ', '\\mu', [P(2, 2, 2, 9, 4.5, 9, 6.5, 7, 6.5, 2)]),
	makeTemplate('π', '\\pi', [L(2, 2, 8, 2), L(2.8, 2, 2.8, 9), L(7.2, 2, 7.2, 9)]),
	makeTemplate('σ', '\\sigma', [A(5, 5, 3, 0.25 * Math.PI, 1.5 * Math.PI), L(7, 4.5, 7, 7.5)]),
	makeTemplate('φ', '\\varphi', [C(5, 5.5, 2.5), L(5, 1, 5, 9)]),
	makeTemplate('ω', '\\omega', [P(2, 2.5, 4, 8, 5, 4.5, 6, 8, 8, 2.5)]),
	makeTemplate('Δ', '\\Delta', [P(2, 9, 5, 1.5, 8, 9, 2, 9)]),
	makeTemplate('Σ', '\\Sigma', [L(2, 1.5, 8, 1.5), P(8, 1.5, 2, 5, 8, 8.5), L(2, 8.5, 8, 8.5)]),
	makeTemplate('Π', '\\Pi', [L(2, 1.5, 8, 1.5), L(2, 1.5, 2, 9), L(8, 1.5, 8, 9)]),

	// --- symbols ---------------------------------------------------------
	makeTemplate('∫', '\\int', [B(6, 1.5, 2, 2.5, 6.5, 7.5, 2, 8.5)]),
	makeTemplate('∑', '\\sum', [L(2, 1.5, 8, 1.5), P(8, 1.5, 2, 5, 8, 8.5), L(2, 8.5, 8, 8.5)]),
	makeTemplate('√', '\\sqrt', [P(2, 3.5, 5, 3.5, 6.5, 7, 8.5, 2)]),
	makeTemplate('∞', '\\infty', [
		[...A(3.2, 5, 2, 0, Math.PI * 2), ...A(6.8, 5, 2, Math.PI, Math.PI * 3)]
	]),
	makeTemplate('→', '\\rightarrow', [L(1.5, 5, 8, 5), P(8, 5, 6, 3.5, 8, 5, 6, 6.5)]),
	makeTemplate('(', '(', [A(5, 5, 3.5, 0.2, 1.8 * Math.PI)]),
	makeTemplate(')', ')', [A(5, 5, 3.5, 1.2 * Math.PI, 2.8 * Math.PI)]),
	makeTemplate('[', '[', [L(3, 1.5, 6, 1.5), L(3, 1.5, 3, 9), L(3, 9, 6, 9)]),
	makeTemplate(']', ']', [L(7, 1.5, 4, 1.5), L(7, 1.5, 7, 9), L(7, 9, 4, 9)]),
	makeTemplate('{', '{', [P(6.8, 1.5, 5, 3.2, 5, 5, 6.3, 5, 5, 5, 5, 6.8, 6.8, 8.5)]),
	makeTemplate('}', '}', [P(3.2, 1.5, 5, 3.2, 5, 5, 3.7, 5, 5, 5, 5, 6.8, 3.2, 8.5)]),
	makeTemplate('|', '|', [L(5, 1, 5, 9)]),
	makeTemplate('·', '\\cdot', [DOT(5, 5)]),
	makeTemplate('∂', '\\partial', [P(6.5, 1.5, 2.5, 3.5, 2.5, 7, 4.5, 8.5, 6, 8.5, 6, 6, 3.5, 5.5)])
];

// ---------------------------------------------------------------------------
// User-contributed templates (local-first flywheel hook, Wave 6a).
//
// `contributeTemplate` appends a template to the in-memory bank at runtime and
// persists it to localStorage (`wabi:math:templates`), which is re-merged into
// `MATH_TEMPLATES` on the next module load. This is the "user correction ->
// system improves" flywheel, local-first: no network, no server.
//
// The `strokes` argument expects ALREADY-normalized stroke feature vectors
// (e.g. the output of `normalizeSymbolStrokes`), matching `SymbolTemplate.strokes`.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'wabi:math:templates';

function loadStoredTemplates(): SymbolTemplate[] {
	try {
		if (typeof localStorage === 'undefined') return [];
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as SymbolTemplate[];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t) => t && t.symbolId && t.latex && Array.isArray(t.strokes));
	} catch {
		return [];
	}
}

function persistStoredTemplate(template: SymbolTemplate): void {
	try {
		if (typeof localStorage === 'undefined') return;
		const next = loadStoredTemplates().filter((t) => t.symbolId !== template.symbolId);
		next.push(template);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// In-memory template still applies this session; persistence is best-effort.
	}
}

for (const stored of loadStoredTemplates()) {
	MATH_TEMPLATES.push(stored);
}

/**
 * Register a user-corrected symbol with the recognizer at runtime and persist
 * it locally so it survives reload. `symbolId` defaults to `latex` when
 * omitted. Idempotent per symbolId (a re-correction replaces the older one).
 */
export function contributeTemplate(strokes: number[][], latex: string, symbolId?: string): void {
	const id = symbolId || latex;
	const template: SymbolTemplate = { symbolId: id, latex, strokes };
	MATH_TEMPLATES.push(template);
	persistStoredTemplate(template);
}
