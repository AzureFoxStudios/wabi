/**
 * Low-resolution CPU renderer used when WebGL is unavailable.
 * Each effect shades a coarse pixel grid (ImageData), then the grid is
 * upscaled onto the shared ambient canvas with nearest-neighbor sampling —
 * the chunky pixel look is a natural fit for these shader aesthetics.
 */

export interface CpuCanvas {
	/** CSS px */
	readonly width: number;
	readonly height: number;
	readonly gridW: number;
	readonly gridH: number;
	/** RGBA bytes for gridW * gridH pixels, shaded by the effect. */
	readonly pixels: Uint8ClampedArray;
	/** Upload + upscale the grid onto the shared canvas. */
	blit(dpr: number): void;
	destroy(): void;
}

export function createCpuCanvas(
	canvas: HTMLCanvasElement,
	w: number,
	h: number,
	divisor: number
): CpuCanvas | null {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	canvas.width = w * dpr;
	canvas.height = h * dpr;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;

	const gridW = Math.max(2, Math.round(w / divisor));
	const gridH = Math.max(2, Math.round(h / divisor));
	const off = document.createElement('canvas');
	off.width = gridW;
	off.height = gridH;
	const octx = off.getContext('2d');
	if (!octx) return null;

	const data = octx.createImageData(gridW, gridH);
	return {
		width: w,
		height: h,
		gridW,
		gridH,
		pixels: data.data,
		blit(dpr2: number) {
			octx.putImageData(data, 0, 0);
			ctx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
			ctx.imageSmoothingEnabled = false;
			ctx.clearRect(0, 0, w, h);
			ctx.drawImage(off, 0, 0, gridW, gridH, 0, 0, w, h);
		},
		destroy() {
			// no persistent resources; the grid is discarded with the object
		},
	};
}

// ============================================================================
// GLSL-alike math helpers shared by the CPU fallback shades
// ============================================================================

/** GLSL smoothstep(e0, e1, x) */
export function smoothstep(e0: number, e1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
	return t * t * (3 - 2 * t);
}

/** GLSL fract(x) */
export function fract(x: number): number {
	return x - Math.floor(x);
}

/** GLSL hash(vec2) — same function the shaders use. */
export function hash2(x: number, y: number): number {
	const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
	return s - Math.floor(s);
}
