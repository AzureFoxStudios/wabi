// ---------------------------------------------------------------------------
// mathRecognition.ts — stroke-to-LaTeX recognizer (Phase 5.2, Wave 4b).
//
// Pure client-side pipeline, fully self-built (no ML infra, no network, no
// DOM, no Web Workers):
//
//   1. `segmentStrokes`   — split raw strokes into symbol groups by time and
//                           spatial gap heuristics.
//   2. `normalizeStroke`  — resample / center / indicative-angle-rotate /
//                           scale each stroke into a 128-dim feature vector.
//   3. `matchSymbol`      — k-NN against the curated template bank
//                           (`MATH_TEMPLATES`), Detexify style.
//   4. `parseStructure`   — spatial grammar over recognized symbol bboxes
//                           producing a LaTeX string.
//
// Pure functions only. Unit-testable via `runMathRecognitionTests()`.
// ---------------------------------------------------------------------------

import {
	MATH_TEMPLATES,
	normalizePointsToVector,
	normalizeSymbolStrokes,
	FEATURE_DIM,
	type Point2
} from './mathTemplates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal stroke shape consumed by the recognizer (subset of StrokeElement). */
export interface Stroke {
	points: Point2[];
	layerId?: string;
	zIndex?: number;
	/** Optional per-stroke wall-clock ms for the time-gap segmentation rule. */
	timestamp?: number;
}

export interface BBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RecognizedSymbol {
	symbolId: string;
	latex: string;
	bbox: BBox;
	confidence: number;
}

export interface SymbolCandidate {
	symbolId: string;
	latex: string;
	distance: number;
	confidence: number;
}

export interface RecognitionResult {
	latex: string;
	confidence: number;
	symbols: RecognizedSymbol[];
	/** True when any symbol matched below the confidence bar (caller may prompt to edit). */
	partial: boolean;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A pen lift longer than this (ms) starts a new symbol, even if overlapping. */
export const TIME_GAP_MS = 500;
/** Spatial split: disjoint bboxes AND center distance above this many avg sizes. */
export const SPACE_GAP_FACTOR = 2.5;
/** k-NN neighbours considered. */
export const K_NEIGHBOURS = 5;
/** Per unmatched stroke when input/template stroke counts differ. */
export const EXTRA_STROKE_PENALTY = 16;
/** Absolute-quality scaling for confidence (see `matchSymbol`). */
export const ABS_CONF_SCALE = 0.4;
/** Symbols matching below this confidence mark the result `partial`. */
export const PARTIAL_CONFIDENCE = 0.3;

// ---------------------------------------------------------------------------
// Stage 1a — normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a single stroke: resample to 64 arc-even points, translate the
 * centroid to the origin, rotate to the indicative angle, scale to a unit
 * bounding box. Returns the normalized 64 points, or null for degenerate
 * input (single point / zero extent).
 */
export function normalizeStroke(stroke: Stroke): Point2[] | null {
	const v = normalizePointsToVector(stroke.points);
	if (!v) return null;
	const pts: Point2[] = [];
	for (let i = 0; i < v.length; i += 2) pts.push({ x: v[i], y: v[i + 1] });
	return pts;
}

/** Flatten normalized points into the 128-dim feature vector. */
export function toFeature(points: Point2[]): number[] {
	const flat: number[] = [];
	for (const p of points) {
		flat.push(p.x, p.y);
	}
	return flat;
}

/** Normalize + flatten a stroke in one step; null for degenerate strokes. */
export function strokeToFeature(stroke: Stroke): number[] | null {
	return normalizePointsToVector(stroke.points);
}

// ---------------------------------------------------------------------------
// Stage 1b — feature distance
// ---------------------------------------------------------------------------

function splitFeatures(flat: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < flat.length; i += FEATURE_DIM) out.push(flat.slice(i, i + FEATURE_DIM));
	return out;
}

