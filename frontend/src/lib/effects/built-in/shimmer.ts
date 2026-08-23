import type { AmbientEffect, EffectConfig } from '../types';

interface Facet {
	x: number;
	y: number;
	r: number; // base radius
	rot: number; // facet orientation
	verts: number; // 4 = diamond, 6 = gem
	glintPhase: number;
	glintSpeed: number;
	driftSpeed: number;
	drift: number;
}

/**
 * Shimmer — a field of slow-drifting cut gems under a sweeping glint.
 * Each facet catches a periodic specular highlight (the "pulsing shimmer");
 * a soft diagonal light band sweeps across the whole canvas so clusters
 * light up together, like jewelry turning under a display-case lamp.
 *
 * Sprites are pre-rendered per (verts bucket) and tinted via globalAlpha,
 * keeping per-frame cost flat (no gradient allocation in render()).
 */
export class ShimmerEffect implements AmbientEffect {
	id = 'shimmer';
	name = 'Shimmer';
	description = 'Cut gems drifting slowly while a pulsing glint sweeps across their facets.';
	usesWebGL = false;

	private ctx: CanvasRenderingContext2D | null = null;
	private facets: Facet[] = [];
	private W = 0;
	private H = 0;
	private time = 0;
	// Pre-rendered gem sprites keyed by vertex count
	private sprites = new Map<number, HTMLCanvasElement>();
	private spriteColor = '';
	private spriteColor2 = '';

	defaultConfig: EffectConfig = {
		color: '#7dd8ff',
		color2: '#bfeaff',
		color3: '#0a1424',
		intensity: 0.75,
		size: 1,
		speed: 1,
	};

	init(canvas: HTMLCanvasElement, config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.W = window.innerWidth;
		this.H = window.innerHeight;
		canvas.width = this.W * dpr;
		canvas.height = this.H * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.time = 0;
		this.buildSprites(config.color || this.defaultConfig.color!, config.color2 || this.defaultConfig.color2!);
		this.spawn(Math.floor(Math.min(90, Math.max(28, (this.W * this.H) / 26000))));
	}

	private buildSprites(color: string, color2: string): void {
		if (this.spriteColor === color && this.spriteColor2 === color2 && this.sprites.size > 0) return;
		this.spriteColor = color;
		this.spriteColor2 = color2;
		this.sprites.clear();
		for (const verts of [4, 6]) {
			const size = 64;
			const off = document.createElement('canvas');
			off.width = size;
			off.height = size;
			const c = off.getContext('2d')!;
			const cx = size / 2;
			c.translate(cx, cx);
			// body
			this.traceFacet(c, verts, cx * 0.82, cx * 0.55);
			const grad = c.createLinearGradient(-cx, -cx, cx, cx);
			grad.addColorStop(0, color2);
			grad.addColorStop(0.5, color);
			grad.addColorStop(1, this.shade(color, -0.45));
			c.fillStyle = grad;
			c.fill();
			// table line across the top facets — reads as a cut gem
			c.strokeStyle = 'rgba(255,255,255,0.5)';
			c.lineWidth = 1.5;
			c.beginPath();
			c.moveTo(-cx * 0.34, -cx * 0.16);
			c.lineTo(cx * 0.34, -cx * 0.16);
			c.stroke();
			this.sprites.set(verts, off);
		}
	}

	private traceFacet(c: CanvasRenderingContext2D, verts: number, rx: number, ry: number): void {
		c.beginPath();
		for (let i = 0; i < verts; i++) {
			const a = (i / verts) * Math.PI * 2 - Math.PI / 2;
			const px = Math.cos(a) * rx * (i % 2 === 1 ? 0.62 : 1);
			const py = Math.sin(a) * ry * (i % 2 === 1 ? 0.62 : 1);
			if (i === 0) c.moveTo(px, py);
			else c.lineTo(px, py);
		}
		c.closePath();
	}

