import type { AmbientEffect, EffectConfig } from '../types';

const NODES = 260;
const BASE_SPEED = 0.35;
const BASE_WANDER = 0.18;

export class LongcatEffect implements AmbientEffect {
	id = 'longcat';
	name = 'Longcat';
	description = 'A pixelated neon ribbon tail that winds slowly across the screen — playful, soft, and infinite.';
	usesWebGL = false;

	private ctx: CanvasRenderingContext2D | null = null;
	private W = 0;
	private H = 0;
	private nodes: { x: number; y: number; vx: number; vy: number }[] = [];
	private tick = 0;

	defaultConfig: EffectConfig = {
		color: '#ff7ac6',
		color2: '#7af0ff',
		color3: '#1a0f26',
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

		this.nodes = [];
		for (let i = 0; i < NODES; i++) {
			this.nodes.push({
				x: this.W / 2 + Math.cos(i * 0.04) * 120,
				y: this.H / 2 + Math.sin(i * 0.07) * 60 - i * 2.5,
				vx: 0,
				vy: 0,
			});
		}
		this.tick = 0;
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;

		const intensity = Math.min(1, Math.max(0, config.intensity ?? 1));
		const speed = Math.max(0.05, config.speed ?? 1);
		const size = Math.max(0.25, config.size ?? 1);
		const color = config.color || this.defaultConfig.color!;
		const color2 = config.color2 || this.defaultConfig.color2!;
		const color3 = config.color3 || this.defaultConfig.color3!;

		this.tick += BASE_SPEED * speed * 0.1;

		// lead node wanders slowly
		const lead = this.nodes[0];
		const lx = Math.cos(this.tick * 0.7) * (this.W * 0.38);
		const ly = Math.sin(this.tick * 0.5) * (this.H * 0.32) + this.H * 0.15;
		lead.vx += (lx - lead.x) * 0.0025 * speed;
		lead.vy += (ly - lead.y) * 0.0025 * speed;
		lead.vx *= 0.82;
		lead.vy *= 0.82;
		lead.x += lead.vx;
		lead.y += lead.vy;

		// follow each node with a loose spring toward the previous node
		for (let i = 1; i < this.nodes.length; i++) {
			const prev = this.nodes[i - 1];
			const node = this.nodes[i];
			const wander =
				Math.sin(this.tick + i * 0.25) * BASE_WANDER * 24 * intensity +
				Math.cos(this.tick * 0.8 + i * 0.4) * BASE_WANDER * 18 * intensity;
			node.vx += (prev.x - node.x) * 0.22 + wander * 0.05;
			node.vy += (prev.y - node.y) * 0.22 + wander * 0.05;
			node.vx *= 0.72;
			node.vy *= 0.72;
			node.x += node.vx * speed;
			node.y += node.vy * speed;
		}

		// very soft clear so it leaves a dreamy trace
		ctx.fillStyle = `rgba(10, 8, 18, ${0.14 + (1 - intensity) * 0.45})`;
		ctx.fillRect(0, 0, this.W, this.H);

		const baseWidth = Math.max(4, 26 * size);
		const visible = Math.max(40, Math.floor(this.nodes.length * intensity));

		for (let i = 1; i < visible; i++) {
			const curr = this.nodes[i];
			const prev = this.nodes[i - 1];
			const t = i / visible;

			// tapering width
			const width = baseWidth * Math.pow(1 - t, 1.6);
			if (width < 0.6) continue;

			const gradient = ctx.createLinearGradient(prev.x, prev.y, curr.x, curr.y);
			const alpha = 0.08 + (1 - t) * 0.55;
			gradient.addColorStop(0, this.withAlpha(color2, alpha * 0.2));
			gradient.addColorStop(0.5, this.withAlpha(color, alpha));
			gradient.addColorStop(1, this.withAlpha(color3, alpha * 0.2));

			ctx.strokeStyle = gradient;
			ctx.lineWidth = width;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';

			ctx.beginPath();
			ctx.moveTo(prev.x, prev.y);
			ctx.lineTo(curr.x, curr.y);
			ctx.stroke();

			// occasional soft glow nodes
			if (i % 7 === 0 && width > 6) {
				const glow = ctx.createRadialGradient(
					curr.x,
					curr.y,
					0,
					curr.x,
					curr.y,
					Math.max(1, width * 1.8)
				);
				glow.addColorStop(0, this.withAlpha(color, 0.14));
				glow.addColorStop(1, this.withAlpha(color, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(curr.x, curr.y, Math.max(1, width * 1.8), 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	resize(width: number, height: number): void {
		this.W = width;
		this.H = height;
	}

	destroy(): void {
		if (this.ctx && this.W && this.H) {
			this.ctx.clearRect(0, 0, this.W, this.H);
		}
		this.ctx = null;
		this.nodes = [];
	}

	private withAlpha(hex: string, alpha: number): string {
		const clean = hex.replace('#', '');
		const r = parseInt(clean.substring(0, 2), 16);
		const g = parseInt(clean.substring(2, 4), 16);
		const b = parseInt(clean.substring(4, 6), 16);
		if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
			return `rgba(255,122,198,${alpha})`;
		}
		return `rgba(${r},${g},${b},${alpha})`;
	}
}