/** Sum of squared Euclidean distances over the 128 dims. */
function featureDistance(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let d = 0;
	for (let i = 0; i < n; i++) {
		const diff = a[i] - b[i];
		d += diff * diff;
	}
	return d;
}

/** 180-degree rotation of a feature (handles strokes drawn end-to-end reversed). */
function negateFeature(v: number[]): number[] {
	const out = v.slice();
	for (let i = 0; i < FEATURE_DIM - 1; i++) out[i] = -out[i];
	return out;
}

/**
 * Distance from the input feature stream to a template: stroke-by-stroke in
 * writing order (counts differ → flat penalty per extra stroke), comparing
 * each stroke against the template stroke and its 180-degree negation and
 * taking the closer.
 */
function distanceToTemplate(input: number[], tplStrokes: number[][]): number {
	const inputStrokes = splitFeatures(input);
	const min = Math.min(inputStrokes.length, tplStrokes.length);
	let d = 0;
	for (let i = 0; i < min; i++) {
		const a = inputStrokes[i];
		const b = tplStrokes[i];
		d += Math.min(featureDistance(a, b), featureDistance(a, negateFeature(b)));
	}
	d += Math.abs(inputStrokes.length - tplStrokes.length) * EXTRA_STROKE_PENALTY;
	return d;
}

// ---------------------------------------------------------------------------
// Stage 1c — k-NN matcher
// ---------------------------------------------------------------------------

/**
 * Match a stroke group against the template bank (k-NN). The feature vector
 * is the concatenation of each stroke's 128-dim normalized vector, compared
 * stroke-by-stroke in order.
 *
 * Confidence follows the spec's `1 / (1 + dist/bestDist)` shape, scaled by an
 * absolute-quality term so that a genuinely bad match scores low even when it
 * is the best candidate. The best candidate therefore lands around 0.45-0.5
 * for a clean match and drops below 0.3 when the best distance is large.
 */
export function matchSymbol(strokes: Stroke[], k: number = K_NEIGHBOURS): SymbolCandidate[] {
	const inputFeatures = normalizeSymbolStrokes(strokes.map((s) => s.points));
	const input: number[] = [];
	for (const v of inputFeatures) {
		if (v.length !== FEATURE_DIM) return [];
		input.push(...v);
	}

	const candidates: SymbolCandidate[] = MATH_TEMPLATES.map((tpl) => ({
		symbolId: tpl.symbolId,
		latex: tpl.latex,
		distance: distanceToTemplate(input, tpl.strokes),
		confidence: 0
	}));
	candidates.sort((a, b) => a.distance - b.distance);

	const best = candidates[0]?.distance ?? 0;
	const absFactor = 1 / (1 + best * ABS_CONF_SCALE);
	// A floor on the normalization distance keeps `1 / (1 + dist/best)`
	// well-behaved when the best match is near-perfect (best ≈ 0), while the
	// absolute factor still crushes confidence when even the best is poor.
	const normBest = Math.max(best, 1);
	const top = candidates.slice(0, Math.min(k, candidates.length));
	for (const c of top) {
		const specConf = 1 / (1 + c.distance / normBest);
		c.confidence = Math.min(1, specConf * absFactor);
	}
	return top;
}

// ---------------------------------------------------------------------------
// Stage 1d — segmentation
// ---------------------------------------------------------------------------

