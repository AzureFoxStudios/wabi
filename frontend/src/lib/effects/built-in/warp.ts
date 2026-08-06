import type { AmbientEffect, EffectConfig } from '../types';
import { createWebGLRenderer, type WebGLRenderer } from './webgl';
import { createCpuCanvas, type CpuCanvas, smoothstep, hash2, fract } from './cpu';

/**
 * Warp Speed — the classic hyperspace star-streak tunnel. Stars stream
 * outward from a center point along radial lines.
 *
 * Deliberately tuned dim: streaks are low-brightness and the center (where
 * chat text sits) is darkened, so the motion reads as a living backdrop
 * behind the frosted surfaces instead of visual noise.
 */

const FRAG_SRC = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform float u_speed;
uniform float u_density;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
	vec2 res = u_resolution;
	vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
	p.y += 0.10;
	float r = max(length(p), 0.001);
	float a = atan(p.y, p.x);

	// each star lives on a ring+segment and travels outward, wrapping around
	const float RINGS = 40.0;
	float ring = floor(r * RINGS);
	float seg = floor(a * 84.0 / 6.2831853);
	vec2 id = vec2(ring, seg);
	float h = hash(id);
	float h2 = hash(id + 91.7);

	float t = fract(u_time * (0.5 + h2 * 1.1) * u_speed + h);
	float pos = (ring + t) / RINGS;
	float d = abs(r - pos);

	float width = max(0.003, 0.015 / max(u_density, 0.15));
	float line = (1.0 - smoothstep(0.0, width, d)) * smoothstep(0.0, 0.02, r);
	float trail = (1.0 - smoothstep(0.0, width * 7.0, d)) * (0.4 + 0.6 * h);

	vec3 col = u_c3;
	col += u_c1 * line * u_density;
	col += u_c2 * trail * 0.12 * u_density;

	// vignette + darkened center keep the readable core of the screen calm
	float vig = 1.0 - smoothstep(0.55, 1.5, r);
	col *= 0.4 + 0.6 * vig;
	col *= 0.35 + 0.65 * smoothstep(0.03, 0.15, r);

	gl_FragColor = vec4(col, 1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
	const clean = hex.replace('#', '');
	const r = parseInt(clean.substring(0, 2), 16);
	const g = parseInt(clean.substring(2, 4), 16);
	const b = parseInt(clean.substring(4, 6), 16);
	if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
		return [r / 255, g / 255, b / 255];
	}
	return [0.42, 0.83, 1];
}

/** CPU port of the fragment shader, writing one grid pixel. */
function shadePixel(
	gx: number,
	gy: number,
	gw: number,
	gh: number,
	t: number,
	speed: number,
	density: number,
	c1: [number, number, number],
	c2: [number, number, number],
	c3: [number, number, number],
	out: Uint8ClampedArray,
	idx: number
): void {
	const px = (gx - gw / 2) / gh;
	const py = (gy - gh / 2) / gh + 0.1;
	const r = Math.max(Math.hypot(px, py), 0.001);
	const a = Math.atan2(py, px);

	const RINGS = 40;
	const ring = Math.floor(r * RINGS);
	const seg = Math.floor((a * 84) / 6.2831853);
	const h = hash2(ring, seg);
	const h2 = hash2(ring + 91.7, seg + 91.7);

	const tt = fract(t * (0.5 + h2 * 1.1) * speed + h);
	const pos = (ring + tt) / RINGS;
	const d = Math.abs(r - pos);

	const width = Math.max(0.003, 0.015 / Math.max(density, 0.15));
	const line = (1 - smoothstep(0, width, d)) * smoothstep(0, 0.02, r);
	const trail = (1 - smoothstep(0, width * 7, d)) * (0.4 + 0.6 * h);

	let r2 = c3[0] + c1[0] * line * density + c2[0] * trail * 0.12 * density;
	let g2 = c3[1] + c1[1] * line * density + c2[1] * trail * 0.12 * density;
	let b2 = c3[2] + c1[2] * line * density + c2[2] * trail * 0.12 * density;

	const vig = 1 - smoothstep(0.55, 1.5, r);
	const mult1 = 0.4 + 0.6 * vig;
	const mult2 = 0.35 + 0.65 * smoothstep(0.03, 0.15, r);
	r2 *= mult1 * mult2;
	g2 *= mult1 * mult2;
	b2 *= mult1 * mult2;

	out[idx] = Math.min(255, Math.max(0, Math.round(r2 * 255)));
	out[idx + 1] = Math.min(255, Math.max(0, Math.round(g2 * 255)));
	out[idx + 2] = Math.min(255, Math.max(0, Math.round(b2 * 255)));
	out[idx + 3] = 255;
}

