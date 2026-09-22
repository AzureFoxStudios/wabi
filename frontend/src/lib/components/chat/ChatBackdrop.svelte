<script lang="ts">
	import { onMount } from 'svelte';

	export let scene: 'none' | 'koi' = 'none';
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
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(angle);
		ctx.globalAlpha = 0.82;
		ctx.fillStyle = `hsl(${f.hue} 78% 58%)`;
		ctx.beginPath();
		ctx.ellipse(0, 0, f.size * 0.9, f.size * 0.38, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = 'rgba(255,255,255,.72)';
		ctx.beginPath();
		ctx.ellipse(-f.size * 0.12, -f.size * 0.06, f.size * 0.24, f.size * 0.12, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = `hsl(${f.hue + 5} 70% 48%)`;
		ctx.beginPath();
		ctx.moveTo(-f.size * 0.78, 0);
		ctx.lineTo(-f.size * 1.28, -f.size * 0.32);
		ctx.lineTo(-f.size * 1.15, f.size * 0.3);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
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
		if (scene !== 'koi') return;

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
	class:hidden={scene === 'none'}
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
