<script lang="ts">
	import { profileMotionAllowed } from '$lib/profileAppearance';
	let { src, alt = '', class: className = '', style = '', decorative = false }: {
		src: string; alt?: string; class?: string; style?: string; decorative?: boolean;
	} = $props();
	let canvas = $state<HTMLCanvasElement | null>(null);
	let stillReady = $state(false);
	let failed = $state(false);
	// A canvas keeps one decoded frame still. CSS cannot pause GIF/WebP playback.
	$effect(() => {
		const target = canvas;
		if ($profileMotionAllowed || !target || !src) return;
		stillReady = false; failed = false;
		let cancelled = false;
		const image = new Image();
		image.onload = () => {
			if (cancelled) return;
			const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
			target.width = Math.max(1, Math.round(image.naturalWidth * scale));
			target.height = Math.max(1, Math.round(image.naturalHeight * scale));
			const context = target.getContext('2d');
			if (!context) { failed = true; return; }
			context.drawImage(image, 0, 0, target.width, target.height);
			stillReady = true;
		};
		image.onerror = () => { if (!cancelled) failed = true; };
		image.src = src;
		return () => { cancelled = true; image.onload = null; image.onerror = null; image.src = ''; };
	});
</script>

{#if $profileMotionAllowed}
	<img {src} alt={decorative ? '' : alt} class={className} {style} aria-hidden={decorative ? 'true' : undefined} />
{:else}
	<canvas bind:this={canvas} class={className} {style} class:still-pending={!stillReady} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : alt} aria-hidden={decorative ? 'true' : undefined}></canvas>
	{#if failed && !decorative}<span class="media-unavailable">{alt || 'Image'} unavailable</span>{/if}
{/if}

<style>
	.still-pending { background: var(--surface-raised); }
	.media-unavailable { font-size: 0.75rem; color: var(--text-muted); }
</style>
