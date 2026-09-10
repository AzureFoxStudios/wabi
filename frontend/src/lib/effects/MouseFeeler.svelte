<script lang="ts">
	import { onMount } from 'svelte';

	export let enabled = true;
	export let radius = 190;
	export let intensity = 0.075;
	export let idleDelayMs = 90;
	export let fadeMs = 520;

	let layer: HTMLDivElement;

	onMount(() => {
		if (!enabled) return;

		const finePointer = window.matchMedia('(pointer: fine)');
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		if (!finePointer.matches || reducedMotion.matches) return;

		let frame = 0;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		let pendingX = window.innerWidth / 2;
		let pendingY = window.innerHeight / 2;

		const hide = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
			layer.style.opacity = '0';
		};

		const flush = () => {
			frame = 0;
			layer.style.setProperty('--feeler-x', `${pendingX}px`);
			layer.style.setProperty('--feeler-y', `${pendingY}px`);
			layer.style.opacity = '1';
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;

			pendingX = event.clientX;
			pendingY = event.clientY;

			if (!frame) frame = requestAnimationFrame(flush);
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(hide, idleDelayMs);
		};

		window.addEventListener('pointermove', handlePointerMove, { passive: true });
		window.addEventListener('blur', hide);
		document.documentElement.addEventListener('mouseleave', hide);

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('blur', hide);
			document.documentElement.removeEventListener('mouseleave', hide);
			if (frame) cancelAnimationFrame(frame);
			if (idleTimer) clearTimeout(idleTimer);
		};
	});
</script>

<div
	bind:this={layer}
	class="mouse-feeler"
	aria-hidden="true"
	style={`--feeler-radius: ${radius}px; --feeler-strength: ${intensity}; --feeler-fade: ${fadeMs}ms;`}
>
	<div class="mouse-feeler__glow"></div>
	<div class="mouse-feeler__texture"></div>
</div>

<style>
	.mouse-feeler {
		--feeler-x: 50vw;
		--feeler-y: 50vh;
		position: fixed;
		inset: 0;
		z-index: 10000;
		pointer-events: none;
		opacity: 0;
		contain: strict;
		transition: opacity var(--feeler-fade) ease-out;
		will-change: opacity;
	}

	.mouse-feeler__glow,
	.mouse-feeler__texture {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.mouse-feeler__glow {
		background: radial-gradient(
			circle var(--feeler-radius) at var(--feeler-x) var(--feeler-y),
			rgb(255 255 255 / var(--feeler-strength)) 0%,
			rgb(255 255 255 / calc(var(--feeler-strength) * 0.55)) 35%,
			rgb(255 255 255 / calc(var(--feeler-strength) * 0.16)) 62%,
			transparent 100%
		);
		mix-blend-mode: screen;
	}

	/* Prototype texture: faint outlined triangles revealed only inside the feeler.
	   This can later become a theme-supplied image/pattern without changing the
	   pointer tracking code. */
	.mouse-feeler__texture {
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='52' height='45' viewBox='0 0 52 45'%3E%3Cpath d='M26 4 48 41H4Z' fill='none' stroke='white' stroke-opacity='.24' stroke-width='1'/%3E%3C/svg%3E");
		background-size: 52px 45px;
		background-position: 5px 8px;
		opacity: 0.22;
		mix-blend-mode: screen;
		-webkit-mask-image: radial-gradient(
			circle var(--feeler-radius) at var(--feeler-x) var(--feeler-y),
			#000 0%,
			rgb(0 0 0 / 0.72) 42%,
			transparent 82%
		);
		mask-image: radial-gradient(
			circle var(--feeler-radius) at var(--feeler-x) var(--feeler-y),
			#000 0%,
			rgb(0 0 0 / 0.72) 42%,
			transparent 82%
		);
	}

	@media (prefers-reduced-motion: reduce), (pointer: coarse) {
		.mouse-feeler {
			display: none;
		}
	}
</style>
