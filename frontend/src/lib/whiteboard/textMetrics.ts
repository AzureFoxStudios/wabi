import type { TextElement, CodeElement } from './elementTypes';

/**
 * Shared text metrics — the ONE place that knows how text/code boxes are
 * measured, so the canvas renderer, the commit path and SVG export all agree
 * on box size (selection boxes, hit-testing, export bounds).
 *
 * Line height must match renderText in boardRenderer.ts and the tspan dy in
 * export.ts: both consume this constant.
 */
export const TEXT_LINE_HEIGHT_FACTOR = 1.3;

export interface TextMeasures {
	width: number;
	height: number;
}

export type LineMeasurer = (line: string, font: string) => number;

let measureCanvas: CanvasRenderingContext2D | null | undefined;

function canvasMeasurer(): LineMeasurer | null {
	if (typeof document === 'undefined') return null;
	if (measureCanvas === undefined) {
		const canvas = document.createElement('canvas');
		measureCanvas = canvas.getContext('2d');
	}
	if (!measureCanvas) return null;
	return (line, font) => {
		measureCanvas!.font = font;
		return measureCanvas!.measureText(line).width;
	};
}

/** Fallback used when no canvas 2d context exists (SSR, tests): 0.6em/char. */
function estimateMeasurer(line: string, _font: string): number {
	return line.length * 8;
}

function resolveMeasurer(): LineMeasurer {
	return canvasMeasurer() || estimateMeasurer;
}

export function textFont(fontSize: number, fontFamily: string): string {
	return `${fontSize}px ${fontFamily}`;
}

export const CODE_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export function codeFont(fontSize: number): string {
	return `${fontSize}px ${CODE_FONT_STACK}`;
}

/**
 * Measure a block of plain text lines with a given font. Returns the box the
 * renderer will actually draw (width = widest line, height = lines × lineHeight).
 */
export function measureTextLines(lines: string[], fontSize: number, fontFamily: string, measurer: LineMeasurer = resolveMeasurer()): TextMeasures {
	const font = textFont(fontSize, fontFamily);
	let width = 0;
	for (const line of lines) {
		const w = measurer(line, font);
		if (w > width) width = w;
	}
	return { width: Math.ceil(width), height: Math.ceil(lines.length * fontSize * TEXT_LINE_HEIGHT_FACTOR) };
}

export function measureText(text: string, fontSize: number, fontFamily: string, measurer?: LineMeasurer): TextMeasures {
	return measureTextLines((text || '').split('\n'), fontSize, fontFamily, measurer);
}

/**
 * Build a fully-measured TextElement. Callers supply identity + placement;
 * this fills the box so selection/hit-testing match the drawn glyphs.
 */
export function buildTextElement(params: {
	id: string;
	x: number;
	y: number;
	zIndex: number;
	layerId: string;
	text: string;
	fontSize: number;
	fontFamily: string;
	fontId?: string;
	strokeColor: string;
	strokeWidth: number;
	fillColor: string;
	createdBy?: string;
	textAlign?: TextElement['textAlign'];
	measurer?: LineMeasurer;
}): TextElement {
	const size = measureText(params.text, params.fontSize, params.fontFamily, params.measurer);
	return {
		id: params.id,
		type: 'text',
		x: params.x,
		y: params.y,
		width: Math.max(1, size.width),
		height: Math.max(1, size.height),
		rotation: 0,
		zIndex: params.zIndex,
		layerId: params.layerId,
		opacity: 1,
		strokeColor: params.strokeColor,
		strokeWidth: params.strokeWidth,
		fillColor: params.fillColor,
		createdBy: params.createdBy || '',
		updatedAt: Date.now(),
		locked: false,
		text: params.text,
		fontSize: params.fontSize,
		fontFamily: params.fontFamily,
		fontId: params.fontId,
		textAlign: params.textAlign || 'left'
	};
}

export interface CodeCardMetrics {
	/** Padding around the text inside the code card, in board units. */
	readonly padding: number;
	readonly borderRadius: number;
}

export const CODE_CARD_METRICS: CodeCardMetrics = { padding: 12, borderRadius: 8 };

/**
 * Measure a code block: monospace lines wrapped in a card. The returned box is
 * the CARD box (element.x/y/width/height); text drawing insets by the padding.
 */
export function measureCodeCard(code: string, fontSize: number, measurer?: LineMeasurer): TextMeasures {
	const lines = (code || '').split('\n');
	const text = measureTextLines(lines, fontSize, CODE_FONT_STACK, measurer);
	return {
		width: Math.ceil(text.width + CODE_CARD_METRICS.padding * 2),
		height: Math.ceil(text.height + CODE_CARD_METRICS.padding * 2)
	};
}

/** Build a fully-measured CodeElement (card box, monospace, language tag). */
export function buildCodeElement(params: {
	id: string;
	x: number;
	y: number;
	zIndex: number;
	layerId: string;
	code: string;
	language: string;
	fontSize: number;
	strokeColor?: string;
	createdBy?: string;
	measurer?: LineMeasurer;
}): CodeElement {
	const size = measureCodeCard(params.code, params.fontSize, params.measurer);
	return {
		id: params.id,
		type: 'code',
		x: params.x,
		y: params.y,
		width: Math.max(1, size.width),
		height: Math.max(1, size.height),
		rotation: 0,
		zIndex: params.zIndex,
		layerId: params.layerId,
		opacity: 1,
		strokeColor: params.strokeColor || '#e2e8f0',
		strokeWidth: 1,
		fillColor: 'transparent',
		createdBy: params.createdBy || '',
		updatedAt: Date.now(),
		locked: false,
		code: params.code,
		language: params.language,
		fontSize: params.fontSize
	};
}
