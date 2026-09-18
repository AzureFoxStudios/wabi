import { afterEach, describe, expect, test } from 'bun:test';
import { PointerTrail, POINTER_TRAIL_CAPACITY, pointerTrailBounds, type PointerSample } from './pointerTrail';
import { generatePointerField, type PointerField, type PointerFieldKind } from './pointerFields';
import { PointerDemoSweep, pointerDemoPoint, visibleDemoBounds } from './pointerDemo';
import { pointerTrailLifetime, pointerHistoryLifetime, pointerHeadOpacity, resolvePointerWorldOptions, type PointerWorldOptions } from './pointerWorlds';

const options: PointerWorldOptions = {
    pattern: 'lattice', radius: 190, textureOpacity: .3, patternScale: 1,
    trailMs: 280, trailStrength: .5, seed: 601
};
const sample = (x: number, y: number, t = 0): PointerSample => ({ x, y, t, speed: 0, breakBefore: false });

function reachable(field: PointerField, start: number, directed = false): Set<number> {
    const adjacency = new Map(field.nodes.map(node => [node.id, [] as number[]]));
    for (const edge of field.edges) {
        adjacency.get(edge.a)!.push(edge.b);
        if (!directed) adjacency.get(edge.b)!.push(edge.a);
    }
    const visited = new Set([start]), queue = [start];
    while (queue.length) {
        for (const next of adjacency.get(queue.shift()!)!) {
            if (!visited.has(next)) { visited.add(next); queue.push(next); }
        }
    }
    return visited;
}

describe('shared pointer history', () => {
    test('keeps subpixel live input when the RAF clock precedes the pointer event', () => {
        const trail = new PointerTrail(), points: PointerSample[] = [];
        expect(trail.push(10, 20, 100)).toBe(true);
        expect(trail.push(10.125, 20.25, 102)).toBe(true);
        expect(trail.read(99, 280, points)).toBe(2);
        expect(points.at(-1)).toMatchObject({ x: 10.125, y: 20.25, t: 102 });
        expect(trail.push(10.125, 20.25, 103)).toBe(false);
        expect(trail.current.t).toBe(102);
        expect(trail.push(12, 24, 101)).toBe(false);
        expect(trail.push(NaN, 24, 104)).toBe(false);
    });
    test('bounds high-rate history while retaining its time coverage and precise head', () => {
        const trail = new PointerTrail(), points: PointerSample[] = [];
        for (let t = 0; t <= 1000; t++) trail.push(t / 10, 25, t, 280);
        trail.read(1000, 280, points);
        expect(points.length).toBeLessThanOrEqual(POINTER_TRAIL_CAPACITY);
        expect(points[0].t).toBeLessThan(780);
        expect(points.at(-1)!.x).toBe(100);
        expect(trail.read(1280, 280, points)).toBe(0);
    });
    test('cuts teleports, idle gaps, and cleared state without drawing a connecting streak', () => {
        const trail = new PointerTrail(), points: PointerSample[] = [];
        trail.push(1, 1, 0, 280);
        trail.push(5, 5, 50, 280);
        trail.push(800, 800, 60, 280);
        expect(trail.read(60, 280, points)).toBe(1);
        expect(points[0].breakBefore).toBe(true);
        expect(trail.vx).toBe(0);
        trail.push(801, 801, 500, 280);
        expect(trail.read(500, 280, points)).toBe(1);
        trail.clear();
        expect(trail.read(500, 280, points)).toBe(0);
        expect(trail.push(801, 801, 501, 280)).toBe(true);
    });
    test('uniform ages are nonnegative for fresh input and reset unused samples', () => {
        const trail = new PointerTrail(), points: PointerSample[] = [];
        const uniforms = new Float32Array(48).fill(123);
        trail.push(20, 30, 120);
        expect(trail.writeUniforms(119, 280, 500, uniforms, points)).toBe(1);
        expect([...uniforms.slice(0, 4)]).toEqual([20, 470, 0, -1]);
        expect([...uniforms.slice(4)].every(value => value === 0)).toBe(true);
    });
    test('culls distant history and caps the entire backing extent', () => {
        const points = [sample(0, 0), sample(500, 500), sample(800, 800), sample(1000, 900)];
        const b = pointerTrailBounds(points, 190);
        expect(b.width).toBeLessThanOrEqual(1024);
        expect(b.height).toBeLessThanOrEqual(1024);
        expect(b.first).toBeGreaterThan(0);
        expect(b.left).toBeLessThanOrEqual(1000 - 190);
        expect(b.left + b.width).toBeGreaterThanOrEqual(1000 + 190);
    });
});

