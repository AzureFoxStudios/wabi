import { mount, unmount, tick } from 'svelte';
import PointerShaderSurface from '../src/lib/effects/PointerShaderSurface.svelte';
import { importLocalImageEffect, getLocalVisualEffect, removeLocalVisualEffect } from '../src/lib/effects/localVisualEffects';

const results: string[] = [];
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); results.push(label); };
const svg = (body: string, attributes = '') => new File([
	`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" ${attributes}>${body}</svg>`
], 'drawing.svg', { type: 'image/svg+xml' });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function reject(file: File, label: string) {
	let rejected = false;
	try { await importLocalImageEffect(file); } catch { rejected = true; }
	assert(rejected, label);
}

async function run() {
	try {
		const drawing = await importLocalImageEffect(svg('<defs><linearGradient id="g"><stop stop-color="white"/></linearGradient></defs><rect width="200" height="100" fill="url(#g)"/>'));
		assert(drawing.tileWidth === 96 && drawing.tileHeight === 48 && drawing.imageWidth === 200 && drawing.imageHeight === 100, 'rectangular SVG preserves aspect ratio and decode dimensions');
		assert((await getLocalVisualEffect(drawing.id))?.tileHeight === 48, 'dimensions survive an IndexedDB read');
		(window as any).__savedImageId = drawing.id;
		await reject(new File(['broken'], 'bad.png', { type: 'image/png' }), 'corrupt PNG is rejected before saving');
		await reject(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="4097" height="1"/>'], 'wide.svg', { type: 'image/svg+xml' }), 'excessive decoded dimensions are rejected');
		await reject(svg('<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>'), 'namespace-prefixed SVG scripts are rejected');
		await reject(svg('<rect xmlns:x="urn:custom" x:onload="alert(1)"/>'), 'namespace-prefixed handlers are rejected');
		await reject(svg('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.invalid/image.svg#x"/>'), 'external namespace-qualified references are rejected');
		await reject(svg('<rect style="fill:u\\72l(https://example.invalid/image)"/>'), 'CSS-escaped resource tokens are rejected');
		await reject(svg('<style>@im/**/port "https://example.invalid/style";</style>'), 'comment-obfuscated CSS imports are rejected');
		await reject(svg('<rect style="background-image:image-set(\'https://example.invalid/image\' 1x)"/>'), 'CSS image functions cannot bypass local-resource validation');
		await reject(svg('<animate attributeName="href" values="#safe;https://example.invalid/image"/>'), 'animation cannot rewrite resource references');
		await reject(svg('<rect/>', 'xml:base="https://example.invalid/"'), 'base URLs cannot redirect local fragments');
		await reject(new File(['<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'], 'doctype.svg', { type: 'image/svg+xml' }), 'DOCTYPE declarations are rejected');
		await reject(new File(['<?xml-stylesheet href="https://example.invalid/style"?><svg xmlns="http://www.w3.org/2000/svg"/>'], 'style.svg', { type: 'image/svg+xml' }), 'external stylesheet declarations are rejected');
		await reject(new File(['<html xmlns="http://www.w3.org/1999/xhtml"/>'], 'html.svg', { type: 'image/svg+xml' }), 'non-SVG XML documents are rejected');
		const imageCanvas = document.createElement('canvas'); imageCanvas.width = 40; imageCanvas.height = 80;
		imageCanvas.getContext('2d')!.fillRect(0, 0, 40, 80);
		const png = await new Promise<Blob>(resolve => imageCanvas.toBlob(blob => resolve(blob!)));
		const bitmap = await importLocalImageEffect(new File([png], 'portrait.png', { type: 'image/png' }));
		assert(bitmap.tileWidth === 48 && bitmap.tileHeight === 96, 'raster imports preserve portrait proportions');
		await removeLocalVisualEffect(bitmap.id);

		const prototype = WebGLRenderingContext.prototype;
		const originals = { createShader: prototype.createShader, deleteShader: prototype.deleteShader,
			createProgram: prototype.createProgram, deleteProgram: prototype.deleteProgram,
			getProgramParameter: prototype.getProgramParameter, createBuffer: prototype.createBuffer,
			getUniformLocation: prototype.getUniformLocation, drawArrays: prototype.drawArrays };
		const shaders = new Set<WebGLShader>(), programs = new Set<WebGLProgram>();
		let queries = 0, draws = 0;
		prototype.createShader = function (type) { const shader = originals.createShader.call(this, type); if (shader) shaders.add(shader); return shader; };
		prototype.deleteShader = function (shader) { if (shader) shaders.delete(shader); return originals.deleteShader.call(this, shader); };
		prototype.createProgram = function () { const program = originals.createProgram.call(this); if (program) programs.add(program); return program; };
		prototype.deleteProgram = function (program) { if (program) programs.delete(program); return originals.deleteProgram.call(this, program); };
		prototype.getUniformLocation = function (program, name) { queries++; return originals.getUniformLocation.call(this, program, name); };
		prototype.drawArrays = function (mode, first, count) { draws++; return originals.drawArrays.call(this, mode, first, count); };
		const target = document.createElement('div'); target.style.cssText = 'position:relative;width:80px;height:80px;'; document.body.append(target);
		const errors: string[] = [];
		let component: ReturnType<typeof mount> | undefined;
		const make = async (source: string) => {
			component = mount(PointerShaderSurface, { target, props: { source, radius: 40, onshadererror: value => { if (value) errors.push(value); } } });
			await tick(); await sleep(20);
			const canvas = target.querySelector('canvas')!;
			const gl = canvas.getContext('webgl')!;
			if (!gl) throw new Error('Real WebGL is required for shader regressions');
			return { component: component as unknown as { setPointerState: (x: number, y: number, vx: number, vy: number, trail?: any[]) => void; pause: () => void }, gl };
		};
		const pixel = (gl: WebGLRenderingContext) => { const data = new Uint8Array(4); gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data); return [...data]; };
		const cleanup = async () => { if (component) await unmount(component); component = undefined; };
		try {
			let item = await make('void mainImage(out vec4 c,in vec2 p){c=vec4(1.,0.,0.,0.);}');
			const atSetup = queries;
			item.component.setPointerState(10, 20, 1, 2);
			assert(pixel(item.gl).every(value => value === 0), 'transparent red produces transparent black premultiplied pixels');
			item.component.setPointerState(30, 40, 2, 3);
			assert(queries === atSetup, 'pointer updates reuse cached uniform locations');
			await cleanup();
			item = await make('void mainImage(out vec4 c,in vec2 p){c=vec4(1.,0.,0.,.5);}');
			item.component.setPointerState(10, 20, 1, 2);
			const half = pixel(item.gl);
			assert(Math.abs(half[0] - 128) <= 1 && half[1] === 0 && Math.abs(half[3] - 128) <= 1, 'half-transparent shader output is premultiplied once');
			await cleanup();
			item = await make('void mainImage(out vec4 c,in vec2 p){c=vec4(u_pointer.x/u_viewport.x,u_active,0.,1.);}');
			assert(pixel(item.gl).every(value => value === 0), 'compilation does not activate an idle shader');
			item.component.setPointerState(window.innerWidth / 2, 20, 0, 0);
			assert(Math.abs(pixel(item.gl)[0] - 128) <= 1 && pixel(item.gl)[1] === 255, 'pointer updates draw immediately before the next animation frame');
			item.component.pause(); const pausedDraws = draws;
			await sleep(70);
			assert(pixel(item.gl)[1] === 255 && draws === pausedDraws, 'pause retains the last frame for fade and stops rendering');
			item.gl.getExtension('WEBGL_lose_context')!.loseContext(); await sleep(40);
			const lostDraws = draws; item.component.setPointerState(4, 5, 0, 0); await sleep(40);
			assert(draws === lostDraws && errors.some(error => error.includes('context lost')), 'context loss stops draws and reports a visible error');
			await cleanup();
			const beforeErrors = errors.length;
			item = await make('void mainImage(out vec4 c,in vec2 p){ THIS_IS_INVALID; }');
			const failedDraws = draws; item.component.setPointerState(10, 20, 0, 0); await sleep(40);
			assert(errors.length > beforeErrors && shaders.size === 0 && programs.size === 0 && draws === failedDraws, 'fragment failure cleans the vertex shader and never starts a draw loop');
			await cleanup();
			prototype.getProgramParameter = function (program, parameter) { return parameter === this.LINK_STATUS ? false : originals.getProgramParameter.call(this, program, parameter); };
			await make('void mainImage(out vec4 c,in vec2 p){c=vec4(1.);}');
			assert(shaders.size === 0 && programs.size === 0, 'link failure cleans all shaders and its program');
			await cleanup(); prototype.getProgramParameter = originals.getProgramParameter;
			prototype.createBuffer = () => null;
			await make('void mainImage(out vec4 c,in vec2 p){c=vec4(1.);}');
			assert(shaders.size === 0 && programs.size === 0, 'geometry allocation failure cleans all graphics resources');
			await cleanup(); prototype.createBuffer = originals.createBuffer;
			item = await make('void mainImage(out vec4 c,in vec2 p){c=vec4(float(u_trail_count)/12.,u_trail[0].z,0.,1.);}');
			item.component.setPointerState(1, 2, 0, 0, [{ x: 1, y: 2, t: performance.now() + 20, speed: 0 }]);
			const trail = pixel(item.gl);
			assert(Math.abs(trail[0] - 21) <= 1 && trail[1] === 0, 'local shaders receive bounded history and clamp fresh sample age to zero');
			await cleanup();
		} finally {
			await cleanup(); Object.assign(prototype, originals); target.remove();
		}
		(window as any).__localEffectsSmoke = { status: 'passed', results };
	} catch (error) {
		(window as any).__localEffectsSmoke = { status: 'failed', results, error: error instanceof Error ? error.stack : String(error) };
	}
}
(window as any).__localEffectsSmoke = { status: 'running', results };
void run();
