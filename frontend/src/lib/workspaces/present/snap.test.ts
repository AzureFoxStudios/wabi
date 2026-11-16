import { describe, expect, test } from 'bun:test';
import { boundsOf, clampShift, dragShift, snapBox } from './snap';

describe('snapping geometry', () => {
	test('bounds of a group', () => {
		expect(boundsOf([])).toBeNull();
		const b = boundsOf([{ x: 0.1, y: 0.2, w: 0.2, h: 0.1 }, { x: 0.5, y: 0.1, w: 0.3, h: 0.4 }])!;
		expect(b.x).toBeCloseTo(0.1); expect(b.y).toBeCloseTo(0.1); expect(b.w).toBeCloseTo(0.7); expect(b.h).toBeCloseTo(0.4);
	});
	test('left edge snaps to the slide edge and draws a guide', () => {
		const s = snapBox({ x: 0.006, y: 0.3, w: 0.2, h: 0.1 }, []);
		expect(s.dx).toBeCloseTo(-0.006);
		expect(s.guides.x).toEqual([0]);
	});
	test('centre snaps to the slide centre on both axes', () => {
		const s = snapBox({ x: 0.395, y: 0.455, w: 0.2, h: 0.1 }, []);
		expect(s.dx).toBeCloseTo(0.005); expect(s.dy).toBeCloseTo(-0.005);
		expect(s.guides).toEqual({ x: [0.5], y: [0.5] });
	});
	test('right and bottom edges snap to the far edge', () => {
		const s = snapBox({ x: 0.795, y: 0.895, w: 0.2, h: 0.1 }, []);
		expect(s.dx).toBeCloseTo(0.005); expect(s.dy).toBeCloseTo(0.005);
		expect(s.guides).toEqual({ x: [1], y: [1] });
	});
	test('snaps to another object edge and centre', () => {
		const other = { x: 0.3, y: 0.6, w: 0.2, h: 0.2 };
		const edge = snapBox({ x: 0.305, y: 0.1, w: 0.1, h: 0.1 }, [other]);
		expect(edge.dx).toBeCloseTo(-0.005); expect(edge.guides.x).toContain(0.3);
		// Centre (0.45) is 0.004 from the other object's centre (0.4 + 0.05 = 0.446... use 0.4 wide at 0.25).
		const centre = snapBox({ x: 0.404, y: 0.1, w: 0.1, h: 0.1 }, [{ x: 0.35, y: 0.5, w: 0.2, h: 0.2 }]);
		expect(centre.dx).toBeCloseTo(-0.004); expect(centre.guides.x).toContain(0.45);
	});
	test('nothing within the threshold does not move or draw', () => {
		const s = snapBox({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, [{ x: 0.7, y: 0.7, w: 0.1, h: 0.1 }]);
		expect(s).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } });
	});
	test('the nearest line wins and every coincident line is drawn', () => {
		// Left edge is 0.004 from 0.3; centre 0.4 sits exactly on the other object's centre line after the shift.
		const s = snapBox({ x: 0.304, y: 0.1, w: 0.2, h: 0.1 }, [{ x: 0.3, y: 0.5, w: 0.2, h: 0.1 }]);
		expect(s.dx).toBeCloseTo(-0.004);
		expect(s.guides.x).toContain(0.3);
		expect(s.guides.x).toContain(0.4);
	});
	test('clampShift limits a group by its bounds', () => {
		const c = clampShift({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, -0.3, 0.9);
		expect(c.dx).toBeCloseTo(-0.1); expect(c.dy).toBeCloseTo(0.4);
	});
	test('dragShift: a click never moves, Alt disables snapping, snapping stays on the slide', () => {
		const box = { x: 0.103, y: 0.3, w: 0.2, h: 0.1 };
		expect(dragShift(box, [], 0.004, 0, { snap: true, moved: false })).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } });
		const alt = dragShift(box, [], -0.095, 0, { snap: false, moved: true });
		expect(alt.dx).toBeCloseTo(-0.095); expect(alt.guides.x).toEqual([]);
		const snapped = dragShift(box, [], -0.095, 0, { snap: true, moved: true });
		expect(snapped.dx).toBeCloseTo(-0.103); expect(snapped.guides.x).toEqual([0]);
		const edge = dragShift({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, [], 0.2, 0.2, { snap: true, moved: true });
		expect(edge.dx).toBe(0); expect(edge.dy).toBe(0);
	});
});
