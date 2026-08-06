import type { AmbientEffect, EffectConfig } from '../types';
import { createWebGLRenderer, type WebGLRenderer } from './webgl';
import { createCpuCanvas, type CpuCanvas } from './cpu';

/**
 * Joker — the iconic paint-swirl background from the hit roguelike
 * deck-builder. A pixelated, spinning flow field: polar rotation plus a
 * 5-iteration sin/cos domain warp blended through three colors.
 *
 * The flow-field domain-warp technique is a widely published graphics
 * approach; the constants are tuned to reproduce the recognizable Joker
 * look. No game assets are used.
 *
 * Rendered via the shared WebGL renderer into an offscreen canvas that is
 * blitted onto the ambient 2D canvas each frame. When WebGL is unavailable,
 * falls back to a low-res CPU renderer of the same math (the pixelated look
 * survives the resolution drop).
 */

const FRAG_SRC = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform float u_contrast;
uniform float u_spin_amount;
uniform float u_spin_speed;
uniform float u_move_speed;
uniform float u_pixel_filter;

void main() {
	vec2 screenSize = u_resolution;
	float pixel_size = length(screenSize.xy) / u_pixel_filter;
	vec2 uv = (floor(gl_FragCoord.xy * (1.0 / pixel_size)) * pixel_size - 0.5 * screenSize.xy) / length(screenSize.xy);
	float uv_len = length(uv);

	float speed = u_time * (u_spin_speed * 0.2);
	speed += 302.2;
	float new_pixel_angle = (atan(uv.y, uv.x)) + speed - 20.0 * (u_spin_amount * uv_len + (1.0 - u_spin_amount));
	vec2 mid = (screenSize.xy / length(screenSize.xy)) / 2.0;
	uv = (vec2((uv_len * cos(new_pixel_angle) + mid.x), (uv_len * sin(new_pixel_angle) + mid.y)) - mid);

	uv *= 30.0;
	speed = u_time * u_move_speed;
	vec2 uv2 = vec2(uv.x + uv.y);

	for (int i = 0; i < 5; i++) {
		uv2 += sin(max(uv.x, uv.y)) + uv;
		uv += 0.5 * vec2(cos(5.1123314 + 0.353 * uv2.y + speed * 0.131121), sin(uv2.x - 0.113 * speed));
		uv -= cos(uv.x + uv.y) - sin(uv.x * 0.711 - uv.y);
	}

	float contrast_mod = (0.25 * u_contrast + 0.5 * u_spin_amount + 1.2);
	float paint_res = min(2.0, max(0.0, length(uv) * 0.035 * contrast_mod));
	float c1p = max(0.0, 1.0 - contrast_mod * abs(1.0 - paint_res));
	float c2p = max(0.0, 1.0 - contrast_mod * abs(paint_res));
	float c3p = 1.0 - min(1.0, c1p + c2p);

	float lighting = 0.4;
	float light = (lighting - 0.2) * max(c1p * 5.0 - 4.0, 0.0) + lighting * max(c2p * 5.0 - 4.0, 0.0);
	vec3 ret_col = (0.3 / u_contrast) * u_c1 + (1.0 - 0.3 / u_contrast) * (u_c1 * c1p + u_c2 * c2p + c3p * u_c3) + light;

	gl_FragColor = vec4(ret_col, 1.0);
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
	return [0.871, 0.267, 0.231];
}

/**
 * Faithful JS port of the fragment shader above, writing one grid pixel.
 * Grid coords play the role of gl_FragCoord in the low-res canvas space.
 */
function shadePixel(
	gx: number,
	gy: number,
	gw: number,
	gh: number,
	t: number,
	size: number,
	speed: number,
	contrast: number,
	spinAmount: number,
	spinSpeed: number,
	moveSpeed: number,
	pixelFilter: number,
	c1: [number, number, number],
	c2: [number, number, number],
	c3: [number, number, number],
	out: Uint8ClampedArray,
	idx: number
): void {
	const screenLen = Math.hypot(gw, gh);
	const pixelSize = screenLen / pixelFilter;
	const uvx0 = (Math.floor(gx / pixelSize) * pixelSize - 0.5 * gw) / screenLen;
	const uvy0 = (Math.floor(gy / pixelSize) * pixelSize - 0.5 * gh) / screenLen;
	const uvLen = Math.hypot(uvx0, uvy0);

	let speedVal = t * (spinSpeed * 0.2) + 302.2;
	const newAngle = Math.atan2(uvy0, uvx0) + speedVal - 20 * (spinAmount * uvLen + (1 - spinAmount));
	let uvx = uvLen * Math.cos(newAngle);
	let uvy = uvLen * Math.sin(newAngle);
	uvx *= 30;
	uvy *= 30;
	speedVal = t * moveSpeed;
	let uv2x = uvx + uvy;
	let uv2y = uvx + uvy;
	for (let i = 0; i < 5; i++) {
		const s1 = Math.sin(Math.max(uvx, uvy));
		uv2x += s1 + uvx;
		uv2y += s1 + uvy;
		uvx += 0.5 * Math.cos(5.1123314 + 0.353 * uv2y + speedVal * 0.131121);
		uvy += 0.5 * Math.sin(uv2x - 0.113 * speedVal);
		const s2 = Math.cos(uvx + uvy) - Math.sin(uvx * 0.711 - uvy);
		uvx -= s2;
		uvy -= s2;
	}

	const contrastMod = 0.25 * contrast + 0.5 * spinAmount + 1.2;
	const paintRes = Math.min(2, Math.max(0, Math.hypot(uvx, uvy) * 0.035 * contrastMod));
	const c1p = Math.max(0, 1 - contrastMod * Math.abs(1 - paintRes));
	const c2p = Math.max(0, 1 - contrastMod * Math.abs(paintRes));
	const c3p = 1 - Math.min(1, c1p + c2p);
	const lighting = 0.4;
	const light = (lighting - 0.2) * Math.max(c1p * 5 - 4, 0) + lighting * Math.max(c2p * 5 - 4, 0);
	const base = 0.3 / contrast;
	const mixWeight = 1 - base;

	const r = Math.min(255, Math.max(0, Math.round((base * c1[0] + mixWeight * (c1[0] * c1p + c2[0] * c2p + c3p * c3[0]) + light) * 255)));
	const g = Math.min(255, Math.max(0, Math.round((base * c1[1] + mixWeight * (c1[1] * c1p + c2[1] * c2p + c3p * c3[1]) + light) * 255)));
	const b = Math.min(255, Math.max(0, Math.round((base * c1[2] + mixWeight * (c1[2] * c1p + c2[2] * c2p + c3p * c3[2]) + light) * 255)));
	out[idx] = r;
	out[idx + 1] = g;
	out[idx + 2] = b;
	out[idx + 3] = 255;
}

