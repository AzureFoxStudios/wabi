// ---------------------------------------------------------------------------
// recognitionUi.ts — pure logic bridging the stroke->LaTeX recognizer into the
// whiteboard UI (Phase 5.5, Wave 6a).
//
//   1. `extractStrokeSelection`       — pull the selected stroke elements out
//                                       of board state (selection order, no
//                                       locked elements).
//   2. `buildMathElementFromRecognition` — turn a recognized formula + the
//                                       strokes it came from into a MathElement
//                                       positioned over their bbox.
//   3. `formatConfidence`             — human label for a 0..1 confidence.
//
// Pure functions only: no DOM, no stores, no network. Importing `mathRender`
// and `coords` is safe here (neither imports back into this module).
// ---------------------------------------------------------------------------

import { getElementBBox, type BBox } from './coords';
import { measureMathElement } from './mathRender';
import { generateElementId, type BoardElement, type MathElement, type StrokeElement } from './elementTypes';

/** Data captured from a successful recognition, shown in the preview modal. */
export interface RecognitionDraft {
	latex: string;
	confidence: number;
	partial: boolean;
}

/**
 * The selected elements whose `type` is `'stroke'`, in selection order, with
 * locked elements skipped. Callers feed this straight into the recognizer.
 */
export function extractStrokeSelection(state: {
	elements: BoardElement[];
	selection: Set<string>;
}): StrokeElement[] {
	const byId = new Map<string, BoardElement>();
	for (const el of state.elements) byId.set(el.id, el);
	const out: StrokeElement[] = [];
	for (const id of state.selection) {
		const el = byId.get(id);
		if (el && el.type === 'stroke' && !el.locked) out.push(el);
	}
	return out;
}

/** Union bbox over every point of every selected stroke. */
function unionStrokeBBox(strokes: StrokeElement[]): BBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of strokes) {
		const b = getElementBBox(s);
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	return {
		x: minX,
		y: minY,
		width: Math.max(0, maxX - minX),
		height: Math.max(0, maxY - minY)
	};
}

/**
 * Build a MathElement from the recognized formula. The element is centered on
 * the union bbox of the source strokes, sized by `measureMathElement` so its
 * bbox matches the rendered glyph, and lifted one z-level above the strokes it
 * replaces (their layer's current top).
 */
export function buildMathElementFromRecognition(
	strokes: StrokeElement[],
	latex: string,
	fontSize = 32
): MathElement {
	const trimmed = (latex || '').trim();
	const bbox = unionStrokeBBox(strokes);
	const size = measureMathElement(trimmed, fontSize);
	const first = strokes[0];
	const maxZ = strokes.reduce((max, s) => Math.max(max, s.zIndex), 0);

	return {
		id: generateElementId(),
		type: 'math',
		x: bbox.x + (bbox.width - size.width) / 2,
		y: bbox.y + (bbox.height - size.height) / 2,
		width: size.width,
		height: size.height,
		rotation: 0,
		zIndex: maxZ + 1,
		layerId: first.layerId,
		opacity: 1,
		strokeColor: first.strokeColor,
		strokeWidth: first.strokeWidth,
		fillColor: 'transparent',
		createdBy: first.createdBy || '',
		updatedAt: Date.now(),
		locked: false,
		latex: trimmed,
		fontSize
	};
}

/** 'High' for >= 0.7, 'Medium' for >= 0.4, 'Low' below. */
export function formatConfidence(confidence: number): string {
	if (confidence >= 0.7) return 'High';
	if (confidence >= 0.4) return 'Medium';
	return 'Low';
}
