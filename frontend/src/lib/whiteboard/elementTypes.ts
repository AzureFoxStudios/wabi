import type { WhiteboardElement } from './boardTypes';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface Point {
	x: number;
	y: number;
	pressure?: number;
}

// ---------------------------------------------------------------------------
// Element base & concrete shapes
// ---------------------------------------------------------------------------

export interface ElementBase {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	zIndex: number;
	layerId: string;
	opacity: number;
	strokeColor: string;
	strokeWidth: number;
	fillColor: string;
	createdBy: string;
	updatedAt: number;
	locked: boolean;
	hardness?: number;
	brushPreset?: string;
}

export interface StrokeElement extends ElementBase {
	type: 'stroke';
	points: Point[];
}

export interface LineElement extends ElementBase {
	type: 'line';
}

export interface RectElement extends ElementBase {
	type: 'rect';
	borderRadius: number;
}

export interface EllipseElement extends ElementBase {
	type: 'ellipse';
}

export interface ArrowElement extends ElementBase {
	type: 'arrow';
	arrowHead: 'end' | 'both' | 'none';
}

export interface TextElement extends ElementBase {
	type: 'text';
	text: string;
	fontSize: number;
	fontFamily: string;
	textAlign: 'left' | 'center' | 'right';
}

export interface ImageElement extends ElementBase {
	type: 'image';
	src: string;
	assetId?: string;
	fileName?: string;
	mimeType?: string;
	naturalWidth: number;
	naturalHeight: number;
}

export interface MathElement extends ElementBase {
	type: 'math';
	latex: string;
	fontSize: number;
}

export type BoardElement =
	| StrokeElement
	| LineElement
	| RectElement
	| EllipseElement
	| ArrowElement
	| TextElement
	| ImageElement
	| MathElement;

export type BoardElementType = BoardElement['type'];

// ---------------------------------------------------------------------------
// Default style applied to new elements
// ---------------------------------------------------------------------------

export const DEFAULT_STYLE = {
	strokeColor: '#1f2937',
	strokeWidth: 4,
	fillColor: 'transparent',
	opacity: 1,
	hardness: 1
} as const;

// ---------------------------------------------------------------------------
// ID generation (no deps)
// ---------------------------------------------------------------------------

export function generateElementId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Transport serialization
// ---------------------------------------------------------------------------

export function toTransportElement(el: BoardElement): WhiteboardElement {
	return { ...el } as unknown as WhiteboardElement;
}

export function fromTransportElement(raw: WhiteboardElement): BoardElement {
	return { ...raw } as unknown as BoardElement;
}