export class JokerEffect implements AmbientEffect {
	id = 'joker';
	name = 'Joker';
	description = 'The iconic paint swirl from Joker — a pixelated spinning flow field in red, blue, and black.';
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
		color: '#de443b',
		color2: '#006bb4',
		color3: '#162325',
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

		const renderer = createWebGLRenderer(FRAG_SRC, 'joker');
		if (renderer.ready) {
			renderer.setSize(this.W * this.dpr, this.H * this.dpr);
			this.renderer = renderer;
			this.cpu = null;
		} else {
			this.renderer = null;
			this.cpu = createCpuCanvas(canvas, this.W, this.H, 6);
			console.warn('[JokerEffect] WebGL unavailable — falling back to a low-res CPU renderer.');
		}
	}

	render(deltaTime: number, config: EffectConfig): void {
		this.time += deltaTime / 1000;
		const size = config.size ?? 1;
		const speed = config.speed ?? 1;
		const intensity = config.intensity ?? 1;

		const renderer = this.renderer;
		if (renderer) {
			if (!renderer.use()) return;
			const gl = renderer.gl!;

			const uRes = renderer.uniform('u_resolution');
			const uTime = renderer.uniform('u_time');
			const uC1 = renderer.uniform('u_c1');
			const uC2 = renderer.uniform('u_c2');
			const uC3 = renderer.uniform('u_c3');
			const uContrast = renderer.uniform('u_contrast');
			const uSpinAmount = renderer.uniform('u_spin_amount');
			const uSpinSpeed = renderer.uniform('u_spin_speed');
			const uMoveSpeed = renderer.uniform('u_move_speed');
			const uPixelFilter = renderer.uniform('u_pixel_filter');

			if (uRes) gl.uniform2f(uRes, this.W * this.dpr, this.H * this.dpr);
			if (uTime) gl.uniform1f(uTime, this.time);
			const [c1r, c1g, c1b] = hexToRgb(config.color ?? this.defaultConfig.color!);
			const [c2r, c2g, c2b] = hexToRgb(config.color2 ?? this.defaultConfig.color2!);
			const [c3r, c3g, c3b] = hexToRgb(config.color3 ?? this.defaultConfig.color3!);
			if (uC1) gl.uniform3f(uC1, c1r, c1g, c1b);
			if (uC2) gl.uniform3f(uC2, c2r, c2g, c2b);
			if (uC3) gl.uniform3f(uC3, c3r, c3g, c3b);
			// intensity drives contrast (1 -> 3.5, the game's default)
			if (uContrast) gl.uniform1f(uContrast, 1 + intensity * 2.5);
			if (uSpinAmount) gl.uniform1f(uSpinAmount, 0.25 * size);
			if (uSpinSpeed) gl.uniform1f(uSpinSpeed, 2 * speed);
			if (uMoveSpeed) gl.uniform1f(uMoveSpeed, 7 * speed);
			// dpr scaling keeps the pixel blocks a constant CSS size
			if (uPixelFilter) gl.uniform1f(uPixelFilter, (745 / size) * this.dpr);

			renderer.draw();
			renderer.blit(this.host2d, this.W, this.H, this.dpr);
			return;
		}

		const cpu = this.cpu;
		if (!cpu) return;
		const t = this.time;
		const gw = cpu.gridW;
		const gh = cpu.gridH;
		const px = cpu.pixels;
		const contrast = 1 + intensity * 2.5;
		const spinAmount = 0.25 * size;
		const spinSpeed = 2 * speed;
		const moveSpeed = 7 * speed;
		const pixelFilter = 745 / size;
		const c1 = hexToRgb(config.color ?? this.defaultConfig.color!);
		const c2 = hexToRgb(config.color2 ?? this.defaultConfig.color2!);
		const c3 = hexToRgb(config.color3 ?? this.defaultConfig.color3!);
		let idx = 0;
		for (let gy = 0; gy < gh; gy++) {
			for (let gx = 0; gx < gw; gx++) {
				shadePixel(gx, gy, gw, gh, t, size, speed, contrast, spinAmount, spinSpeed, moveSpeed, pixelFilter, c1, c2, c3, px, idx);
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
			this.cpu = createCpuCanvas(this.canvas, width, height, 6) ?? this.cpu;
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
