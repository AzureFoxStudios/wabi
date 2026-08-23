import type { AmbientEffect, EffectConfig } from '../types';

interface Petal {
	x: number;
	y: number;
	size: number;
	rot: number;
	vr: number;
	vy: number;
	drift: number;
	driftSpeed: number;
	wobble: number;
}

/**
 * Sakura — inspired by Odysseus' `petals` pattern, then given its own
 * signature: petals now flutter (asymmetric rotation wobble), scale-breathe,
 * and dissolve into a soft fade near the bottom instead of hard-respawning.
 */
export class SakuraEffect implements AmbientEffect {
	id = 'sakura';
	name = 'Sakura';
	description = 'Soft petals drifting and dissolving through the air.';

	private ctx: CanvasRenderingContext2D | null = null;
	private petals: Petal[] = [];
	private W = 0;
	private H = 0;

	defaultConfig: EffectConfig = {
		color: '#f5a0c0',
		intensity: 0.55,
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
		this.petals = [];
		for (let i = 0; i < 30; i++) {
			const p = this.make();
			p.y = Math.random() * this.H;
			this.petals.push(p);
		}
	}

	private make(): Petal {
		return {
			x: Math.random() * this.W,
			y: -10 - Math.random() * 40,
			size: 3 + Math.random() * 5,
			rot: Math.random() * Math.PI * 2,
			vr: (Math.random() - 0.5) * 0.03,
			vy: 0.3 + Math.random() * 0.6,
			drift: Math.random() * Math.PI * 2,
			driftSpeed: 0.008 + Math.random() * 0.012,
			wobble: 0.3 + Math.random() * 0.8
		};
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.W, this.H);

		const color = config.color || this.defaultConfig.color;
		const sizeMult = (config.size ?? 1) * (config.intensity ? 0.6 + config.intensity * 0.6 : 1);
		const speedMult = config.speed ?? 1;

		for (const p of this.petals) {
			p.y += p.vy * speedMult;
			p.rot += p.vr * speedMult;
			p.drift += p.driftSpeed * speedMult;
			p.x += Math.sin(p.drift) * p.wobble;
			if (p.y > this.H + 15) Object.assign(p, this.make());

			// signature: flutter + breathe. Rotation wobbles around the base spin
			// and the petal gently scales in/out — reads as tumbling in a breeze
			// rather than sliding on rails.
			const flutter = Math.sin(p.drift * 2.3);
			const breathe = 1 + flutter * 0.18;

			ctx.save();
			ctx.translate(p.x, p.y);
			ctx.rotate(p.rot + flutter * 0.35);
			ctx.scale(breathe, breathe);
			ctx.fillStyle = color;
			// Two overlapping ellipses form a petal shape.
			ctx.globalAlpha = 0.2;
			ctx.beginPath();
			ctx.ellipse(-p.size * 0.2 * sizeMult, 0, p.size * 0.6 * sizeMult, p.size * 0.3 * sizeMult, 0.3, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 0.15;
			ctx.beginPath();
			ctx.ellipse(p.size * 0.2 * sizeMult, 0, p.size * 0.6 * sizeMult, p.size * 0.3 * sizeMult, -0.3, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		ctx.globalAlpha = 1;
	}

	resize(w: number, h: number): void {
		this.W = w;
		this.H = h;
		this.petals = [];
		for (let i = 0; i < 30; i++) {
			const p = this.make();
			p.y = Math.random() * h;
			this.petals.push(p);
		}
	}

	destroy(): void {
		this.ctx = null;
		this.petals = [];
	}
}
