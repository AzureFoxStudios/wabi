import type { AmbientEffect, EffectConfig } from '../types';

interface Star {
	x: number;
	y: number;
	size: number;
	phase: number;
	speed: number;
	age: number;
	maxAge: number;
}

/**
 * Stars — twinkling points that fade in and out like a breathing sky.
 * Each star has a full lifecycle: fade in, shine, fade out, then respawn.
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
		const count = Math.max(60, Math.floor((this.W * this.H) / 22000));
		for (let i = 0; i < count; i++) this.stars.push(this.make(true));
	}

	private make(randomAge = false): Star {
		const maxAge = 280 + Math.random() * 420;
		return {
			x: Math.random() * this.W,
			y: Math.random() * this.H,
			size: 1.2 + Math.random() * 4.5,
			phase: Math.random() * Math.PI * 2,
			speed: 0.01 + Math.random() * 0.02,
			age: randomAge ? Math.random() * maxAge : 0,
			maxAge: maxAge
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
			s.age += speedMult;
			if (s.age > s.maxAge) Object.assign(s, this.make(false));

			const t = s.age / s.maxAge;
			const fade = Math.sin(t * Math.PI); // smooth in/out across full life
			const twinkle = 0.55 + 0.45 * Math.sin(s.phase);
			const alpha = fade * twinkle * 0.8 * intensity;
			const scale = 0.35 + twinkle * 0.65;
			if (alpha > 0.006) this.drawStar(s.x, s.y, s.size * scale * sizeMult, color, alpha);
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
		const count = Math.max(60, Math.floor((w * h) / 22000));
		this.stars = [];
		for (let i = 0; i < count; i++) this.stars.push(this.make(true));
	}

	destroy(): void {
		this.ctx?.clearRect(0, 0, this.W, this.H);
		this.ctx = null;
		this.stars = [];
	}
}