	private shade(hex: string, amt: number): string {
		const n = parseInt(hex.slice(1), 16);
		const r = Math.min(255, Math.max(0, ((n >> 16) & 255) + amt * 255));
		const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amt * 255));
		const b = Math.min(255, Math.max(0, (n & 255) + amt * 255));
		return `rgb(${r | 0},${g | 0},${b | 0})`;
	}

	private spawn(count: number): void {
		this.facets = [];
		for (let i = 0; i < count; i++) {
			const f = this.make();
			f.y = Math.random() * this.H;
			f.glintPhase = Math.random() * Math.PI * 2;
			this.facets.push(f);
		}
	}

	private make(): Facet {
		return {
			x: Math.random() * this.W,
			y: -20 - Math.random() * 40,
			r: 6 + Math.random() * 16,
			rot: (Math.random() - 0.5) * 0.9,
			verts: Math.random() < 0.65 ? 4 : 6,
			glintPhase: Math.random() * Math.PI * 2,
			glintSpeed: 0.35 + Math.random() * 0.55,
			driftSpeed: 0.06 + Math.random() * 0.12,
			drift: Math.random() * Math.PI * 2,
		};
	}

	render(deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.W, this.H);

		const dt = Math.min(deltaTime, 100) / 1000;
		this.time += dt;
		const intensity = Math.max(0, Math.min(1, config.intensity ?? 0.75));
		const sizeMult = config.size ?? 1;
		const speedMult = Math.max(0.05, config.speed ?? 1);
		const color = config.color || this.defaultConfig.color!;

		// soft ambient glow so gems sit on something luminous rather than black
		const glow = ctx.createRadialGradient(
			this.W * 0.5, this.H * 0.45, 0,
			this.W * 0.5, this.H * 0.45, Math.max(this.W, this.H) * 0.7
		);
		glow.addColorStop(0, this.rgba(color, 0.05 * intensity));
		glow.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.fillStyle = glow;
		ctx.fillRect(0, 0, this.W, this.H);

		// sweeping diagonal light band — clusters shimmer together as it passes
		const bandT = (this.time * 0.08 * speedMult) % 1.6; // wraps with an off-screen pause
		const bandX = (bandT / 1.6) * (this.W * 1.6) - this.W * 0.3;
		if (bandX > -this.W * 0.5 && bandX < this.W * 1.5) {
			const band = ctx.createLinearGradient(bandX - this.W * 0.22, 0, bandX + this.W * 0.22, this.H);
			band.addColorStop(0, 'rgba(255,255,255,0)');
			band.addColorStop(0.5, `rgba(235,248,255,${0.05 * intensity})`);
			band.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = band;
			ctx.fillRect(0, 0, this.W, this.H);
		}

		for (const f of this.facets) {
			f.glintPhase += f.glintSpeed * speedMult * dt * 2.2;
			f.drift += f.driftSpeed * speedMult * dt;
			f.x += Math.sin(f.drift) * 0.18 * speedMult;
			f.y += 0.05 * speedMult;
			if (f.y > this.H + 30) Object.assign(f, this.make());

			const sprite = this.sprites.get(f.verts);
			if (!sprite) continue;

			// per-facet pulse: sharp specular pop then slow decay
			const wave = Math.sin(f.glintPhase);
			const glint = Math.pow(Math.max(0, wave), 6); // brief bright pop
			const base = 0.16 + 0.10 * intensity;
			const alpha = (base + glint * 0.65 * intensity);
			const scale = f.r * sizeMult / 26;

			ctx.save();
			ctx.translate(f.x, f.y);
			ctx.rotate(f.rot + Math.sin(f.drift) * 0.15);
			ctx.globalAlpha = alpha;
			ctx.drawImage(sprite, -32 * scale, -32 * scale, 64 * scale, 64 * scale);

			// white starburst at glint peak — the "diamond sparkle"
			if (glint > 0.25) {
				ctx.rotate(-f.rot - Math.sin(f.drift) * 0.15); // sparkle stays upright
				const sr = f.r * sizeMult * (1.1 + glint * 0.9);
				ctx.strokeStyle = `rgba(255,255,255,${glint * 0.85 * intensity})`;
				ctx.lineWidth = 1.2;
				ctx.beginPath();
				ctx.moveTo(-sr, 0); ctx.lineTo(sr, 0);
				ctx.moveTo(0, -sr); ctx.lineTo(0, sr);
				ctx.stroke();
			}
			ctx.restore();
		}
		ctx.globalAlpha = 1;
	}

	private rgba(hex: string, a: number): string {
		const n = parseInt(hex.slice(1), 16);
		return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
	}

	resize(w: number, h: number): void {
		this.W = w;
		this.H = h;
		this.spawn(Math.floor(Math.min(90, Math.max(28, (w * h) / 26000))));
	}

	destroy(): void {
		this.ctx?.clearRect(0, 0, this.W, this.H);
		this.ctx = null;
		this.facets = [];
		this.sprites.clear();
		this.time = 0;
	}
}
