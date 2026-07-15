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
	spark: boolean;
}

/**
 * Embers — ported from Odysseus' `embers` pattern.
 * Warm particles rising from the bottom with a soft glow, occasional spark
 * bursts, and a trailing fade.
 */
export class EmbersEffect implements AmbientEffect {
	id = 'embers';
	name = 'Embers';
	description = 'Warm sparks rising with a flickering glow.';

	private ctx: CanvasRenderingContext2D | null = null;
	private embers: Ember[] = [];
	private W = 0;
	private H = 0;

	defaultConfig: EffectConfig = {
		color: '#f97316',
		intensity: 0.4,
		size: 1,
		speed: 1.1
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		canvas.width = this.W * dpr;
		canvas.height = this.H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.embers = [];
		for (let i = 0; i < 60; i++) {
			const e = this.make();
			e.y = Math.random() * this.H;
			e.life = Math.random() * e.maxLife;
			this.embers.push(e);
		}
	}

	private make(): Ember {
		return {
			x: Math.random() * this.W,
			y: this.H + Math.random() * 40,
			vx: (Math.random() - 0.5) * 0.3,
			vy: -0.3 - Math.random() * 0.8,
			r: 0.3 + Math.random() * 0.6,
			life: 0,
			maxLife: 220 + Math.random() * 220,
			wobble: Math.random() * Math.PI * 2,
			spark: false
		};
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;

		// Trailing fade — keeps the canvas transparent where there are no embers.
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = 'rgba(0,0,0,0.18)';
		ctx.fillRect(0, 0, this.W, this.H);
		ctx.globalCompositeOperation = 'lighter';

		const color = config.color || this.defaultConfig.color;
		const sizeMult = config.size ?? 1;
		const speedMult = config.speed ?? 1;
		const intensity = config.intensity ?? 0.4;

		for (let i = this.embers.length - 1; i >= 0; i--) {
			const e = this.embers[i];
			e.wobble += 0.03 * speedMult;
			e.x += e.vx + Math.sin(e.wobble) * 0.5;
			e.y += e.vy * speedMult;
			e.life += speedMult;
			if (e.life > e.maxLife || e.y < -20) {
				this.embers.splice(i, 1);
				if (this.embers.length < 70) this.embers.push(this.make());
				continue;
			}
			if (!e.spark && Math.random() < 0.003 * intensity * 5) e.spark = true;
			const lifeRatio = e.life / e.maxLife;
			const fade = Math.min(1, Math.min(lifeRatio * 4, (1 - lifeRatio) * 3));
			const r = e.r * (e.spark ? 2.4 : 1) * sizeMult;
			const a = (e.spark ? 0.9 : 0.55) * fade * Math.min(1, intensity * 1.5);
			const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 4);
			g.addColorStop(0, this.rgba(color, a));
			g.addColorStop(0.4, this.rgba(color, a * 0.3));
			g.addColorStop(1, this.rgba(color, 0));
			ctx.fillStyle = g;
			ctx.fillRect(e.x - r * 4, e.y - r * 4, r * 8, r * 8);
			ctx.fillStyle = this.rgba('#ffffff', a * 0.6);
			ctx.beginPath();
			ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2);
			ctx.fill();
			e.spark = false;
		}

		if (Math.random() < 0.015 * intensity * 3) {
			const bx = Math.random() * this.W;
			for (let i = 0; i < 5; i++) {
				const e = this.make();
				e.x = bx + (Math.random() - 0.5) * 40;
				e.y = this.H - 10;
				e.vy *= 1.5;
				this.embers.push(e);
			}
		}

		ctx.globalCompositeOperation = 'source-over';
	}

	private rgba(hex: string, a: number): string {
		const h = hex.replace('#', '');
		const n = parseInt(h, 16);
		return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
	}

	resize(w: number, h: number): void {
		this.W = w;
		this.H = h;
		this.embers = [];
		for (let i = 0; i < 60; i++) {
			const e = this.make();
			e.y = Math.random() * h;
			e.life = Math.random() * e.maxLife;
			this.embers.push(e);
		}
	}

	destroy(): void {
		this.ctx = null;
		this.embers = [];
	}
}
