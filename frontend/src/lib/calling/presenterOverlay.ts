import type {
	ArrowElement,
	BoardElement,
	EllipseElement,
	RectElement,
	StrokeElement
} from '$lib/whiteboard/elementTypes';

export type PresenterOverlayTool = 'pen' | 'arrow' | 'rect' | 'ellipse';

export type PresenterOverlayElement =
	| StrokeElement
	| ArrowElement
	| RectElement
	| EllipseElement;

export const PRESENTER_OVERLAY_COLORS = [
	'#f8fafc',
	'#facc15',
	'#fb7185',
	'#38bdf8',
	'#4ade80'
] as const;

export const PRESENTER_OVERLAY_WIDTHS = [2, 4, 6] as const;

export function clonePresenterOverlayElement(element: PresenterOverlayElement): PresenterOverlayElement {
	if (element.type === 'stroke') {
		return {
			...element,
			points: element.points.map((point) => ({ ...point }))
		};
	}
	return { ...element };
}

export function clonePresenterOverlayElements(
	elements: PresenterOverlayElement[]
): PresenterOverlayElement[] {
	return elements.map(clonePresenterOverlayElement);
}

export function isPresenterOverlayElement(element: BoardElement): element is PresenterOverlayElement {
	return (
		element.type === 'stroke' ||
		element.type === 'arrow' ||
		element.type === 'rect' ||
		element.type === 'ellipse'
	);
}
