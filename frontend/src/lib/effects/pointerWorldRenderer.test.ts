import { afterEach, describe, expect, test } from 'bun:test';
import { PointerWorldRenderer } from './pointerWorldRenderer';
import { PointerTrail } from './pointerTrail';
import type { PointerWorldOptions } from './pointerWorlds';

const options: PointerWorldOptions = {
    pattern: 'lattice', radius: 190, textureOpacity: .3, patternScale: 1,
    trailMs: 280, trailStrength: .5, seed: 601
};
const restores: (() => void)[] = [];
function replaceGlobal(key: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restores.push(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key));
}
afterEach(() => { while (restores.length) restores.pop()!(); });

function graphicsHarness(mode: 'ok' | 'missing' | 'compile-error' | 'link-error' = 'ok') {
    const stats = { shaders: 0, deletedShaders: 0, programs: 0, deletedPrograms: 0, buffers: 0, deletedBuffers: 0, lost: 0, draws: 0, queries: 0, canvasFills: 0, patterns: 0, visibleFills: 0 };
    const scalarUniforms = new Map<string, number>();
    const gradientAlphas: string[] = [];
    const invalidAlphas: number[] = [];
    let globalAlpha = 1;
    const gl = {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, MAX_FRAGMENT_UNIFORM_VECTORS: 5,
        ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8, COLOR_BUFFER_BIT: 9, TRIANGLE_STRIP: 10,
        getParameter: () => 64,
        createShader: () => ({ id: ++stats.shaders }),
        deleteShader: () => stats.deletedShaders++,
        shaderSource: () => {}, compileShader: () => {},
        getShaderParameter: () => mode !== 'compile-error' || stats.shaders === 1,
        getShaderInfoLog: () => 'Fixture compile error',
        createProgram: () => ({ id: ++stats.programs }),
        deleteProgram: () => stats.deletedPrograms++,
        attachShader: () => {}, linkProgram: () => {},
        getProgramParameter: () => mode !== 'link-error', getProgramInfoLog: () => 'Fixture link error',
        createBuffer: () => ({ id: ++stats.buffers }), deleteBuffer: () => stats.deletedBuffers++,
        bindBuffer: () => {}, bufferData: () => {}, useProgram: () => {},
        getAttribLocation: () => 0, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
        getUniformLocation: (_program: unknown, name: string) => { stats.queries++; return { name }; },
        viewport: () => {}, clearColor: () => {}, clear: () => {}, uniform2f: () => {}, uniform1f: (location: { name: string }, value: number) => scalarUniforms.set(location.name, value),
        uniform3fv: () => {}, uniform1i: () => {}, uniform4fv: () => {},
        drawArrays: () => stats.draws++,
        getExtension: () => ({ loseContext: () => stats.lost++ })
    };
    const ctx = {
        fillStyle: '', strokeStyle: '',
        get globalAlpha() { return globalAlpha; },
        set globalAlpha(value: number) { if (value < 0 || value > 1 || !Number.isFinite(value)) invalidAlphas.push(value); else globalAlpha = value; },
        globalCompositeOperation: 'source-over',
        lineCap: '', lineJoin: '', lineWidth: 1,
        fillRect: () => { stats.canvasFills++; if (globalAlpha > 0) stats.visibleFills++; }, getImageData: () => ({ data: [120, 180, 220, 255] }),
        createPattern: () => { stats.patterns++; return { setTransform: () => {} }; },
        setLineDash: () => {}, stroke: () => {}, setTransform: () => {}, clearRect: () => {},
        createRadialGradient: () => ({ addColorStop: (_offset: number, color: string) => gradientAlphas.push(color) }), drawImage: () => {},
        beginPath: () => {}, arc: () => {}, moveTo: () => {}, lineTo: () => {}, fill: () => stats.canvasFills++
    };
    const children = new Set<FakeCanvas>();
    class FakeCanvas {
        width = 300; height = 150;
        style = { cssText: '', width: '', height: '', transform: '', display: '' };
        listeners = new Map<string, EventListener>();
        setAttribute() {}
        remove() { children.delete(this); }
        getContext(kind: string) { return kind === '2d' ? ctx : mode === 'missing' ? null : gl; }
        addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener); }
        removeEventListener(name: string) { this.listeners.delete(name); }
        fire(name: string) { this.listeners.get(name)?.({ preventDefault() {} } as Event); }
    }
    replaceGlobal('document', { documentElement: {}, createElement: () => new FakeCanvas() });
    replaceGlobal('window', { devicePixelRatio: 4 });
    replaceGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#78b4dc' }));
    replaceGlobal('Path2D', class { constructor(_path: string) {} });
    replaceGlobal('DOMMatrix', class { scale() { return this; } });
    replaceGlobal('requestAnimationFrame', () => { throw new Error('Renderer must never schedule its own frames'); });
    return { stats, children, scalarUniforms, gradientAlphas, invalidAlphas, target: { append: (canvas: FakeCanvas) => children.add(canvas) } as unknown as HTMLElement };
}

