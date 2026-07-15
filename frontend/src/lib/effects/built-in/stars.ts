import type { AmbientEffect, EffectConfig } from '../types';

interface Star {
	x: number;
	y: number;
	size: number;
	phase: number;
	speed: number;
	life: number;
}

/**
 * Stars — ported from Odysseus' `sparkles` pattern.
 * Twinkling 4-point stars that fade in and out (appear & dissolve),
 * drifting gently through the void.
 */
export class StarsEffect implements AmbientEffect {
	id = 'stars';
	name = 'Stars';
	description = 'Twinkling stars that fade in and out, drifting through the void.';

	private ctx: CanvasRenderingContext2D | null = null;
	private stars: Star[] = [];
	private W = 0;
	private H = 0;

	defaultConfig: EffectConfig = {
		color: '#9cc3ff',
		intensity: 0.6,
		size: 1,
		speed: 1
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		canvas.width = this.W * dpr;
		canvas.height = this.H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.stars = [];
		const count = Math.max(35, Math.floor((this.W * this.H) / 30000));
		for (let i = 0; i < count; i++) this.stars.push(this.make());
	}

	private make(): Star {
		return {
			x: Math.random() * this.W,
			y: Math.random() * this.H,
			size: 2 + Math.random() * 5,
			phase: Math.random() * Math.PI * 2,
			speed: 0.015 + Math.random() * 0.03,
			life: 0.5 + Math.random() * 0.5
		};
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.W, this.H);

		const color = config.color || this.defaultConfig.color;
		const sizeMult = config.size ?? 1;
		const intensity = config.intensity ?? 0.6;
		const speedMult = config.speed ?? 1;

		for (const s of this.stars) {
			s.phase += s.speed * speedMult;
			const twinkle = Math.sin(s.phase);
			const alpha = Math.max(0, twinkle) * 0.25 * s.life * intensity;
			const scale = 0.5 + Math.max(0, twinkle) * 0.5;
			if (alpha > 0.01) this.drawStar(s.x, s.y, s.size * scale * sizeMult, color, alpha);
			if (s.phase > Math.PI * 6) Object.assign(s, this.make());
		}
		ctx.globalAlpha = 1;
	}

	private drawStar(x: number, y: number, r: number, color: string, alpha: number): void {
		const ctx = this.ctx!;
		ctx.save();
		ctx.translate(x, y);
		ctx.fillStyle = color;
		ctx.globalAlpha = alpha;
		ctx.beginPath();
		ctx.moveTo(0, -r);
		ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
		ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
		ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
		ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
		ctx.fill();
		ctx.restore();
	}

	resize(w: number, h: number): void {
		this.W = w;
		this.H = h;
		this.stars = [];
		const count = Math.max(35, Math.floor((w * h) / 30000));
		for (let i = 0; i < count; i++) this.stars.push(this.make());
	}

	destroy(): void {
		this.ctx = null;
		this.stars = [];
	}
}
