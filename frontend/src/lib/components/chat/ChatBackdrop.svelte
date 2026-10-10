<script lang="ts">
	import { onMount } from 'svelte';

	import type { ChatBackdropScene } from '$lib/theme/chatBackdrop';

	export let scene: ChatBackdropScene = 'none';
	export let motion = 0.65;
	export let dim = 0.16;
	export let frost = 0.32;

	let canvas: HTMLCanvasElement;
	let frame = 0;
	let mounted = false;
	let reducedMotion = false;

	type Fish = {
		x: number;
		y: number;
		speed: number;
		phase: number;
		size: number;
		turn: number;
		hue: number;
	};

	const fish: Fish[] = Array.from({ length: 9 }, (_, index) => ({
		x: Math.random(),
		y: Math.random(),
		speed: 0.000025 + Math.random() * 0.000035,
		phase: Math.random() * Math.PI * 2,
		size: 12 + Math.random() * 18,
		turn: (Math.random() - 0.5) * 0.0004,
		hue: index % 3 === 0 ? 18 : index % 3 === 1 ? 28 : 8
	}));

	function resize(ctx: CanvasRenderingContext2D) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const { clientWidth, clientHeight } = canvas;
		const width = Math.max(1, Math.floor(clientWidth * dpr));
		const height = Math.max(1, Math.floor(clientHeight * dpr));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
	}

	function drawFish(ctx: CanvasRenderingContext2D, f: Fish, t: number, w: number, h: number) {
		const sway = Math.sin(t * 0.0012 + f.phase) * 0.006;
		const dx = Math.cos(f.phase) * f.speed * motion + sway * 0.00015;
		const dy = Math.sin(f.phase) * f.speed * motion + Math.cos(t * 0.0009 + f.phase) * 0.00001;
		f.x += dx;
		f.y += dy;
		f.phase += f.turn * motion;
		if (f.x < -0.08) f.x = 1.08;
		if (f.x > 1.08) f.x = -0.08;
		if (f.y < -0.08) f.y = 1.08;
		if (f.y > 1.08) f.y = -0.08;

		const x = f.x * w;
		const y = f.y * h;
		const angle = Math.atan2(dy, dx || 0.00001);
		const s = f.size;
		const wag = Math.sin(t * 0.004 * (0.6 + motion) + f.phase * 3) * s * 0.28;
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(angle);
		// soft shadow on the pond floor
		ctx.globalAlpha = 0.18;
		ctx.fillStyle = '#000';
		ctx.beginPath();
		ctx.ellipse(s * 0.2, s * 0.5, s * 1.2, s * 0.32, 0, 0, Math.PI * 2);
		ctx.fill();
		// tail and body as one tapered, swaying shape
		ctx.globalAlpha = 0.9;
		const body = ctx.createLinearGradient(-s * 1.4, 0, s, 0);
		body.addColorStop(0, `hsl(${f.hue} 85% 52% / .0)`);
		body.addColorStop(0.2, `hsl(${f.hue} 85% 52%)`);
		body.addColorStop(1, `hsl(${f.hue + 6} 80% 62%)`);
		ctx.fillStyle = body;
		ctx.beginPath();
		ctx.moveTo(s * 0.95, 0);
		ctx.bezierCurveTo(s * 0.7, -s * 0.46, -s * 0.3, -s * 0.42, -s * 0.8, wag * 0.4);
		ctx.bezierCurveTo(-s * 1.2, wag * 0.9 - s * 0.34, -s * 1.5, wag + s * 0.1, -s * 1.7, wag * 1.2);
		ctx.bezierCurveTo(-s * 1.4, wag * 1.0 + s * 0.4, -s * 1.1, wag * 0.8, -s * 0.8, wag * 0.4);
		ctx.bezierCurveTo(-s * 0.3, s * 0.42, s * 0.7, s * 0.46, s * 0.95, 0);
		ctx.fill();
		// pale back patch
		ctx.globalAlpha = 0.7;
		ctx.fillStyle = 'rgba(255,248,236,.85)';
		ctx.beginPath();
		ctx.ellipse(-s * 0.05, -s * 0.04, s * 0.34, s * 0.15, 0.1, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	/** Theme colours for the abstract scenes, read from the role tokens so every theme paints its own. */
	function palette() {
		const css = getComputedStyle(canvas);
		const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
		return { accent: read('--w-accent', '#d6ad5f'), seal: read('--w-seal', '#e0553f'), bg: read('--w-bg', '#101315'), sink: read('--w-sink', '#0a0c0d'), text: read('--w-text', '#e8e7e0') };
	}

	function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		g.addColorStop(0, color);
		g.addColorStop(1, 'transparent');
		ctx.globalAlpha = alpha;
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.globalAlpha = 1;
	}

	// Ink: slow clouds of the theme's two accents drifting through dark wash, like ink in water.
	function drawInk(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
		const c = palette();
		ctx.fillStyle = c.sink;
		ctx.fillRect(0, 0, w, h);
		const clouds = [
			{ x: 0.2, y: 0.3, r: 0.55, col: c.accent, a: 0.34, sx: 0.00007, sy: 0.00005, p: 0 },
			{ x: 0.78, y: 0.2, r: 0.45, col: c.seal, a: 0.26, sx: 0.00006, sy: 0.00008, p: 2 },
			{ x: 0.55, y: 0.78, r: 0.6, col: c.accent, a: 0.2, sx: 0.00005, sy: 0.00006, p: 4 },
			{ x: 0.1, y: 0.85, r: 0.4, col: c.seal, a: 0.16, sx: 0.00008, sy: 0.00004, p: 1 }
		];
		for (const cloud of clouds) {
			const m = (0.4 + motion) * t;
			blob(ctx, (cloud.x + Math.sin(m * cloud.sx * 6 + cloud.p) * 0.12) * w, (cloud.y + Math.cos(m * cloud.sy * 6 + cloud.p) * 0.12) * h, cloud.r * Math.max(w, h), cloud.col, cloud.a);
		}
	}

	// Dusk: a low sun glow behind banded layers, drifting a little.
	function drawDusk(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
		const c = palette();
		const sky = ctx.createLinearGradient(0, 0, 0, h);
		sky.addColorStop(0, c.sink);
		sky.addColorStop(0.7, c.bg);
		sky.addColorStop(1, c.seal);
		ctx.fillStyle = sky;
		ctx.fillRect(0, 0, w, h);
		const drift = Math.sin(t * 0.00005 * (0.4 + motion)) * w * 0.08;
		blob(ctx, w * 0.5 + drift, h * 1.02, Math.max(w, h) * 0.75, c.accent, 0.55);
		for (let i = 0; i < 4; i += 1) {
			const y = h * (0.62 + i * 0.09);
			ctx.globalAlpha = 0.1 + i * 0.05;
			ctx.fillStyle = c.sink;
			ctx.beginPath();
			ctx.moveTo(0, h);
			for (let x = 0; x <= w; x += 24) ctx.lineTo(x, y + Math.sin(x * 0.004 + i * 2 + t * 0.00004 * (0.4 + motion)) * (10 + i * 6));
			ctx.lineTo(w, h);
			ctx.closePath();
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	}

	type Mote = { x: number; y: number; vx: number; vy: number; r: number; p: number };
	const motes: Mote[] = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.00004, vy: -Math.random() * 0.00003, r: 1 + Math.random() * 2.2, p: Math.random() * 6.3 }));

	// Fireflies: warm motes rising and blinking over a dark field.
	function drawFireflies(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
		const c = palette();
		const g = ctx.createLinearGradient(0, 0, 0, h);
		g.addColorStop(0, c.sink);
		g.addColorStop(1, c.bg);
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);
		for (const m of motes) {
			m.x += m.vx * (0.4 + motion) * 16;
			m.y += m.vy * (0.4 + motion) * 16;
			if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
			if (m.x < -0.05) m.x = 1.05;
			if (m.x > 1.05) m.x = -0.05;
			const blink = 0.35 + 0.65 * Math.max(0, Math.sin(t * 0.0016 + m.p));
			blob(ctx, m.x * w, m.y * h, m.r * 9, c.accent, 0.5 * blink);
			ctx.globalAlpha = 0.9 * blink;
			ctx.fillStyle = c.text;
			ctx.beginPath();
			ctx.arc(m.x * w, m.y * h, m.r * 0.5, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;
		}
	}

	function draw(t = 0) {
		if (!mounted || !canvas) return;
		// Pause the rAF chain while the document is hidden — koi scenery has
		// no business software-rendering on an invisible surface.
		if (document.hidden) {
			frame = 0;
			return;
		}
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		resize(ctx);
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		ctx.clearRect(0, 0, w, h);
		if (scene === 'ink') drawInk(ctx, reducedMotion ? 0 : t, w, h);
		else if (scene === 'dusk') drawDusk(ctx, reducedMotion ? 0 : t, w, h);
		else if (scene === 'fireflies') drawFireflies(ctx, reducedMotion ? 0 : t, w, h);
		if (scene !== 'koi') {
			if (!reducedMotion && scene !== 'none' && scene !== 'image') frame = requestAnimationFrame(draw);
			return;
		}

		const pond = ctx.createLinearGradient(0, 0, 0, h);
		pond.addColorStop(0, '#153f46');
		pond.addColorStop(0.55, '#0f343b');
		pond.addColorStop(1, '#0a272f');
		ctx.fillStyle = pond;
		ctx.fillRect(0, 0, w, h);

		for (let i = 0; i < 5; i += 1) {
			const rx = ((i * 0.23 + 0.12) % 1) * w;
			const ry = ((i * 0.31 + 0.18) % 1) * h;
			const radius = 44 + i * 8;
			ctx.strokeStyle = 'rgba(190,235,228,.06)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(rx, ry, radius + Math.sin(t * 0.0006 + i) * 8, 0, Math.PI * 2);
			ctx.stroke();
		}

		fish.forEach((item) => drawFish(ctx, item, reducedMotion ? 0 : t, w, h));
		if (!reducedMotion) frame = requestAnimationFrame(draw);
	}

	function restart() {
		if (!mounted) return;
		cancelAnimationFrame(frame);
		frame = 0;
		draw(performance.now());
	}

	$: scene, motion, restart();

	onMount(() => {
		mounted = true;
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		const syncMotion = () => {
			reducedMotion = media.matches;
			restart();
		};
		syncMotion();
		media.addEventListener?.('change', syncMotion);
		const observer = new ResizeObserver(restart);
		observer.observe(canvas);
		const onVisibility = () => {
			if (document.hidden) {
				cancelAnimationFrame(frame);
				frame = 0;
			} else {
				restart();
			}
		};
		document.addEventListener('visibilitychange', onVisibility);
		restart();
		return () => {
			mounted = false;
			cancelAnimationFrame(frame);
			observer.disconnect();
			media.removeEventListener?.('change', syncMotion);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<div
	class="chat-backdrop"
	class:hidden={scene === 'none' || scene === 'image'}
	aria-hidden="true"
	style={`--chat-backdrop-dim:${dim};--chat-backdrop-frost:${frost};`}
>
	<canvas bind:this={canvas} class="chat-backdrop-canvas"></canvas>
	<div class="chat-backdrop-wash"></div>
</div>

<style>
	.chat-backdrop {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.chat-backdrop.hidden {
		display: none;
	}

	.chat-backdrop-canvas,
	.chat-backdrop-wash {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.chat-backdrop-wash {
		background:
			linear-gradient(rgba(5, 10, 14, var(--chat-backdrop-dim, .16)), rgba(5, 10, 14, var(--chat-backdrop-dim, .16))),
			rgba(var(--surface-base-rgb, 15, 23, 42), var(--chat-backdrop-frost, .32));
		backdrop-filter: blur(calc(var(--chat-backdrop-frost, .32) * 14px)) saturate(1.08);
		-webkit-backdrop-filter: blur(calc(var(--chat-backdrop-frost, .32) * 14px)) saturate(1.08);
	}

	@media (prefers-reduced-motion: reduce) {
		.chat-backdrop-canvas { opacity: .88; }
	}
</style>