export class WarpEffect implements AmbientEffect {
	id = 'warp';
	name = 'Warp Speed';
	description = 'Hyperspace star streaks streaming outward from a dark, calm center.';
	usesWebGL = true;

	private renderer: WebGLRenderer | null = null;
	private cpu: CpuCanvas | null = null;
	private host2d: CanvasRenderingContext2D | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private time = 0;
	private dpr = 1;
	private W = 0;
	private H = 0;

	defaultConfig: EffectConfig = {
		color: '#6bd4ff',
		color2: '#3d6ef2',
		color3: '#04070d',
		intensity: 1,
		size: 1,
		speed: 1,
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		this.canvas = canvas;
		this.host2d = canvas.getContext('2d');

		const renderer = createWebGLRenderer(FRAG_SRC, 'warp');
		if (renderer.ready) {
			renderer.setSize(this.W * this.dpr, this.H * this.dpr);
			this.renderer = renderer;
			this.cpu = null;
		} else {
			this.renderer = null;
			this.cpu = createCpuCanvas(canvas, this.W, this.H, 4);
			console.warn('[WarpEffect] WebGL unavailable — falling back to a low-res CPU renderer.');
		}
	}

	render(deltaTime: number, config: EffectConfig): void {
		this.time += deltaTime / 1000;
		const speed = config.speed ?? 1;
		const density = config.intensity ?? 1;

		const renderer = this.renderer;
		if (renderer) {
			if (!renderer.use()) return;
			const gl = renderer.gl!;

			const uRes = renderer.uniform('u_resolution');
			const uTime = renderer.uniform('u_time');
			const uC1 = renderer.uniform('u_c1');
			const uC2 = renderer.uniform('u_c2');
			const uC3 = renderer.uniform('u_c3');
			const uSpeed = renderer.uniform('u_speed');
			const uDensity = renderer.uniform('u_density');

			if (uRes) gl.uniform2f(uRes, this.W * this.dpr, this.H * this.dpr);
			if (uTime) gl.uniform1f(uTime, this.time);
			const [c1r, c1g, c1b] = hexToRgb(config.color ?? this.defaultConfig.color!);
			const [c2r, c2g, c2b] = hexToRgb(config.color2 ?? this.defaultConfig.color2!);
			const [c3r, c3g, c3b] = hexToRgb(config.color3 ?? this.defaultConfig.color3!);
			if (uC1) gl.uniform3f(uC1, c1r, c1g, c1b);
			if (uC2) gl.uniform3f(uC2, c2r, c2g, c2b);
			if (uC3) gl.uniform3f(uC3, c3r, c3g, c3b);
			if (uSpeed) gl.uniform1f(uSpeed, speed);
			if (uDensity) gl.uniform1f(uDensity, density);

			renderer.draw();
			renderer.blit(this.host2d, this.W, this.H, this.dpr);
			return;
		}

		const cpu = this.cpu;
		if (!cpu) return;
		const gw = cpu.gridW;
		const gh = cpu.gridH;
		const px = cpu.pixels;
		const c1 = hexToRgb(config.color ?? this.defaultConfig.color!);
		const c2 = hexToRgb(config.color2 ?? this.defaultConfig.color2!);
		const c3 = hexToRgb(config.color3 ?? this.defaultConfig.color3!);
		let idx = 0;
		for (let gy = 0; gy < gh; gy++) {
			for (let gx = 0; gx < gw; gx++) {
				shadePixel(gx, gy, gw, gh, this.time, speed, density, c1, c2, c3, px, idx);
				idx += 4;
			}
		}
		cpu.blit(this.dpr);
	}

	resize(width: number, height: number): void {
		this.W = width;
		this.H = height;
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		if (this.renderer) {
			this.renderer.setSize(width * this.dpr, height * this.dpr);
		} else if (this.cpu && this.canvas) {
			this.cpu = createCpuCanvas(this.canvas, width, height, 4) ?? this.cpu;
		}
	}

	destroy(): void {
		this.renderer?.destroy();
		this.renderer = null;
		this.cpu = null;
		this.host2d = null;
		this.canvas = null;
		this.time = 0;
	}
}
