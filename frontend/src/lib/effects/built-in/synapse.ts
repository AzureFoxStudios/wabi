import type { AmbientEffect, EffectConfig } from '../types';

interface SynapseNode {
	x: number;
	y: number;
	phase: number;
	pulseSpeed: number;
}

interface SynapseLine {
	from: number;
	to: number;
}

export class SynapseEffect implements AmbientEffect {
	id = 'synapse';
	name = 'Synapse';
	description = 'A grid of pulsing nodes connected by signal lines.';

	private ctx: CanvasRenderingContext2D | null = null;
	private nodes: SynapseNode[] = [];
	private lines: SynapseLine[] = [];
	private cols = 6;
	private rows = 4;

	defaultConfig: EffectConfig = {
		color: '#5c7cff',
		intensity: 0.3,
		size: 1,
		speed: 1,
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		this.buildGrid(canvas.width, canvas.height);
	}

	private buildGrid(w: number, h: number): void {
		this.cols = Math.max(4, Math.floor(w / 140));
		this.rows = Math.max(3, Math.floor(h / 140));

		const gapX = w / (this.cols + 1);
		const gapY = h / (this.rows + 1);

		this.nodes = [];
		this.lines = [];

		for (let row = 0; row < this.rows; row++) {
			for (let col = 0; col < this.cols; col++) {
				this.nodes.push({
					x: gapX * (col + 1) + (Math.random() - 0.5) * gapX * 0.15,
					y: gapY * (row + 1) + (Math.random() - 0.5) * gapY * 0.15,
					phase: Math.random() * Math.PI * 2,
					pulseSpeed: 0.5 + Math.random() * 1.5,
				});
			}
		}

		for (let row = 0; row < this.rows; row++) {
			for (let col = 0; col < this.cols; col++) {
				const idx = row * this.cols + col;
				if (col + 1 < this.cols) this.lines.push({ from: idx, to: idx + 1 });
				if (row + 1 < this.rows) this.lines.push({ from: idx, to: idx + this.cols });
			}
		}
	}

	render(_deltaTime: number, config: EffectConfig): void {
		if (!this.ctx) return;
		const ctx = this.ctx;
		const w = ctx.canvas.width;
		const h = ctx.canvas.height;

		ctx.clearRect(0, 0, w, h);

		const alpha = config.intensity;
		if (alpha <= 0) return;

		const time = performance.now() / 1000;

		// Draw lines
		const lineAlpha = alpha * 0.5;
		for (const line of this.lines) {
			const from = this.nodes[line.from];
			const to = this.nodes[line.to];
			const fromPulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * from.pulseSpeed * config.speed + from.phase));
			const toPulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * to.pulseSpeed * config.speed + to.phase));
			const avgPulse = (fromPulse + toPulse) / 2;

			ctx.globalAlpha = lineAlpha * avgPulse;
			ctx.strokeStyle = config.color;
			ctx.lineWidth = 1 * config.size;
			ctx.beginPath();
			ctx.moveTo(from.x, from.y);
			ctx.lineTo(to.x, to.y);
			ctx.stroke();
		}

		// Draw nodes
		const nodeSize = (3 * config.size);
		const glowRadius = nodeSize * 4;
		for (const node of this.nodes) {
			const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * node.pulseSpeed * config.speed + node.phase));

			ctx.globalAlpha = alpha * pulse * 0.3;
			ctx.fillStyle = config.color;
			ctx.beginPath();
			ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
			ctx.fill();

			ctx.globalAlpha = alpha * (0.3 + 0.7 * pulse);
			ctx.fillStyle = '#ffffff';
			ctx.beginPath();
			ctx.arc(node.x, node.y, nodeSize, 0, Math.PI * 2);
			ctx.fill();

			ctx.globalAlpha = alpha * (0.5 + 0.5 * pulse);
			ctx.fillStyle = config.color;
			ctx.beginPath();
			ctx.arc(node.x, node.y, nodeSize * 0.6, 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.globalAlpha = 1;
	}

	resize(w: number, h: number): void {
		this.buildGrid(w, h);
	}

	destroy(): void {
		this.ctx = null;
		this.nodes = [];
		this.lines = [];
	}
}
