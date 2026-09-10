<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import {
		getNextSpriteFrame,
		getSpriteFramePosition,
		normalizeSpriteAnimation
	} from '$lib/spriteAnimation';

	type Props = {
		src: string;
		alt?: string;
		frameCount: number;
		columns?: number;
		fps?: number;
		loop?: boolean;
		play?: boolean;
		width?: number | string;
		height?: number | string;
		class?: string;
	};

	let {
		src,
		alt = 'animated emote',
		frameCount,
		columns,
		fps = 8,
		loop = true,
		play = true,
		width = '100%',
		height = '100%',
		class: className = ''
	}: Props = $props();

	let host = $state<HTMLDivElement | null>(null);
	let frame = $state(0);
	let visible = $state(true);
	let reducedMotion = $state(false);

	const config = $derived(normalizeSpriteAnimation({ frameCount, columns, fps, loop }));
	const position = $derived(getSpriteFramePosition(frame, config));

	const cssWidth = $derived(typeof width === 'number' ? `${width}px` : width);
	const cssHeight = $derived(typeof height === 'number' ? `${height}px` : height);

	onMount(() => {
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		const syncMotion = () => (reducedMotion = media.matches);
		syncMotion();
		media.addEventListener('change', syncMotion);

		let observer: IntersectionObserver | null = null;
		if ('IntersectionObserver' in window && host) {
			observer = new IntersectionObserver(([entry]) => {
				visible = entry?.isIntersecting ?? true;
			});
			observer.observe(host);
		}

		return () => {
			media.removeEventListener('change', syncMotion);
			observer?.disconnect();
		};
	});

	$effect(() => {
		if (!browser || !play || !visible || reducedMotion || config.frameCount <= 1) {
			frame = 0;
			return;
		}

		const intervalMs = 1000 / config.fps;
		const timer = window.setInterval(() => {
			frame = getNextSpriteFrame(frame, config);
		}, intervalMs);

		return () => window.clearInterval(timer);
	});
</script>

<div
	bind:this={host}
	class={`sprite-sheet-emote ${className}`}
	role="img"
	aria-label={alt}
	style:width={cssWidth}
	style:height={cssHeight}
	style:background-image={`url("${src.replaceAll('"', '%22')}")`}
	style:background-size={`${position.backgroundSizeX}% ${position.backgroundSizeY}%`}
	style:background-position={`${position.backgroundPositionX}% ${position.backgroundPositionY}%`}
></div>

<style>
	.sprite-sheet-emote {
		display: inline-block;
		background-repeat: no-repeat;
		image-rendering: auto;
		flex: none;
	}
</style>