describe('bounded pointer renderer lifecycle', () => {
    test('caches field geometry, caps high-DPR pixels, and stops drawing expired trails', () => {
        const h = graphicsHarness();
        const renderer = new PointerWorldRenderer(h.target, options);
        const trail = new PointerTrail();
        for (let i = 0; i < 10; i++) trail.push(i * 80, i * 45, 100 + i * 20, 280);
        expect(renderer.draw(trail, 279)).toBe(true);
        expect(renderer.diagnostics.pixels).toBeLessThanOrEqual(1024 * 1024);
        expect(renderer.diagnostics.layouts).toBe(1);
        renderer.configure({ ...options, textureOpacity: .6 });
        expect(renderer.diagnostics.layouts).toBe(1);
        renderer.configure({ ...options, seed: 602 });
        expect(renderer.diagnostics.layouts).toBe(2);
        const frames = renderer.diagnostics.frames;
        expect(renderer.draw(trail, 1000)).toBe(false);
        expect(renderer.diagnostics.frames).toBe(frames);
        expect(renderer.canvas.style.display).toBe('none');
        renderer.destroy(); renderer.destroy();
        expect(h.children.size).toBe(0);
    });
    test('releases every allocated shader on fragment compile errors, then draws a 2D sand head', () => {
        const h = graphicsHarness('compile-error'), errors: string[] = [];
        const renderer = new PointerWorldRenderer(h.target, { ...options, pattern: 'sand', trailStrength: 0 }, message => errors.push(message));
        expect(h.stats.shaders).toBe(2);
        expect(h.stats.deletedShaders).toBe(2);
        expect(renderer.diagnostics.fallback).toBe(true);
        expect(errors[0]).toContain('Fixture compile error');
        expect(h.children.size).toBe(1);
        const trail = new PointerTrail(); trail.push(300, 300, 100);
        const fills = h.stats.canvasFills;
        expect(renderer.draw(trail, 100)).toBe(true);
        expect(h.stats.canvasFills).toBeGreaterThan(fills);
        renderer.destroy();
    });
    test('releases the failed linked program and both shaders', () => {
        const h = graphicsHarness('link-error');
        const renderer = new PointerWorldRenderer(h.target, { ...options, pattern: 'water' });
        expect(h.stats.programs).toBe(1);
        expect(h.stats.deletedPrograms).toBe(1);
        expect(h.stats.deletedShaders).toBe(2);
        expect(renderer.diagnostics.fallback).toBe(true);
        renderer.destroy();
    });
    test('restores a lost graphics context, caches uniform locations, and releases resources on switching', () => {
        const h = graphicsHarness(), errors: string[] = [];
        const renderer = new PointerWorldRenderer(h.target, { ...options, pattern: 'water' }, message => errors.push(message));
        const trail = new PointerTrail(); trail.push(300, 300, 100);
        const canvas = [...h.children][0], queries = h.stats.queries;
        expect(renderer.draw(trail, 99)).toBe(true);
        expect(renderer.draw(trail, 120)).toBe(true);
        expect(h.stats.queries).toBe(queries);
        canvas.fire('webglcontextlost');
        expect(renderer.draw(trail, 140)).toBe(false);
        canvas.fire('webglcontextrestored');
        expect(h.stats.lost).toBe(0);
        expect(renderer.draw(trail, 160)).toBe(true);
        expect(errors.at(-1)).toBe('');
        renderer.configure(options);
        expect(h.stats.deletedPrograms).toBe(h.stats.programs);
        expect(h.stats.deletedBuffers).toBe(h.stats.buffers);
        expect(canvas.listeners.size).toBe(0);
        expect(h.children.size).toBe(1);
        renderer.destroy();
        expect(h.children.size).toBe(0);
    });
    test('field head follows idle/fade controls after the shorter wake has expired', () => {
        const h = graphicsHarness();
        const renderer = new PointerWorldRenderer(h.target, { ...options, idleDelayMs: 100, fadeMs: 800, trailMs: 200, response: 1, textureOpacity: 1 });
        const trail = new PointerTrail(); trail.push(300, 300, 100);
        expect(renderer.draw(trail, 600)).toBe(true);
        // At half fade, base-mask opacity is half of its .55 full-strength stamp.
        expect(h.gradientAlphas).toContain('rgba(255,255,255,0.275)');
        expect(h.invalidAlphas).toEqual([]);
        expect(renderer.draw(trail, 1000)).toBe(false);
        renderer.destroy();
    });
    test('materials receive separate head opacity and wake lifetime, with no wake when trail is disabled', () => {
        const h = graphicsHarness();
        const renderer = new PointerWorldRenderer(h.target, { ...options, pattern: 'water', idleDelayMs: 100, fadeMs: 800, trailMs: 200 });
        const trail = new PointerTrail(); trail.push(300, 300, 100); trail.push(330, 330, 150);
        expect(renderer.draw(trail, 650)).toBe(true);
        expect(h.scalarUniforms.get('u_head_alpha')).toBe(.5);
        expect(h.scalarUniforms.get('u_lifetime')).toBeCloseTo(.32);
        expect(renderer.diagnostics.samples).toBe(1);
        renderer.configure({ ...options, pattern: 'water', trailMs: 0 });
        trail.push(340, 340, 660);
        expect(renderer.draw(trail, 660)).toBe(true);
        expect(renderer.diagnostics.samples).toBe(1);
        expect(h.scalarUniforms.get('u_lifetime')).toBe(.001);
        renderer.destroy();
    });
    test('zero response keeps a base reveal in the fallback and zero texture strength skips drawing', () => {
        const h = graphicsHarness('missing');
        const renderer = new PointerWorldRenderer(h.target, { ...options, pattern: 'sand', response: 0 });
        const trail = new PointerTrail(); trail.push(300, 300, 100);
        const fills = h.stats.visibleFills;
        expect(renderer.draw(trail, 100)).toBe(true);
        expect(h.stats.visibleFills).toBeGreaterThan(fills);
        renderer.configure({ ...options, pattern: 'sand', textureOpacity: 0 });
        const frames = renderer.diagnostics.frames;
        expect(renderer.draw(trail, 120)).toBe(false);
        expect(renderer.diagnostics.frames).toBe(frames);
        expect(renderer.canvas.style.display).toBe('none');
        renderer.destroy();
    });
    test('missing WebGL remains usable through a reported bounded fallback', () => {
        const h = graphicsHarness('missing'), errors: string[] = [];
        const renderer = new PointerWorldRenderer(h.target, { ...options, pattern: 'water' }, message => errors.push(message));
        const trail = new PointerTrail(); trail.push(300, 300, 100);
        expect(renderer.draw(trail, 100)).toBe(true);
        expect(renderer.diagnostics.backend).toBe('canvas2d');
        expect(errors[0]).toContain('WebGL is unavailable');
        renderer.destroy();
    });
});
