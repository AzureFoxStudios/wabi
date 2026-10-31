<!--
	One slide as the audience sees it: the designer's pasteboard, the filmstrip thumbnails, the
	show, the room and every preview render this same component (design contract §8.8).

	The slide owns its typography. Its tokens below are theme-independent and are the values the
	exports write (present/files.ts: paper F4F1E9, ink 242836, Arial, title 28pt and text 18pt on a
	10in slide), so a deck looks the same in the designer, on the projector, in the PPTX subset and
	in the audience PDF, whatever the app theme. App heading rules stop at `.audience-slide`
	(surfaces/headings.css). Sizes are container units with no pixel floor: a thumbnail is the
	slide made smaller, not re-laid out. Size the slide from outside (its width; the height follows
	the ratio); it never clamps itself to a parent's height.
-->
<script lang="ts">
	import type { AudienceSlide } from './bridge';
	import SceneView from './SceneView.svelte';
	let { slide, aspect = 16 / 9, blank = false }: { slide: AudienceSlide | null; aspect?: number; blank?: boolean } = $props();
	const safeImage = $derived(slide?.image && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(slide.image) && slide.image.length <= 2 * 1024 * 1024 ? slide.image : null);
	const ratio = $derived(Number.isFinite(aspect) ? Math.max(0.5, Math.min(3, aspect)) : 16 / 9);
</script>

<section
	class="audience-slide"
	class:blank
	class:title-slide={slide?.layout === 'title'}
	class:split={slide?.layout === 'split'}
	class:image-slide={slide?.layout === 'image'}
	class:quote={slide?.layout === 'quote'}
	style:aspect-ratio={ratio}
	aria-label={blank ? 'Screen blanked by presenter' : slide?.title || 'Slide'}
>
	{#if !blank && slide}
		{#if slide.layout === 'canvas' && slide.design}
			<SceneView design={slide.design} />
		{:else}
			<div class="slide-text">
				<h1>{slide.title}</h1>
				{#if slide.body}<p>{slide.body}</p>{/if}
			</div>
			{#if safeImage}<img src={safeImage} alt={slide.title || 'Presentation image'} draggable="false" />{/if}
		{/if}
	{/if}
</section>

<style>
	.audience-slide {
		/* Slide tokens: the exports' values, never the app theme's roles. */
		--slide-paper: #f4f1e9;
		--slide-ink: #242836;
		--slide-blank: #000;
		--slide-face: Arial, 'Helvetica Neue', Helvetica, 'Liberation Sans', sans-serif;
		--slide-title: 3.9cqw;
		--slide-text: 2.5cqw;
		box-sizing: border-box;
		container-type: inline-size;
		position: relative;
		width: 100%;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		justify-content: center;
		padding: 5%;
		background: var(--slide-paper);
		color: var(--slide-ink);
		font-family: var(--slide-face);
		/* App text-size and letter-spacing settings are for the interface, not the slide. */
		letter-spacing: 0;
		text-align: start;
	}
	.audience-slide.blank {
		background: var(--slide-blank);
	}
	.slide-text {
		position: relative;
		z-index: 1;
		min-width: 0;
		max-height: 100%;
		overflow: hidden;
	}
	h1 {
		margin: 0 0 0.55em;
		font: 700 var(--slide-title) / 1.15 var(--slide-face);
		letter-spacing: 0;
		color: inherit;
		overflow-wrap: anywhere;
	}
	p {
		margin: 0;
		font: 400 var(--slide-text) / 1.45 var(--slide-face);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	img {
		display: block;
		min-height: 0;
		max-width: 100%;
		max-height: 70%;
		object-fit: contain;
		margin-top: 3%;
	}
	.title-slide {
		text-align: center;
	}
	.title-slide h1 {
		font-size: calc(var(--slide-title) * 1.35);
	}
	.split {
		flex-direction: row;
		align-items: center;
		gap: 4%;
	}
	.split .slide-text {
		width: 48%;
		flex: 1;
	}
	.split img {
		width: 48%;
		max-height: 100%;
		margin: 0;
	}
	.image-slide {
		padding: 2%;
	}
	.image-slide .slide-text {
		position: absolute;
		inset: auto 4% 3%;
		padding: 1.2%;
		background: color-mix(in srgb, var(--slide-paper) 91%, transparent);
	}
	.image-slide h1 {
		margin: 0;
		font-size: calc(var(--slide-title) * 0.7);
	}
	.image-slide p {
		font-size: calc(var(--slide-text) * 0.7);
	}
	.image-slide img {
		width: 100%;
		height: 100%;
		max-height: 100%;
		margin: 0;
	}
	.quote h1 {
		font-size: calc(var(--slide-title) * 0.46);
	}
	.quote p {
		font-size: calc(var(--slide-text) * 1.3);
		font-style: italic;
	}
</style>
