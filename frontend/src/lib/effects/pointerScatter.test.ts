import { describe, expect, test } from 'bun:test';
import { LITTLE_WORLD_PATTERNS } from './mouseFeelerConfig';
import { generateScatter, SCATTER_MOTIFS, SCATTER_WORLDS } from './pointerScatter';

describe('Little Worlds composition', () => {
	const bounds = { left: -400, top: -400, width: 1600, height: 1200 };
	test('every historical world has real motif drawings and a deterministic scene', () => {
		expect(Object.keys(SCATTER_WORLDS).sort()).toEqual(LITTLE_WORLD_PATTERNS.map(p => p.id).sort());
		for (const { id } of LITTLE_WORLD_PATTERNS) {
			const scene = generateScatter(id, 104729, 1, bounds);
			expect(scene.length).toBeGreaterThan(80);
			expect(scene).toEqual(generateScatter(id, 104729, 1, bounds));
			expect(new Set(scene.map(p => p.id)).size).toBe(scene.length);
			for (const item of scene) expect(SCATTER_MOTIFS[item.motif].length).toBeGreaterThan(12);
		}
	});
	test('overlapping viewports keep world coordinates and changing seed reshuffles them', () => {
		const a = generateScatter('creatures', 12, 1, bounds);
		const b = generateScatter('creatures', 12, 1, { ...bounds, left: 0, top: 0 });
		const byId = new Map(a.map(p => [p.id, p]));
		const common = b.filter(p => byId.has(p.id));
		expect(common.length).toBeGreaterThan(50);
		for (const point of common) expect(point).toEqual(byId.get(point.id));
		expect(generateScatter('creatures', 13, 1, bounds)).not.toEqual(a);
	});
	test('seeded variance creates mixed scales/angles, sparse areas, companions and rare heroes', () => {
		const points = generateScatter('creatures', 104729, 1, bounds);
		expect(new Set(points.map(p => p.scale)).size).toBeGreaterThan(50);
		expect(points.some(p => p.rotation < -.2)).toBe(true);
		expect(points.some(p => p.rotation > .2)).toBe(true);
		const heroes = points.filter(p => p.hero);
		expect(heroes.length).toBeGreaterThan(0);
		expect(heroes.length / points.length).toBeLessThan(.12);
		expect(points.some(p => p.id.endsWith(':companion'))).toBe(true);
		const pockets = new Map<string, number>();
		for (const p of points) {
			const key = `${Math.floor(p.x / 264)}:${Math.floor(p.y / 264)}`;
			pockets.set(key, (pockets.get(key) ?? 0) + 1);
		}
		expect(Math.max(...pockets.values()) - Math.min(...pockets.values())).toBeGreaterThan(8);
	});
	test('scale changes motif size and spacing, and hostile bounds stay bounded', () => {
		const small = generateScatter('tabletop', 12, .5, { left: 0, top: 0, width: 600, height: 600 });
		const large = generateScatter('tabletop', 12, 2, { left: 0, top: 0, width: 600, height: 600 });
		expect(small.length).toBeGreaterThan(large.length * 3);
		expect(Math.max(...large.map(p => p.scale))).toBeGreaterThan(Math.max(...small.map(p => p.scale)));
		expect(generateScatter('tabletop', 1, 1, { ...bounds, width: Infinity })).toEqual([]);
		expect(generateScatter('tabletop', 1, .5, { ...bounds, width: 1e10, height: 1e10 }).length).toBeLessThan(3362);
	});
});