describe('seeded connected worlds', () => {
    const kinds: PointerFieldKind[] = ['lattice', 'climb-route', 'arcane-circle', 'rune-wall', 'maze'];
    test('repeats exactly for one seed and changes geometry for another', () => {
        for (const kind of kinds) {
            const first = generatePointerField(kind, 601);
            expect(generatePointerField(kind, 601)).toEqual(first);
            expect(generatePointerField(kind, 602)).not.toEqual(first);
            expect(first.width).toBeLessThanOrEqual(896);
            expect(first.height).toBeLessThanOrEqual(896);
            expect(first.ink + first.fineInk).not.toMatch(/NaN|Infinity/);
        }
    });
    test('lattice is one connected graph across repeating boundaries', () => {
        for (const density of [.6, 1, 1.5]) {
            const field = generatePointerField('lattice', 99, density);
            expect(reachable(field, 0).size).toBe(field.nodes.length);
            expect(field.edges.length).toBe(field.nodes.length * 3);
        }
    });
    test('every climb room has a route through all ranks with actual branching', () => {
        for (const seed of [1, 5, 601, 99999]) {
            const field = generatePointerField('climb-route', seed);
            const incoming = new Set(field.edges.map(edge => edge.b));
            const outgoing = new Set(field.edges.map(edge => edge.a));
            for (const node of field.nodes) {
                if (node.row! > 0) expect(incoming.has(node.id)).toBe(true);
                if (node.row! < 8) expect(outgoing.has(node.id)).toBe(true);
                const reached = reachable(field, node.id, true);
                expect(field.nodes.some(n => n.row === 8 && reached.has(n.id))).toBe(true);
            }
            expect(field.nodes.some(n => field.edges.filter(e => e.a === n.id).length > 1)).toBe(true);
            expect(field.nodes.some(n => field.edges.filter(e => e.b === n.id).length > 1)).toBe(true);
            expect(field.nodes.filter(n => n.row === 0).map(n => n.x)).toEqual(field.nodes.filter(n => n.row === 8).map(n => n.x));
        }
    });
    test('maze has one solution between any cells and preserves topology under curvature', () => {
        for (const density of [.6, 1, 1.5]) {
            const straight = generatePointerField('maze', 11, density, 0);
            const curved = generatePointerField('maze', 11, density, 1);
            expect(straight.edges.length).toBe(straight.nodes.length - 1);
            expect(reachable(straight, straight.entrance!).size).toBe(straight.nodes.length);
            expect(curved.edges).toEqual(straight.edges);
            expect(curved.ink).not.toBe(straight.ink);
        }
    });
    test('idle and fade control the head independently from wake duration and settle speed', () => {
        const timing = { ...options, idleDelayMs: 100, fadeMs: 800, trailMs: 200 };
        expect(pointerHeadOpacity(-1, timing)).toBe(1);
        expect(pointerHeadOpacity(100, timing)).toBe(1);
        expect(pointerHeadOpacity(500, timing)).toBe(.5);
        expect(pointerHeadOpacity(900, timing)).toBe(0);
        expect(pointerHistoryLifetime(timing)).toBe(200);
        expect(pointerHistoryLifetime({ ...timing, settleSpeed: 2 })).toBe(100);
        expect(pointerTrailLifetime(timing)).toBe(900);
        expect(pointerTrailLifetime({ ...timing, trailMs: 0 })).toBe(900);
        expect(pointerHeadOpacity(100, { idleDelayMs: 100, fadeMs: 0 })).toBe(0);
        expect(pointerHeadOpacity(300, { ...timing, fadeMs: 400 })).toBe(.5);
    });
    test('material and history option bounds prevent unbounded work or invalid lifetime', () => {
        const resolved = resolvePointerWorldOptions({ ...options, radius: Infinity, fieldDensity: 20, trailStrength: -1, settleSpeed: 0 });
        expect(resolved.radius).toBe(190);
        expect(resolved.fieldDensity).toBe(1.5);
        expect(resolved.trailStrength).toBe(0);
        expect(pointerTrailLifetime({ ...options, pattern: 'sand', trailMs: 1200, settleSpeed: .25 })).toBe(1200);
        expect(pointerTrailLifetime({ ...options, trailMs: 0 })).toBeGreaterThan(0);
    });
});

describe('sample sweep', () => {
    const restore: (() => void)[] = [];
    function replaceGlobal(key: string, value: unknown) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        restore.push(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key));
    }
    afterEach(() => { while (restore.length) restore.pop()!(); });
    test('clips partly hidden preview areas and rejects absent or unusable ones', () => {
        expect(visibleDemoBounds({ left: -50, top: -50, width: 300, height: 200 }, 1000, 800)).toEqual({ left: 8, top: 8, width: 242, height: 142 });
        expect(visibleDemoBounds({ left: 2000, top: 0, width: 300, height: 200 }, 1000, 800)).toBeNull();
        expect(visibleDemoBounds(null, 1000, 800)).toBeNull();
        expect(visibleDemoBounds({ left: 0, top: 0, width: NaN, height: 200 }, 1000, 800)).toBeNull();
    });
    test('uses the input clock rather than older RAF timestamps and cancels all scheduled work', () => {
        let clock = 100, nextId = 1;
        const frames = new Map<number, FrameRequestCallback>();
        replaceGlobal('performance', { now: () => clock });
        replaceGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextId++; frames.set(id, callback); return id; });
        replaceGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
        const feed: number[][] = [], states: boolean[] = [];
        const bounds = { left: 10, top: 10, width: 300, height: 200 };
        const sweep = new PointerDemoSweep((x, y, now) => feed.push([x, y, now]), running => states.push(running), 1000);
        sweep.start(bounds);
        clock = 600;
        const [id, callback] = frames.entries().next().value!;
        frames.delete(id); callback(580);
        const midpoint = pointerDemoPoint(.5, bounds);
        expect(feed[0]).toEqual([midpoint.x, midpoint.y, 600]);
        expect(frames.size).toBe(1);
        sweep.cancel();
        expect(frames.size).toBe(0);
        expect(states).toEqual([true, false]);
        expect(sweep.running).toBe(false);
    });
});
