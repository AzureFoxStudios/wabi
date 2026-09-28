import type { AmbientEffect, EffectConfig } from '../types';

interface Star {
	x: number;
	y: number;
	phase: number;
	speed: number;
	size: number;
}

export class ConstellationsEffect implements AmbientEffect {
	id = 'constellations';
	name = 'Constellations';
	description = 'A drifting star field with shimmering constellation links between nearby stars.';

	private ctx: CanvasRenderingContext2D | null = null;
	private stars: Star[] = [];

	defaultConfig: EffectConfig = {
		color: '#a855f7',
		intensity: 0.3,
		size: 1,
		speed: 1,
	};

	init(canvas: HTMLCanvasElement, _config: EffectConfig): void {
		this.ctx = canvas.getContext('2d');
		// Use CSS dimensions (clientWidth/Height) so star density is stable
		// across DPR; resize() will re-seed with the same coordinate space.
		const w = canvas.clientWidth || canvas.width;
		const h = canvas.clientHeight || canvas.height;
		this.generateStars(w, h);
	}

	private generateStars(w: number, h: number): void {
		// Size is CSS pixels (effect.resize passes client dims). Cap the star
		// count so a large display cannot explode the O(n²) link pass into
		// tens of thousands of pair checks per frame.
		const area = w * h;
		const count = Math.min(160, Math.max(40, Math.floor(area / 6000)));
		this.stars = Array.from({ length: count }, () => ({
			x: Math.random() * w,
			y: Math.random() * h,
			phase: Math.random() * Math.PI * 2,
			speed: 0.2 + Math.random() * 0.5,
			size: 1 + Math.random() * 2.5,
		}));
	}

	render(_deltaTime: number, config: EffectConfig): void {
		if (!this.ctx) return;
		const ctx = this.ctx;
		// Match the CSS-pixel coordinate space used by resize()/init().
		const w = ctx.canvas.clientWidth || ctx.canvas.width;
		const h = ctx.canvas.clientHeight || ctx.canvas.height;

		ctx.clearRect(0, 0, w, h);

		const alpha = config.intensity;
		if (alpha <= 0) return;

		const time = performance.now() / 1000;

		for (const star of this.stars) {
			const s = star.speed * config.speed;
			star.x += Math.sin(time * s + star.phase) * 0.15 * config.speed;
			star.y += Math.cos(time * s * 0.7 + star.phase) * 0.1 * config.speed;
			if (star.x < -10) star.x = w + 10;
			if (star.x > w + 10) star.x = -10;
			if (star.y < -10) star.y = h + 10;
			if (star.y > h + 10) star.y = -10;
		}

		const connectionDist = 120 * config.size;
		const connectionDistSq = connectionDist * connectionDist;
		const lineAlpha = alpha * 0.4;
		ctx.strokeStyle = config.color;

		for (let i = 0; i < this.stars.length; i++) {
			const a = this.stars[i];
			for (let j = i + 1; j < this.stars.length; j++) {
				const b = this.stars[j];
				const dx = a.x - b.x;
				const dy = a.y - b.y;
				const distSq = dx * dx + dy * dy;
				if (distSq < connectionDistSq) {
					const dist = Math.sqrt(distSq);
					// signature: links shimmer — each line's opacity breathes with
					// a per-link phase so the constellation flickers like it's
					// alive instead of holding a static web.
					const linkPhase = Math.sin(time * 0.7 + (i * 13 + j * 7) * 0.37);
					const linkAlpha = (1 - dist / connectionDist) * lineAlpha * (0.55 + 0.45 * linkPhase);
					if (linkAlpha <= 0.01) continue;
					ctx.globalAlpha = linkAlpha;
					ctx.beginPath();
					ctx.moveTo(a.x, a.y);
					ctx.lineTo(b.x, b.y);
					ctx.stroke();
				}
			}
		}

		const starAlpha = alpha * 0.9;
		for (const star of this.stars) {
			const pulse = 0.6 + 0.4 * Math.sin(time * star.speed * config.speed + star.phase);
			ctx.globalAlpha = starAlpha * pulse;
			ctx.fillStyle = '#ffffff';
			ctx.beginPath();
			ctx.arc(star.x, star.y, star.size * config.size, 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.globalAlpha = 1;
		// Caller applies ctx.scale(dpr, dpr); clear in CSS pixels to cover
		// the full backing store without using device-pixel dims above.
		// (clearRect already ran above with CSS dims after the dpr scale.)
	}

	resize(w: number, h: number): void {
		this.generateStars(w, h);
	}

	destroy(): void {
		this.ctx = null;
		this.stars = [];
	}
}
