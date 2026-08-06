import type { AmbientEffect, EffectConfig } from '../types';
import { createWebGLRenderer, type WebGLRenderer } from './webgl';
import { createCpuCanvas, type CpuCanvas, smoothstep, hash2, fract } from './cpu';

/**
 * The Spire — the swirling star vortex around the mountain peak from
 * Slay the Spire. A slowly rotating spiral of streak bands with a twinkling
 * star field, capped by layered mountain silhouettes at the bottom.
 *
 * Original concept (vortex sky over a peak) is drawn from memory of the
 * game's atmosphere; rendered procedurally, no game assets used.
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
	vec2 peak = vec2(0.0, -0.42);
	vec2 vp = p - peak;
	float r = length(vp);
	float a = atan(vp.y, vp.x);

	// spiral streak bands rotating around the peak
	float spiral = a + r * 7.0 + u_time * 0.7 * u_speed;
	float band = fract(r * 11.0 - u_time * 0.9 * u_speed);
	float streak = smoothstep(0.55, 1.0, band) * (0.5 + 0.5 * sin(spiral * 2.5 + 1.7));
	float falloff = exp(-r * 1.35) * (1.0 - smoothstep(1.15, 2.4, r));

	// twinkling star field
	vec2 cell = floor(gl_FragCoord.xy / 16.0);
	float h = hash(cell);
	float tw = 0.5 + 0.5 * sin(u_time * 1.5 * u_speed + h * 40.0);
	float star = smoothstep(0.972, 1.0, h) * (0.35 + 0.65 * tw);

	vec3 col = u_c3;
	col += u_c1 * streak * falloff * u_density;
	col += u_c2 * star * (0.4 + falloff * 0.6);

	// mountain silhouettes across the bottom
	float baseY = -0.30;
	float ridge = baseY;
	ridge = max(ridge, baseY + 0.30 * (1.0 - abs(p.x - 0.18) / 0.42));
	ridge = max(ridge, baseY + 0.58 * (1.0 - abs(p.x - 0.0) / 0.30));
	ridge = max(ridge, baseY + 0.34 * (1.0 - abs(p.x + 0.22) / 0.46));
	ridge = max(ridge, baseY + 0.18 * (1.0 - abs(p.x + 0.62) / 0.55));
	float mountain = (1.0 - smoothstep(0.0, 0.004, p.y - ridge)) * smoothstep(baseY + 0.03, baseY + 0.25, ridge);
	col = mix(col, u_c3 * 0.55, mountain);

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
	return [0.56, 0.69, 1];
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
	const py = (gy - gh / 2) / gh;
	const vx = px;
	const vy = py + 0.42;
	const r = Math.hypot(vx, vy);
	const a = Math.atan2(vy, vx);

	const spiral = a + r * 7 + t * 0.7 * speed;
	const band = fract(r * 11 - t * 0.9 * speed);
	const streak = smoothstep(0.55, 1, band) * (0.5 + 0.5 * Math.sin(spiral * 2.5 + 1.7));
	const falloff = Math.exp(-r * 1.35) * (1 - smoothstep(1.15, 2.4, r));

	const cell = 100;
	const h = hash2(Math.floor(gx / cell), Math.floor(gy / cell));
	const tw = 0.5 + 0.5 * Math.sin(t * 1.5 * speed + h * 40);
	const star = smoothstep(0.972, 1, h) * (0.35 + 0.65 * tw);

	let r2 = c3[0];
	let g2 = c3[1];
	let b2 = c3[2];
	r2 += c1[0] * streak * falloff * density;
	g2 += c1[1] * streak * falloff * density;
	b2 += c1[2] * streak * falloff * density;
	const sm = 0.4 + falloff * 0.6;
	r2 += c2[0] * star * sm;
	g2 += c2[1] * star * sm;
	b2 += c2[2] * star * sm;

	const baseY = -0.3;
	let ridge = baseY;
	ridge = Math.max(ridge, baseY + 0.3 * (1 - Math.abs(px - 0.18) / 0.42));
	ridge = Math.max(ridge, baseY + 0.58 * (1 - Math.abs(px) / 0.3));
	ridge = Math.max(ridge, baseY + 0.34 * (1 - Math.abs(px + 0.22) / 0.46));
	ridge = Math.max(ridge, baseY + 0.18 * (1 - Math.abs(px + 0.62) / 0.55));
	const mountain = (1 - smoothstep(0, 0.004, py - ridge)) * smoothstep(baseY + 0.03, baseY + 0.25, ridge);
	r2 = r2 * (1 - mountain) + c3[0] * 0.55 * mountain;
	g2 = g2 * (1 - mountain) + c3[1] * 0.55 * mountain;
	b2 = b2 * (1 - mountain) + c3[2] * 0.55 * mountain;

	out[idx] = Math.min(255, Math.max(0, Math.round(r2 * 255)));
	out[idx + 1] = Math.min(255, Math.max(0, Math.round(g2 * 255)));
	out[idx + 2] = Math.min(255, Math.max(0, Math.round(b2 * 255)));
	out[idx + 3] = 255;
}

export class SpireEffect implements AmbientEffect {
	id = 'spire';
	name = 'The Spire';
	description = 'The swirling star vortex around the Spire peak from Slay the Spire.';
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
		color: '#8fb0ff',
		color2: '#dfe6ff',
		color3: '#0a0f1e',
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

		const renderer = createWebGLRenderer(FRAG_SRC, 'spire');
		if (renderer.ready) {
			renderer.setSize(this.W * this.dpr, this.H * this.dpr);
			this.renderer = renderer;
			this.cpu = null;
		} else {
			this.renderer = null;
			this.cpu = createCpuCanvas(canvas, this.W, this.H, 4);
			console.warn('[SpireEffect] WebGL unavailable — falling back to a low-res CPU renderer.');
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
