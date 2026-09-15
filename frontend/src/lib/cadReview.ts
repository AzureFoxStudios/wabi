import type {
	ArrowElement,
	EllipseElement,
	Point,
	RectElement,
	StrokeElement,
	TextElement
} from '$lib/whiteboard/elementTypes';
import { generateElementId } from '$lib/whiteboard/elementTypes';
import { normalizeRect } from '$lib/whiteboard/coords';

export type CadReviewTool = 'pan' | 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'eraser';
export type CadReviewElement = StrokeElement | ArrowElement | RectElement | EllipseElement | TextElement;

export const CAD_REVIEW_COLORS = ['#f8fafc', '#facc15', '#fb7185', '#38bdf8', '#4ade80'] as const;
export const CAD_REVIEW_WIDTHS = [1.5, 3, 5] as const;

export interface CadReviewStyle {
	strokeColor: string;
	strokeWidth: number;
}

const REVIEW_LAYER_ID = 'cad-review';

function baseElement(type: CadReviewElement['type'], x: number, y: number, style: CadReviewStyle, zIndex: number) {
	return {
		id: generateElementId(),
		type,
		x,
		y,
		width: 0,
		height: 0,
		rotation: 0,
		zIndex,
		layerId: REVIEW_LAYER_ID,
		opacity: 1,
		strokeColor: style.strokeColor,
		strokeWidth: style.strokeWidth,
		fillColor: 'transparent',
		createdBy: 'cad-review',
		updatedAt: Date.now(),
		locked: false
	};
}

