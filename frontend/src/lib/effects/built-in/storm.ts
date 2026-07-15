import type { AmbientEffect, EffectConfig } from '../types';

interface Bolt {
	segments: { x: number; y: number }[];
	life: number;
	maxLife: number;
	branchChance: number;
}

interface Particle {
	x: number;
	y: number;
	vy: number;
	vx: number;
	r: number;
	life: number;
	maxLife: number;
}

/**
 * Storm — inspired by PewDiePie's Odysseus login "storm" theme.
 * Forked lightning bolts strike from the top, rising particles drift upward,
 * and the whole scene shifts with mouse-parallax depth.
 */
export class StormEffect implements AmbientEffect {
	id = 'storm';
	name = 'Storm';
	description = 'Forked lightning, rising particles, and mouse-parallax depth.';

	private ctx: CanvasRenderingContext2D | null = null;
	private W = 0;
	private H = 0;
	private bolts: Bolt[] = [];
	private particles: Particle[] = [];
	private mouseX = 0;
	private mouseY = 0;
	private onMouseMove = (e: MouseEvent) => {
		this.mouseX = e.clientX;
		this.mouseY = e.clientY;
	};

	defaultConfig: EffectConfig = {
		color: '#9cc3ff',
		intensity: 0.5,
		size: 1,
		speed: 1
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		this.resize(window.innerWidth, window.innerHeight);
		window.addEventListener('mousemove', this.onMouseMove);
	}

	private makeBolt(): Bolt {
		const startX = Math.random() * this.W;
		const segments = [{ x: startX, y: 0 }];
		let x = startX;
		let y = 0;
		const step = 18 + Math.random() * 14;
		while (y < this.H) {
			x += (Math.random() - 0.5) * 60;
			y += step;
			segments.push({ x, y });
		}
		return {
			segments,
			life: 0,
			maxLife: 10 + Math.random() * 8,
			branchChance: 0.12
		};
	}

	private makeParticle(): Particle {
		return {
			x: Math.random() * this.W,
			y: this.H + 10,
			vx: (Math.random() - 0.5) * 0.4,
			vy: -0.3 - Math.random() * 0.9,
			r: 0.4 + Math.random() * 0.8,
			life: 0,
			maxLife: 160 + Math.random() * 200
		};
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;

		// Trailing fade for the lightning afterglow.
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = 'rgba(0,0,0,0.28)';
		ctx.fillRect(0, 0, this.W, this.H);
		ctx.globalCompositeOperation = 'lighter';

		const color = config.color || this.defaultConfig.color;
		const intensity = config.intensity ?? 0.5;
		const speedMult = config.speed ?? 1;

		// Mouse-parallax depth offset.
		const px = (this.mouseX / Math.max(1, this.W) - 0.5) * 26;
		const py = (this.mouseY / Math.max(1, this.H) - 0.5) * 18;
		ctx.save();
		ctx.translate(px, py);

		// Spawn lightning.
		if (Math.random() < 0.012 + intensity * 0.05) {
			this.bolts.push(this.makeBolt());
		}

		// Draw + age bolts.
		ctx.lineCap = 'round';
		for (let i = this.bolts.length - 1; i >= 0; i--) {
			const bolt = this.bolts[i];
			bolt.life += speedMult;
			const fade = 1 - bolt.life / bolt.maxLife;
			if (fade <= 0) {
				this.bolts.splice(i, 1);
				continue;
			}
			ctx.strokeStyle = color;
			ctx.globalAlpha = fade;
			ctx.lineWidth = 1.6;
			ctx.shadowColor = color;
			ctx.shadowBlur = 12;
			ctx.beginPath();
			ctx.moveTo(bolt.segments[0].x, bolt.segments[0].y);
			for (let s = 1; s < bolt.segments.length; s++) {
				ctx.lineTo(bolt.segments[s].x, bolt.segments[s].y);
			}
			ctx.stroke();
			ctx.shadowBlur = 0;
		}

		// Rising particles.
		if (this.particles.length < 90 && Math.random() < 0.5) {
			this.particles.push(this.makeParticle());
		}
		for (let i = this.particles.length - 1; i >= 0; i--) {
			const p = this.particles[i];
			p.x += p.vx;
			p.y += p.vy * speedMult;
			p.life += speedMult;
			if (p.life > p.maxLife || p.y < -10) {
				this.particles.splice(i, 1);
				continue;
			}
			const fade = Math.min(1, Math.min(p.life / 30, (1 - p.life / p.maxLife) * 2));
			ctx.globalAlpha = fade * (0.3 + intensity * 0.5);
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r * (config.size ?? 1), 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.globalAlpha = 1;
		ctx.restore();
		ctx.globalCompositeOperation = 'source-over';
	}

	resize(w: number, h: number): void {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = w;
		this.H = h;
		const canvas = this.ctx?.canvas;
		if (canvas) {
			canvas.width = w * dpr;
			canvas.height = h * dpr;
			this.ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
	}

	destroy(): void {
		window.removeEventListener('mousemove', this.onMouseMove);
		this.ctx = null;
		this.bolts = [];
		this.particles = [];
	}
}
