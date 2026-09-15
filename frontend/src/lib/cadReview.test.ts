import { describe, expect, test } from 'bun:test';
import {
	asCadReviewElement,
	cadReviewAssetKey,
	cadReviewBoardId,
	createCadReviewShape,
	createCadReviewStroke,
	normalizeCadReviewElements,
	simplifyCadReviewPoints
} from './cadReview';

const style = { strokeColor: '#facc15', strokeWidth: 3 };

describe('CAD review coordinates', () => {
	test('keeps drawing-space stroke coordinates intact', () => {
		const stroke = createCadReviewStroke([{ x: -4, y: 10 }, { x: 8, y: -2 }], style, 1);
		expect(stroke.points).toEqual([{ x: -4, y: 10, pressure: undefined }, { x: 8, y: -2, pressure: undefined }]);
		expect({ x: stroke.x, y: stroke.y, width: stroke.width, height: stroke.height }).toEqual({ x: -4, y: -2, width: 12, height: 12 });
	});

	test('normalizes boxes but keeps arrow direction', () => {
		const rect = createCadReviewShape('rect', { x: 10, y: 20 }, { x: 2, y: 5 }, style, 1);
		const arrow = createCadReviewShape('arrow', { x: 10, y: 20 }, { x: 2, y: 5 }, style, 2);
		expect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).toEqual({ x: 2, y: 5, width: 8, height: 15 });
		expect({ x: arrow.x, y: arrow.y, width: arrow.width, height: arrow.height }).toEqual({ x: 10, y: 20, width: -8, height: -15 });
	});

	test('simplifies pen traffic without losing endpoints', () => {
		const points = simplifyCadReviewPoints([{ x: 0, y: 0 }, { x: 0.1, y: 0.1 }, { x: 5, y: 5 }], 1);
		expect(points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
	});
});

describe('CAD review persistence identity', () => {
	test('ignores signed URL query churn', () => {
		const a = cadReviewAssetKey('https://wabi.test/uploads/a.dxf?token=one', 'Roof.dxf');
		const b = cadReviewAssetKey('https://wabi.test/uploads/a.dxf?token=two', 'Roof.dxf');
		expect(a).toBe(b);
	});

	test('uses a dedicated per-attachment board inside the channel', () => {
		const id = cadReviewBoardId('channel-123', '/uploads/a.dxf', 'Roof.dxf');
		expect(id).toMatch(/^cad-review:channel-123:[a-z0-9]+$/);
		expect(cadReviewBoardId('bad:channel', '/uploads/a.dxf', 'Roof.dxf')).toBeNull();
	});
});

describe('CAD review transport narrowing', () => {
	test('accepts review primitives and rejects unrelated whiteboard elements', () => {
		const arrow = createCadReviewShape('arrow', { x: 1, y: 2 }, { x: 3, y: 4 }, style, 1);
		expect(asCadReviewElement(arrow)?.type).toBe('arrow');
		expect(normalizeCadReviewElements([{ ...arrow, type: 'image' }])).toEqual([]);
	});
});
