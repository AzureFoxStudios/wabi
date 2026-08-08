import type { AmbientEffect, EffectConfig } from '../types';

interface Ember {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	life: number;
	maxLife: number;
	wobble: number;
	wobbleSpeed: number;
	spark: boolean;
}

/**
 * Embers — rising sparks from a hidden fire below, with occasional flare bursts.
 * Two-tone warm: brighter white-orange core, cooler orange-red edge.
 */
export class EmbersEffect implements AmbientEffect {
	id = 'embers';
	name = 'Embers';
	description = 'Hot coals rising with flickering glow and flare bursts.';

	private ctx: CanvasRenderingContext2D | null = null;
	private embers: Ember[] = [];
	private W = 0;
	private H = 0;
	// Pre-rendered ember sprites (offscreen canvases) — one per size bucket
	private sprites: { canvas: HTMLCanvasElement; r: number; color: string; color2: string }[] = [];
	private spriteColor = '';
	private spriteColor2 = '';

	defaultConfig: EffectConfig = {
		color: '#ff7b1c',
		color2: '#ef4444',
		intensity: 1,
		size: 1,
		speed: 1
	};

	init(canvas: HTMLCanvasElement, config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		canvas.width = this.W * dpr;
		canvas.height = this.H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.buildSprites(config.color || this.defaultConfig.color!, config.color2 || this.defaultConfig.color2!);
		this.embers = [];
		const count = Math.min(300, Math.max(70, Math.floor((this.W * this.H) / 18000)));
		for (let i = 0; i < count; i++) {
			const e = this.make();
			e.y = this.H - Math.random() * this.H * 0.85;
			e.life = Math.random() * e.maxLife;
			this.embers.push(e);
		}
	}

	// Pre-render ember sprites to offscreen canvases — avoids per-frame gradient allocation
	private buildSprites(color: string, color2: string): void {
		if (this.spriteColor === color && this.spriteColor2 === color2) return;
		this.spriteColor = color;
		this.spriteColor2 = color2;
		this.sprites = [];

		// Render a few size buckets: small (r=0.35), medium (r=0.7), large (r=1.05)
		const sizes = [0.35, 0.7, 1.05];
		for (const r of sizes) {
			const spriteR = r * 4 * 2; // radius * 4 (gradient spread) * 2 (spark multiplier)
			const size = Math.ceil(spriteR * 2);
			const offscreen = document.createElement('canvas');
			offscreen.width = size;
			offscreen.height = size;
			const sctx = offscreen.getContext('2d')!;
			const cx = size / 2;
			const g = sctx.createRadialGradient(cx, cx, 0, cx, cx, spriteR);
			g.addColorStop(0, this.lerpColor(color, '#ffffff', 0.45, 1));
			g.addColorStop(0.35, this.lerpColor(color, color2, 0.2, 0.7));
			g.addColorStop(1, this.lerpColor(color2, '#000000', 0.3, 0));
			sctx.fillStyle = g;
			sctx.beginPath();
			sctx.arc(cx, cx, spriteR, 0, Math.PI * 2);
			sctx.fill();
			this.sprites.push({ canvas: offscreen, r: r, color, color2 });
		}
	}

	private getSprite(r: number): HTMLCanvasElement | null {
		// Find closest sprite by radius
		let best = this.sprites[0];
		let bestDist = Infinity;
		for (const s of this.sprites) {
			const d = Math.abs(s.r - r);
			if (d < bestDist) { bestDist = d; best = s; }
		}
		return best?.canvas ?? null;
	}

