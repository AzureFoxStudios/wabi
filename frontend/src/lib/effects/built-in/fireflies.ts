import type { AmbientEffect, EffectConfig } from '../types';

interface Mote {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	phase: number;
	speed: number;
	maxLife: number;
	life: number;
}

/**
 * Fireflies — slow, warm glowing motes drifting through the void.
 * Soft radial glow with gentle fade-in/fade-out life cycles.
 */
export class FirefliesEffect implements AmbientEffect {
	id = 'fireflies';
	name = 'Fireflies';
	description = 'Warm glowing motes drifting lazily through darkness.';

	private ctx: CanvasRenderingContext2D | null = null;
	private motes: Mote[] = [];
	private W = 0;
	private H = 0;

	defaultConfig: EffectConfig = {
		color: '#4ade80',
		color2: '#fbbf24',
		intensity: 0.45,
		size: 1,
		speed: 0.6
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		canvas.width = this.W * dpr;
		canvas.height = this.H * dpr;
		this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.motes = [];
		const count = Math.max(12, Math.floor((this.W * this.H) / 90000));
		for (let i = 0; i < count; i++) this.motes.push(this.make(true));
	}

	private make(randomY = false): Mote {
		const life = 300 + Math.random() * 400;
		return {
			x: Math.random() * this.W,
			y: randomY ? Math.random() * this.H : this.H + Math.random() * 60,
			vx: (Math.random() - 0.5) * 0.25,
			vy: -0.15 - Math.random() * 0.35,
			r: 1.5 + Math.random() * 3,
			phase: Math.random() * Math.PI * 2,
			speed: 0.008 + Math.random() * 0.018,
			maxLife: life,
			life: randomY ? Math.random() * life : 0
		};
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.W, this.H);

		const color = config.color || this.defaultConfig.color!;
		const color2 = config.color2 || this.defaultConfig.color2!;
		const intensity = config.intensity ?? 0.45;
		const sizeMult = config.size ?? 1;
		const speedMult = config.speed ?? 0.6;

		for (let i = this.motes.length - 1; i >= 0; i--) {
			const m = this.motes[i];
			m.phase += m.speed * speedMult;
			m.x += m.vx + Math.sin(m.phase * 2.3) * 0.35;
			m.y += m.vy * speedMult;
			m.life += speedMult;
			if (m.life > m.maxLife || m.y < -40 || m.x < -60 || m.x > this.W + 60) {
				this.motes.splice(i, 1);
				if (this.motes.length < 30) this.motes.push(this.make(false));
				continue;
			}

			// smooth fade-in/fade-out over life
			const t = m.life / m.maxLife;
			const fade = Math.sin(t * Math.PI);
			const alpha = fade * 0.7 * Math.min(1, intensity * 1.8);
			const r = m.r * sizeMult;

			const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, r * 5);
			g.addColorStop(0, this.lerpColor(color, '#ffffff', 0.5, alpha));
			g.addColorStop(0.35, this.lerpColor(color, color2, 0.15, alpha * 0.55));
			g.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(m.x, m.y, r * 5, 0, Math.PI * 2);
			ctx.fill();
		}
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
		return `rgba(${rr},${rg},${rb},${alpha.toFixed(3)})`;
	}

	resize(width: number, height: number): void {
		this.W = width;
		this.H = height;
	}

	destroy(): void {
		this.ctx?.clearRect(0, 0, this.W, this.H);
		this.ctx = null;
		this.motes = [];
	}
}
