import type { AmbientEffect, EffectConfig } from '../types';

interface Pulse {
	x: number;
	y: number;
	dx: number;
	dy: number;
}

/**
 * Cyberpunk Grid — adapted from Odysseus' `synapse` pattern.
 * A neon grid with fast light-pulses traveling along the grid lines,
 * plus a faint static grid for the synthwave look.
 */
export class CyberpunkGridEffect implements AmbientEffect {
	id = 'cyberpunk-grid';
	name = 'Cyberpunk Grid';
	description = 'A neon grid lit by light-pulses racing along its lines.';

	private ctx: CanvasRenderingContext2D | null = null;
	private W = 0;
	private H = 0;
	private cols = 0;
	private rows = 0;
	private pulses: Pulse[] = [];

	private readonly GRID = 24; // matches the original synapse grid size
	private readonly MAX_PULSES = 20;
	private readonly SPEED_MIN = 2;
	private readonly SPEED_MAX = 22;
	private readonly TRAIL_LEN = 12;

	defaultConfig: EffectConfig = {
		color: '#06b6d4',
		intensity: 0.35,
		size: 1,
		speed: 1
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		this.resize(window.innerWidth, window.innerHeight);
		this.pulses = [];
	}

	private spawnPulse(): void {
		const speed = this.SPEED_MIN + Math.random() * (this.SPEED_MAX - this.SPEED_MIN);
		if (Math.random() > 0.5) {
			const row = Math.floor(Math.random() * (this.rows + 1));
			this.pulses.push({ x: -this.TRAIL_LEN, y: row * this.GRID, dx: speed, dy: 0 });
		} else {
			const col = Math.floor(Math.random() * (this.cols + 1));
			this.pulses.push({ x: col * this.GRID, y: -this.TRAIL_LEN, dx: 0, dy: speed });
		}
	}

	render(_deltaTime: number, config: EffectConfig): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.W, this.H);

		const color = config.color || this.defaultConfig.color;
		const intensity = config.intensity ?? 0.35;

		// Faint static grid lines.
		ctx.globalAlpha = 0.06 + intensity * 0.12;
		ctx.strokeStyle = color;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let c = 0; c <= this.cols; c++) {
			ctx.moveTo(c * this.GRID, 0);
			ctx.lineTo(c * this.GRID, this.H);
		}
		for (let r = 0; r <= this.rows; r++) {
			ctx.moveTo(0, r * this.GRID);
			ctx.lineTo(this.W, r * this.GRID);
		}
		ctx.stroke();

		// Spawn light-pulses.
		if (this.pulses.length < this.MAX_PULSES && Math.random() < 0.12 * (0.4 + intensity)) {
			this.spawnPulse();
		}

		// Draw pulses as bright dots with a short trailing glow.
		for (let i = this.pulses.length - 1; i >= 0; i--) {
			const p = this.pulses[i];
			p.x += p.dx * (config.speed ?? 1);
			p.y += p.dy * (config.speed ?? 1);
			if (p.x > this.W + this.TRAIL_LEN || p.y > this.H + this.TRAIL_LEN) {
				this.pulses.splice(i, 1);
				continue;
			}
			const tx = p.x - (p.dx > 0 ? this.TRAIL_LEN : 0);
			const ty = p.y - (p.dy > 0 ? this.TRAIL_LEN : 0);
			const grad = ctx.createLinearGradient(tx, ty, p.x, p.y);
			grad.addColorStop(0, 'transparent');
			grad.addColorStop(1, color);
			ctx.strokeStyle = grad;
			ctx.globalAlpha = 0.35;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(tx, ty);
			ctx.lineTo(p.x, p.y);
			ctx.stroke();

			ctx.globalAlpha = 0.55;
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.globalAlpha = 1;
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
		this.cols = Math.ceil(w / this.GRID);
		this.rows = Math.ceil(h / this.GRID);
	}

	destroy(): void {
		this.ctx = null;
		this.pulses = [];
	}
}