	private make(): Ember {
		const band = Math.random();
		// 70% from bottom fifth, 30% from mid-bottom — feels like a fire below
		const yBase = band < 0.7 ? this.H * 0.75 : this.H * 0.45;
		return {
			x: Math.random() * this.W,
			y: yBase + Math.random() * (this.H - yBase),
			vx: (Math.random() - 0.5) * 0.45,
			vy: -0.35 - Math.random() * 0.9,
			r: 0.35 + Math.random() * 0.7,
			life: 0,
			maxLife: 180 + Math.random() * 260,
			wobble: Math.random() * Math.PI * 2,
			wobbleSpeed: 0.02 + Math.random() * 0.04,
			spark: false
		};
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;

		// soft trailing fade instead of hard clear — embers leave warmth behind
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = 'rgba(0,0,0,0.22)';
		ctx.fillRect(0, 0, this.W, this.H);
		ctx.globalCompositeOperation = 'lighter';

		const color = config.color || this.defaultConfig.color!;
		const color2 = config.color2 || this.defaultConfig.color2!;
		const sizeMult = config.size ?? 1;
		const speedMult = config.speed ?? 1;
		const intensity = config.intensity ?? 1;

		for (let i = this.embers.length - 1; i >= 0; i--) {
			const e = this.embers[i];
			e.wobble += e.wobbleSpeed * speedMult;
			e.x += e.vx + Math.sin(e.wobble) * 0.55;
			e.y += e.vy * speedMult;
			e.life += speedMult;

			if (e.life > e.maxLife || e.y < -30 || e.x < -80 || e.x > this.W + 80) {
				this.embers.splice(i, 1);
				if (this.embers.length < 90) this.embers.push(this.make());
				continue;
			}

			// smooth fade over life
			const t = e.life / e.maxLife;
			const fade = Math.sin(t * Math.PI);
			const baseAlpha = fade * 0.55 * Math.min(1, intensity * 1.2);

			// hot core + cooler halo — use pre-rendered sprite
			const r = e.r * (e.spark ? 2.2 : 1) * sizeMult;
			const sprite = this.getSprite(e.r);
			if (sprite) {
				const drawR = r * 4;
				ctx.globalAlpha = baseAlpha;
				ctx.drawImage(sprite, e.x - drawR, e.y - drawR, drawR * 2, drawR * 2);
				ctx.globalAlpha = 1;
			}

			e.spark = false;
		}

		// occasional flare burst from bottom
		if (Math.random() < 0.012 * intensity * speedMult) {
			const bx = Math.random() * this.W;
			const count = 4 + (Math.random() * 6) | 0;
			for (let i = 0; i < count; i++) {
				const e = this.make();
				e.x = bx + (Math.random() - 0.5) * 50;
				e.y = this.H - 5 - Math.random() * 30;
				e.vy *= 1.6;
				e.r = 0.6 + Math.random() * 1.2;
				e.maxLife = 100 + Math.random() * 140;
				e.spark = true;
				this.embers.push(e);
			}
		}

		// subtle warm ground glow — gives sense of heat source
		if (intensity > 0.25) {
			const ground = ctx.createLinearGradient(0, this.H, 0, this.H * 0.75);
			ground.addColorStop(0, this.lerpColor(color, '#000000', 0.7, 0.04 * intensity));
			ground.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = ground;
			ctx.fillRect(0, this.H * 0.75, this.W, this.H * 0.25);
		}

		ctx.globalCompositeOperation = 'source-over';
	}

	private lerpColor(a: string, b: string, t: number, alpha: number): string {
		const ar = parseInt(a.slice(1, 3), 16);
		const ag = parseInt(a.slice(3, 5), 16);
		const ab = parseInt(a.slice(5, 7), 16);
		const br = parseInt(b.slice(1, 3), 16);
		const bg2 = parseInt(b.slice(3, 5), 16);
		const bb = parseInt(b.slice(5, 7), 16);
		const rr = Math.round(ar + (br - ar) * t);
		const rg = Math.round(ag + (bg2 - ag) * t);
		const rb = Math.round(ab + (bb - ab) * t);
		return `rgba(${rr},${rg},${rb},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
	}

	resize(w: number, h: number): void {
		this.W = w;
		this.H = h;
		const count = Math.max(70, Math.floor((w * h) / 18000));
		this.embers = [];
		for (let i = 0; i < count; i++) {
			const e = this.make();
			e.y = h - Math.random() * h * 0.85;
			e.life = Math.random() * e.maxLife;
			this.embers.push(e);
		}
	}

	destroy(): void {
		this.ctx = null;
		this.embers = [];
	}
}