function strokeBBox(pts: Point2[]): BBox | null {
	if (pts.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function maxDim(b: BBox): number {
	return Math.max(b.width, b.height, 1);
}

function strokeTime(s: Stroke): number {
	const any = s as { timestamp?: number; t?: number };
	return typeof any.timestamp === 'number' ? any.timestamp : typeof any.t === 'number' ? any.t : 0;
}

/**
 * True when the two strokes belong to different symbols: a time gap above
 * `TIME_GAP_MS`, or a spatial gap (bounding boxes don't overlap AND center
 * distance above `SPACE_GAP_FACTOR` x the average stroke size).
 */
export function isNewSymbolBoundary(prev: Stroke, cur: Stroke): boolean {
	const t0 = strokeTime(prev);
	const t1 = strokeTime(cur);
	if (t0 > 0 && t1 > 0 && t1 - t0 > TIME_GAP_MS) return true;

	const a = strokeBBox(prev.points);
	const b = strokeBBox(cur.points);
	if (!a || !b) return true;

	const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	const overlaps = overlapX > 0 && overlapY > 0;

	const avgSize = (maxDim(a) + maxDim(b)) / 2;
	const c1 = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
	const c2 = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	const centerDist = Math.hypot(c2.x - c1.x, c2.y - c1.y);

	return !overlaps && centerDist > SPACE_GAP_FACTOR * avgSize;
}

/**
 * Group strokes into symbol clusters using the gap heuristics above. Each
 * returned cluster is intended to be matched as one symbol.
 */
export function segmentStrokes(strokes: Stroke[]): Stroke[][] {
	if (strokes.length === 0) return [];
	const groups: Stroke[][] = [[strokes[0]]];
	for (let i = 1; i < strokes.length; i++) {
		if (isNewSymbolBoundary(strokes[i - 1], strokes[i])) {
			groups.push([strokes[i]]);
		} else {
			groups[groups.length - 1].push(strokes[i]);
		}
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Stage 2 — structure parser (spatial grammar)
// ---------------------------------------------------------------------------

function bboxCenter(b: BBox): { x: number; y: number } {
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const INLINE_OPERATORS = new Set(['+', '-', '×', '÷', '=', '≠', '<', '>', '≤', '≥', '±', '∓']);

const PAREN_LATEX: Record<string, { open: string; close: string }> = {
	'(': { open: '(', close: ')' },
	'[': { open: '[', close: ']' },
	'{': { open: '\\{', close: '\\}' }
};

function isInlineOperator(symbolId: string): boolean {
	return INLINE_OPERATORS.has(symbolId);
}

/** Superscript: small, sitting high, to the right of the base. */
function isSuperscript(s: RecognizedSymbol, base: RecognizedSymbol): boolean {
	const bh = base.bbox.height;
	if (bh <= 0) return false;
	if (s.bbox.height > 0.45 * bh) return false;
	const c = bboxCenter(s.bbox);
	if (c.y >= base.bbox.y + 0.35 * bh) return false;
	if (c.x <= bboxCenter(base.bbox).x) return false;
	return true;
}

/** Subscript: small, sitting low, to the right of the base. */
function isSubscript(s: RecognizedSymbol, base: RecognizedSymbol): boolean {
	const bh = base.bbox.height;
	if (bh <= 0) return false;
	if (s.bbox.height > 0.45 * bh) return false;
	const c = bboxCenter(s.bbox);
	if (c.y <= base.bbox.y + base.bbox.height - 0.35 * bh) return false;
	if (c.x <= bboxCenter(base.bbox).x) return false;
	return true;
}

/**
 * Collect the run of immediately-following symbols that attach to `base` as
 * superscript/subscript (writing order). Returns the LaTeX of each and how
 * many symbols were consumed.
 */
function collectScripts(
	syms: RecognizedSymbol[],
	startIdx: number,
	base: RecognizedSymbol
): { sup: string | null; sub: string | null; consumed: number } {
	let sup: string | null = null;
	let sub: string | null = null;
	let i = startIdx;
	while (i < syms.length) {
		const s = syms[i];
		if (isInlineOperator(s.symbolId)) break;
		if (s.symbolId === '√' || s.symbolId === '∫' || s.symbolId === '∑') break;
		if (isSuperscript(s, base)) {
			sup = s.latex;
		} else if (isSubscript(s, base)) {
			sub = s.latex;
		} else {
			break;
		}
		i++;
	}
	return { sup, sub, consumed: i - startIdx };
}

function findMatchingClose(syms: RecognizedSymbol[], openIdx: number, close: string): number {
	let depth = 0;
	for (let j = openIdx; j < syms.length; j++) {
		const id = syms[j].symbolId;
		if (PAREN_LATEX[id]) {
			depth += 1;
		} else if (id === close) {
			depth -= 1;
			if (depth === 0) return j;
		}
	}
	return -1;
}

/** Integral: `\int <integrand> \,dx` when a trailing `d` exists. */
function renderIntegral(syms: RecognizedSymbol[], idx: number): string {
	const rest = syms.slice(idx + 1);
	// A trailing 'd' that is not the very first symbol after ∫ is the `d` of dx.
	const dxIdx = rest.findIndex((r, j) => r.symbolId === 'd' && j >= 1);
	if (dxIdx >= 0) {
		const integrand = renderRow(rest.slice(0, dxIdx));
		const tail = rest.slice(dxIdx);
		let out = `\\int ${integrand} \\,dx`;
		if (tail.length > 2) out += ` ${renderRow(tail.slice(2))}`;
		return out;
	}
	return `\\int ${renderRow(rest)}`;
}

/**
 * Render one horizontal run of symbols: inline operators pass through as-is,
 * active symbols (√ ∫ ∑) expand, parens group into `\left ... \right`, and
 * plain atoms collect superscript/subscript attachments.
 */
function renderRow(syms: RecognizedSymbol[]): string {
	const sorted = [...syms].sort((a, b) => bboxCenter(a.bbox).x - bboxCenter(b.bbox).x);
	let out = '';
	let i = 0;
	while (i < sorted.length) {
		const s = sorted[i];

		if (isInlineOperator(s.symbolId)) {
			out += s.latex;
			i++;
			continue;
		}

		if (s.symbolId === '√') {
			out += `\\sqrt{${renderRow(sorted.slice(i + 1))}}`;
			break;
		}

		if (s.symbolId === '∫') {
			out += renderIntegral(sorted, i);
			break;
		}

		if (s.symbolId === '∑') {
			const sc = collectScripts(sorted, i + 1, s);
			if (sc.sub || sc.sup) out += `\\sum_{${sc.sub || ''}}${sc.sup ? `^{${sc.sup}}` : ''}`;
			else out += '\\sum';
			i += 1 + sc.consumed;
			continue;
		}

		if (PAREN_LATEX[s.symbolId]) {
			const p = PAREN_LATEX[s.symbolId];
			const closeIdx = findMatchingClose(sorted, i, p.close);
			if (closeIdx >= 0) {
				const inner = renderRow(sorted.slice(i + 1, closeIdx));
				out += `\\left${p.open} ${inner} \\right${p.close}`;
				i = closeIdx + 1;
				continue;
			}
			out += p.open;
			i++;
			continue;
		}

		const sc = collectScripts(sorted, i + 1, s);
		out += s.latex;
		if (sc.sub) out += `_{${sc.sub}}`;
		if (sc.sup) out += `^{${sc.sup}}`;
		i += 1 + sc.consumed;
	}
	return out;
}

function unionBBox(syms: RecognizedSymbol[]): BBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of syms) {
		const b = s.bbox;
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

function yOverlap(a: BBox, b: BBox): boolean {
	return a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Group symbols whose vertical extents overlap into horizontal "rows". */
function clusterRows(symbols: RecognizedSymbol[]): RecognizedSymbol[][] {
	const sorted = [...symbols].sort((a, b) => a.bbox.y - b.bbox.y);
	const rows: RecognizedSymbol[][] = [];
	for (const s of sorted) {
		let placed = false;
		for (const row of rows) {
			if (yOverlap(s.bbox, unionBBox(row))) {
				row.push(s);
				placed = true;
				break;
			}
		}
		if (!placed) rows.push([s]);
	}
	for (const row of rows) {
		row.sort((a, b) => bboxCenter(a.bbox).x - bboxCenter(b.bbox).x);
	}
	return rows;
}

/**
 * Fraction heuristic between an upper row (numerator) and lower row
 * (denominator): overlapping x-footprints, similar widths and heights, small
 * vertical gap, and aligned x-centers.
 */
function isFractionPair(numRow: RecognizedSymbol[], denRow: RecognizedSymbol[]): boolean {
	const numB = unionBBox(numRow);
	const denB = unionBBox(denRow);
	const overlap = Math.min(numB.x + numB.width, denB.x + denB.width) - Math.max(numB.x, denB.x);
	if (overlap <= 0) return false;
	if (overlap / Math.max(numB.width, denB.width) < 0.35) return false;
	const wRatio = Math.max(numB.width, denB.width) / Math.max(1e-6, Math.min(numB.width, denB.width));
	if (wRatio > 3.2) return false;
	const hRatio = Math.max(numB.height, denB.height) / Math.max(1e-6, Math.min(numB.height, denB.height));
	if (hRatio > 2.5) return false;
	const gap = denB.y - (numB.y + numB.height);
	if (gap > 0.3 * Math.max(numB.height, denB.height)) return false;
	const numCx = numB.x + numB.width / 2;
	const denCx = denB.x + denB.width / 2;
	if (Math.abs(numCx - denCx) > 0.4 * Math.max(numB.width, denB.width)) return false;
	return true;
}

/**
 * Merge script-like rows (small height, x-overlapping) into their adjacent
 * base row. Superscripts/subscripts drawn fully outside the base's vertical
 * bbox land in their own row; this pass folds them back so `renderRow`'s
 * script collector sees them. Returns a new row list.
 */
function absorbScriptRows(rows: RecognizedSymbol[][]): RecognizedSymbol[][] {
	const result = rows.map((r) => r.slice());
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < result.length - 1; i++) {
			const A = unionBBox(result[i]);
			const B = unionBBox(result[i + 1]);
			const xOverlap = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x);
			if (xOverlap <= 0) continue;
			const aH = A.height;
			const bH = B.height;
			// row i is a small row sitting above row i+1 (superscript).
			if (aH > 0 && bH > 0 && aH / bH <= 0.6) {
				result[i + 1] = result[i].concat(result[i + 1]);
				result.splice(i, 1);
				changed = true;
				break;
			}
			// row i+1 is a small row sitting below row i (subscript).
			if (aH > 0 && bH > 0 && bH / aH <= 0.6) {
				result[i] = result[i].concat(result[i + 1]);
				result.splice(i + 1, 1);
				changed = true;
				break;
			}
		}
	}
	return result;
}

/**
 * Render a stack of rows. Script rows are first absorbed into their base
 * rows; adjacent rows that satisfy the fraction heuristic become
 * `\frac{num}{den}` (each side recursed); remaining rows render left-to-right
 * with scripting.
 */
function renderRows(rows: RecognizedSymbol[][]): string {
	rows = absorbScriptRows(rows);
	const parts: string[] = [];
	let i = 0;
	while (i < rows.length) {
		if (i + 1 < rows.length && isFractionPair(rows[i], rows[i + 1])) {
			parts.push(`\\frac{${parseStructure(rows[i])}}{${parseStructure(rows[i + 1])}}`);
			i += 2;
			continue;
		}
		parts.push(renderRow(rows[i]));
		i += 1;
	}
	return parts.join(' ');
}

/**
 * Spatial grammar over recognized symbols → LaTeX. Symbols are clustered into
 * rows by vertical overlap, rows are read left-to-right, and superscript /
 * subscript / fraction / sqrt / integral / sum / paren relationships are
 * emitted from bbox geometry.
 */
export function parseStructure(symbols: RecognizedSymbol[]): string {
	if (symbols.length === 0) return '';
	return renderRows(clusterRows(symbols));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function groupBBox(group: Stroke[]): BBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of group) {
		for (const p of s.points) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
	}
	if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Full pipeline: segment → match → parse.
 *
 * - `latex`      : parsed LaTeX string.
 * - `confidence` : min per-symbol confidence (0..1).
 * - `symbols`    : recognized symbols, left-to-right, in original coords.
 * - `partial`    : true when any symbol matched below `PARTIAL_CONFIDENCE`.
 */
export function recognizeStrokes(strokes: Stroke[]): RecognitionResult {
	const groups = segmentStrokes(strokes);
	const symbols: RecognizedSymbol[] = [];

	for (const group of groups) {
		if (group.length === 0) continue;
		const top = matchSymbol(group, K_NEIGHBOURS)[0];
		if (!top) continue;
		symbols.push({
			symbolId: top.symbolId,
			latex: top.latex,
			bbox: groupBBox(group),
			confidence: top.confidence
		});
	}

	symbols.sort((a, b) => bboxCenter(a.bbox).x - bboxCenter(b.bbox).x);

	const latex = parseStructure(symbols);
	const partial = symbols.some((s) => s.confidence < PARTIAL_CONFIDENCE);
	const confidence =
		symbols.length > 0 ? Math.min(...symbols.map((s) => s.confidence)) : 0;

	return { latex, confidence, symbols, partial };
}

// ---------------------------------------------------------------------------
// Self-test (pure TS, no bun:test — the repo's svelte-check lacks the
// bun:test module; these are known pre-existing errors we must not extend).
// Run with: esbuild bundle + node, or npx tsx.
// ---------------------------------------------------------------------------

export function runMathRecognitionTests(): { pass: number; fail: number } {
	let pass = 0;
	let fail = 0;
	const check = (name: string, cond: boolean, detail?: string) => {
		if (cond) {
			pass++;
			console.log(`PASS ${name}`);
		} else {
			fail++;
			console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
		}
	};

	// --- drawing helpers -------------------------------------------------
	const mk = (pts: Point2[], ts?: number): Stroke => ({ points: pts, timestamp: ts });
	const L = (x0: number, y0: number, x1: number, y1: number) => {
		const out: Point2[] = [];
		const steps = 12;
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
		}
		return out;
	};
	const P = (pts: number[][]) => pts.map(([x, y]) => ({ x, y }));
	const B = (
		p0x: number, p0y: number, p1x: number, p1y: number,
		p2x: number, p2y: number, p3x: number, p3y: number, steps = 22
	) => {
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
	};
	const A = (cx: number, cy: number, r: number, a0: number, a1: number, steps = 22) => {
		const out: Point2[] = [];
		for (let i = 0; i <= steps; i++) {
			const a = a0 + ((a1 - a0) * i) / steps;
			out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
		}
		return out;
	};

	// --- normalizer ------------------------------------------------------
	{
		const line = mk(L(0, 0, 100, 50));
		const norm = normalizeStroke(line);
		check('normalizeStroke returns 64 points', !!norm && norm.length === 64);
		if (norm) {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of norm) {
				if (p.x < minX) minX = p.x;
				if (p.y < minY) minY = p.y;
				if (p.x > maxX) maxX = p.x;
				if (p.y > maxY) maxY = p.y;
			}
			const size = Math.max(maxX - minX, maxY - minY);
			check('normalized stroke fits unit box', Math.abs(size - 1) < 1e-6, `size=${size}`);
		}
		check('degenerate single point -> null', normalizeStroke(mk([{ x: 5, y: 5 }])) === null);
		check(
			'degenerate zero-length -> null',
			normalizeStroke(mk([{ x: 5, y: 5 }, { x: 5, y: 5 }])) === null
		);
		check('strokeToFeature has 128 dims', (strokeToFeature(line) || []).length === 128);
	}

	// --- segmentation ----------------------------------------------------
	{
		const a = mk(L(0, 0, 10, 10), 100);
		const bOverlap = mk(L(5, 5, 20, 20), 200);
		const bFar = mk(L(100, 100, 120, 120), 200);
		const bTime = mk(L(5, 5, 20, 20), 900);

		check('overlapping strokes stay grouped', segmentStrokes([a, bOverlap]).length === 1);
		check('far-apart strokes split', segmentStrokes([a, bFar]).length === 2);
		check('time gap splits even when overlapping', segmentStrokes([a, bTime]).length === 2);
		check('empty input', segmentStrokes([]).length === 0);
	}

	// --- k-NN matching ---------------------------------------------------
	{
		const two = mk(P([[20, 28], [50, 10], [78, 30], [45, 60], [20, 85], [80, 85]]), 100);
		const plus = [mk(L(50, 15, 50, 85), 100), mk(L(15, 50, 85, 50), 100)];
		const eq = [mk(L(20, 35, 80, 35), 100), mk(L(20, 65, 80, 65), 100)];
		const sqrt = mk(P([[20, 35], [50, 35], [65, 70], [85, 20]]), 100);

		const twoTop = matchSymbol([two])[0];
		const plusTop = matchSymbol(plus)[0];
		const eqTop = matchSymbol(eq)[0];
		const sqrtTop = matchSymbol([sqrt])[0];

		check('matchSymbol: 2 -> 2', !!twoTop && twoTop.symbolId === '2', twoTop?.symbolId);
		check('matchSymbol: + -> +', !!plusTop && plusTop.symbolId === '+', plusTop?.symbolId);
		check('matchSymbol: = -> =', !!eqTop && eqTop.symbolId === '=', eqTop?.symbolId);
		check('matchSymbol: sqrt -> √', !!sqrtTop && sqrtTop.symbolId === '√', sqrtTop?.symbolId);
		check(
			'candidates ranked, confidence within (0,1]',
			matchSymbol([two]).every((c) => c.confidence > 0 && c.confidence <= 1)
		);
	}

	// --- structure parser (constructed symbols) --------------------------
	const sym = (
		id: string, latex: string, x: number, y: number, w: number, h: number
	): RecognizedSymbol => ({ symbolId: id, latex, bbox: { x, y, width: w, height: h }, confidence: 0.5 });

	{
		const x = sym('x', 'x', 0, 20, 40, 60);
		const plus = sym('+', '+', 60, 30, 30, 40);
		const y = sym('y', 'y', 110, 20, 40, 60);
		const eq = sym('=', '=', 170, 35, 40, 30);
		const z = sym('z', 'z', 230, 20, 40, 60);
		check('parse: x+y=z', parseStructure([x, plus, y, eq, z]) === 'x+y=z', parseStructure([x, plus, y, eq, z]));
	}

	{
		const x = sym('x', 'x', 0, 20, 40, 60);
		const two = sym('2', '2', 45, 5, 20, 22);
		const sup = parseStructure([x, two]);
		check('parse: superscript x^2', sup === 'x^{2}', sup);
	}

	{
		const a = sym('a', 'a', 0, 10, 40, 45);
		const b = sym('b', 'b', 5, 62, 40, 45);
		const frac = parseStructure([a, b]);
		check('parse: fraction a/b', frac === '\\frac{a}{b}', frac);
	}

	{
		const a = sym('a', 'a', 0, 30, 40, 60);
		const one = sym('1', '1', 42, 62, 14, 20);
		const sub = parseStructure([a, one]);
		check('parse: subscript a_1', sub === 'a_{1}', sub);
	}

	{
		const sq = sym('√', '\\sqrt', 0, 30, 30, 60);
		const x = sym('x', 'x', 40, 30, 30, 60);
		const root = parseStructure([sq, x]);
		check('parse: sqrt', root === '\\sqrt{x}', root);
	}

	{
		const i = sym('∫', '\\int', 0, 10, 25, 80);
		const x1 = sym('x', 'x', 40, 30, 30, 50);
		const d = sym('d', 'd', 90, 30, 30, 50);
		const x2 = sym('x', 'x', 130, 30, 30, 50);
		const intg = parseStructure([i, x1, d, x2]);
		check('parse: integral with dx', intg === '\\int x \\,dx', intg);
	}

	{
		const sum = sym('∑', '\\sum', 0, 30, 50, 60);
		const i = sym('i', 'i', 30, 70, 14, 18);
		const n = sym('n', 'n', 30, 5, 14, 18);
		const s = parseStructure([sum, i, n]);
		check('parse: sum with sub/sup', s === '\\sum_{i}^{n}', s);
	}

	{
		const l = sym('(', '(', 0, 10, 15, 80);
		const x = sym('x', 'x', 25, 25, 30, 50);
		const plus = sym('+', '+', 60, 30, 25, 40);
		const y = sym('y', 'y', 90, 25, 30, 50);
		const r = sym(')', ')', 130, 10, 15, 80);
		const p = parseStructure([l, x, plus, y, r]);
		check('parse: parens', p === '\\left( x+y \\right)', p);
	}

	{
		const alpha = sym('α', '\\alpha', 0, 25, 40, 50);
		const plus = sym('+', '+', 50, 30, 30, 40);
		const beta = sym('β', '\\beta', 90, 25, 40, 50);
		const g = parseStructure([alpha, plus, beta]);
		check('parse: greek sum', g === '\\alpha+\\beta', g);
	}

	// --- end-to-end ------------------------------------------------------
	{
		// template-proportional glyphs in distinct x-bands, time-gap separated.
		const d2 = mk(P([[20, 28], [50, 10], [78, 30], [45, 60], [20, 85], [80, 85]]), 100);
		const dPlus = [mk(L(200, 15, 200, 85), 700), mk(L(165, 50, 235, 50), 700)];
		const d3 = mk(B(380, 12, 325, 35, 380, 60, 325, 90), 1300);
		const dEq = [mk(L(470, 35, 530, 35), 1900), mk(L(470, 65, 530, 65), 1900)];
		const d5 = mk(P([[665, 15], [620, 15], [620, 45], [660, 45], [660, 90], [625, 90]]), 2500);
		const res = recognizeStrokes([d2, ...dPlus, d3, ...dEq, d5]);
		check('e2e: 2+3=5', res.latex === '2+3=5', res.latex);
		check('e2e: partial false for clean input', res.partial === false);
	}

	{
		const y1 = mk(P([[80, 15], [50, 55], [40, 90]]), 100);
		const y2 = mk(L(20, 15, 50, 55), 150);
		const sup2 = mk(P([[73, 6.2], [85, -1], [96.2, 7], [83, 19], [73, 29], [97, 29]]), 700);
		const res = recognizeStrokes([y1, y2, sup2]);
		check('e2e: y^2', res.latex === 'y^{2}', res.latex);
	}

	{
		// poor scribble -> low confidence -> partial
		const scribble = mk(
			Array.from({ length: 30 }, (_, i) => ({
				x: (i * 17) % 100,
				y: ((i * 37) % 100)
			})),
			100
		);
		const res = recognizeStrokes([scribble]);
		check('e2e: scribble flags partial', res.partial === true, `conf=${res.confidence.toFixed(3)}`);
	}

	{
		// a over b, drawn on separate vertical bands so they segment apart.
		const aStrokes = mk(P([[24, 32], [17.6, 16], [40, 12], [52, 28], [52, 40], [48, 64]]), 100);
		const bStrokes = [
			mk(L(12, 76, 12, 124), 700),
			mk(B(12, 94, 10.8, 82, 36, 82, 36, 103), 700)
		];
		const res = recognizeStrokes([aStrokes, ...bStrokes]);
		check('e2e: a/b', res.latex === '\\frac{a}{b}', res.latex);
	}

	console.log(`\nmathRecognition self-test: ${pass} passed, ${fail} failed`);
	return { pass, fail };
}
