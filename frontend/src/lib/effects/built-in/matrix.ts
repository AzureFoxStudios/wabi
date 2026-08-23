import type { AmbientEffect, EffectConfig } from '../types';

const GLYPHS =
	'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789$#@%&*+=?';

/**
 * Matrix — the iconic digital rain. Classic 2D canvas trail technique:
 * translucent black fills leave a fading trail behind each falling glyph
 * column. Cheap enough to run anywhere the other 2D effects do.
 */
export class MatrixRainEffect implements AmbientEffect {
	id = 'matrix';
	name = 'Matrix';
	description = 'Digital rain — the iconic green glyph cascade.';
	usesWebGL = false;

	private ctx: CanvasRenderingContext2D | null = null;
	private drops: number[] = [];
	private cols = 0;
	private fontSize = 18;
	private W = 0;
	private H = 0;

	defaultConfig: EffectConfig = {
		color: '#00ff41',
		color2: '#c8ffcf',
		intensity: 1,
		size: 1,
		speed: 1,
	};

	init(canvas: HTMLCanvasElement, config: EffectConfig): void {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		canvas.width = this.W * dpr;
		canvas.height = this.H * dpr;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.ctx = ctx;
		this.fontSize = Math.max(10, Math.round(18 * (config.size ?? 1)));
		this.buildColumns();
	}

	private buildColumns(): void {
		this.cols = Math.max(1, Math.ceil(this.W / this.fontSize));
		this.drops = [];
		for (let i = 0; i < this.cols; i++) {
			this.drops[i] = Math.random() * -60;
		}
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;

		const density = Math.min(1, Math.max(0, config.intensity ?? 1));
		const speed = Math.max(0.05, config.speed ?? 1);
		const color = config.color || this.defaultConfig.color!;
		const color2 = config.color2;

		// trail fade — leave the previous frame mostly in place
		ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
		ctx.fillRect(0, 0, this.W, this.H);

		ctx.font = `${this.fontSize}px monospace`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		for (let i = 0; i < this.cols; i++) {
			// density gates how many columns actively rain this frame
			if (Math.random() > 0.2 + density * 0.8) continue;

			const x = i * this.fontSize + this.fontSize / 2;
			const y = this.drops[i] * this.fontSize;
			// signature: occasional "glitch" column flickers a dim secondary
			// glyph instead of the standard one — the rain stutters like a
			// corrupted feed rather than falling at a perfectly even rate.
			if (color2 && Math.random() < 0.06) {
				ctx.fillStyle = color2;
				ctx.globalAlpha = 0.5;
				ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y);
				ctx.globalAlpha = 1;
			} else {
				ctx.fillStyle = color;
				ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y);
			}
			// brighter "head" glyph one cell above the trail
			ctx.fillStyle = '#eafff0';
			ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y - this.fontSize);

			// stutter: rare frames skip advance entirely on some columns
			if (y > this.H && Math.random() > 0.975) {
				this.drops[i] = Math.random() * -10;
			} else if (Math.random() > 0.02) {
				this.drops[i] += 0.5 * speed;
			}
		}
	}

	resize(width: number, height: number): void {
		this.W = width;
		this.H = height;
		this.buildColumns();
	}

	destroy(): void {
		// hard clear so the fading trail doesn't smear into the next effect
		this.ctx?.clearRect(0, 0, this.W, this.H);
		this.ctx = null;
		this.drops = [];
	}
}