function strokeBounds(points: Point[]): { x: number; y: number; width: number; height: number } {
	if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Keep pen traffic compact without converting review marks into screen-space data. */
export function simplifyCadReviewPoints(points: Point[], minDistance: number): Point[] {
	if (points.length <= 2) return points.map((point) => ({ ...point }));
	const threshold = Math.max(0, minDistance);
	const output: Point[] = [{ ...points[0] }];
	for (let index = 1; index < points.length - 1; index += 1) {
		const point = points[index];
		const last = output[output.length - 1];
		if (Math.hypot(point.x - last.x, point.y - last.y) >= threshold) output.push({ ...point });
	}
	output.push({ ...points[points.length - 1] });
	return output;
}

export function createCadReviewStroke(points: Point[], style: CadReviewStyle, zIndex: number): StrokeElement {
	const safePoints = points.map((point) => ({ x: point.x, y: point.y, pressure: point.pressure }));
	return {
		...baseElement('stroke', safePoints[0]?.x ?? 0, safePoints[0]?.y ?? 0, style, zIndex),
		...strokeBounds(safePoints),
		type: 'stroke',
		points: safePoints
	};
}

export function createCadReviewShape(
	tool: 'arrow' | 'rect' | 'ellipse',
	start: Point,
	end: Point,
	style: CadReviewStyle,
	zIndex: number
): ArrowElement | RectElement | EllipseElement {
	const base = baseElement(tool, start.x, start.y, style, zIndex);
	if (tool === 'arrow') {
		return { ...base, type: 'arrow', width: end.x - start.x, height: end.y - start.y, arrowHead: 'end' };
	}
	const box = normalizeRect(start.x, start.y, end.x - start.x, end.y - start.y);
	if (tool === 'rect') return { ...base, ...box, type: 'rect', borderRadius: 0 };
	return { ...base, ...box, type: 'ellipse' };
}

export function createCadReviewText(
	point: Point,
	text: string,
	fontSize: number,
	style: CadReviewStyle,
	zIndex: number
): TextElement {
	const value = text.trim();
	const safeFontSize = Math.max(0.0001, Math.abs(fontSize));
	return {
		...baseElement('text', point.x, point.y, style, zIndex),
		type: 'text',
		text: value,
		fontSize: safeFontSize,
		fontFamily: 'sans-serif',
		textAlign: 'left',
		width: Math.max(safeFontSize, value.length * safeFontSize * 0.58),
		height: safeFontSize * 1.25,
		fillColor: style.strokeColor
	};
}

export function cloneCadReviewElement(element: CadReviewElement): CadReviewElement {
	if (element.type === 'stroke') return { ...element, points: element.points.map((point) => ({ ...point })) };
	return { ...element };
}

export function cloneCadReviewElements(elements: CadReviewElement[]): CadReviewElement[] {
	return elements.map(cloneCadReviewElement);
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** Narrow untrusted whiteboard transport elements before rendering them in the CAD overlay. */
export function asCadReviewElement(raw: unknown): CadReviewElement | null {
	if (!raw || typeof raw !== 'object') return null;
	const value = raw as Record<string, unknown>;
	if (!['stroke', 'arrow', 'rect', 'ellipse', 'text'].includes(String(value.type))) return null;
	if (typeof value.id !== 'string' || !value.id || !finite(value.x) || !finite(value.y) ||
		!finite(value.width) || !finite(value.height) || !finite(value.zIndex) || !finite(value.strokeWidth) ||
		typeof value.strokeColor !== 'string') return null;
	const common = {
		...value,
		layerId: REVIEW_LAYER_ID,
		opacity: finite(value.opacity) ? Math.max(0, Math.min(1, value.opacity)) : 1,
		rotation: finite(value.rotation) ? value.rotation : 0,
		fillColor: typeof value.fillColor === 'string' ? value.fillColor : 'transparent',
		createdBy: typeof value.createdBy === 'string' ? value.createdBy : 'cad-review',
		updatedAt: finite(value.updatedAt) ? value.updatedAt : Date.now(),
		locked: Boolean(value.locked)
	};
	if (value.type === 'stroke') {
		if (!Array.isArray(value.points)) return null;
		const points = value.points
			.filter((point): point is Record<string, unknown> => !!point && typeof point === 'object')
			.map((point) => ({ x: point.x, y: point.y, pressure: point.pressure }))
			.filter((point) => finite(point.x) && finite(point.y)) as Point[];
		if (points.length === 0) return null;
		return { ...common, type: 'stroke', points } as StrokeElement;
	}
	if (value.type === 'arrow') return { ...common, type: 'arrow', arrowHead: value.arrowHead === 'both' || value.arrowHead === 'none' ? value.arrowHead : 'end' } as ArrowElement;
	if (value.type === 'rect') return { ...common, type: 'rect', borderRadius: finite(value.borderRadius) ? value.borderRadius : 0 } as RectElement;
	if (value.type === 'ellipse') return { ...common, type: 'ellipse' } as EllipseElement;
	if (typeof value.text !== 'string' || !finite(value.fontSize)) return null;
	return {
		...common,
		type: 'text',
		text: value.text.slice(0, 2000),
		fontSize: Math.abs(value.fontSize),
		fontFamily: typeof value.fontFamily === 'string' ? value.fontFamily : 'sans-serif',
		textAlign: value.textAlign === 'center' || value.textAlign === 'right' ? value.textAlign : 'left'
	} as TextElement;
}

export function normalizeCadReviewElements(raw: unknown): CadReviewElement[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(asCadReviewElement).filter((element): element is CadReviewElement => element !== null);
}

function stableSourceIdentity(src: string, fileName: string): string {
	let source = src.trim();
	try {
		const url = new URL(source);
		source = `${url.origin}${url.pathname}`;
	} catch {
		source = source.split(/[?#]/, 1)[0];
	}
	return `${fileName.trim().toLowerCase()}\u0000${source}`;
}

/** Small deterministic token safe to embed in a server-side board id. */
export function cadReviewAssetKey(src: string, fileName: string): string {
	const input = stableSourceIdentity(src, fileName);
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, '0');
}

export function cadReviewBoardId(channelId: string, src: string, fileName: string): string | null {
	const channel = channelId.trim();
	if (!channel || channel.includes(':') || channel.length > 128) return null;
	return `cad-review:${channel}:${cadReviewAssetKey(src, fileName)}`;
}
