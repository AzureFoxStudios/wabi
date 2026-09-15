<script lang="ts">
	/**
	 * VideoBackground — plays the user's uploaded video loop (mp4/webm/mov)
	 * behind the chat surface. Image backgrounds (incl. animated gif/webp)
	 * keep using the CSS `--background-image-url` path on `.chat-container`;
	 * CSS backgrounds cannot play video, so those need this element.
	 *
	 * ChatBackdropHost shares this same first-child background layer for
	 * generated scenes such as the koi pond. Keeping both mechanisms here
	 * means Chat.svelte does not need to know which kind of backdrop is active.
	 */
	import { themeStore } from '../theme/themeStore';
	import ChatBackdropHost from './chat/ChatBackdropHost.svelte';

	const VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?|$)/i;

	$: bg = $themeStore.customTheme?.backgroundImage;
	$: url = bg?.url ?? '';
	$: isVideo = !!url && VIDEO_EXT_RE.test(url);
	$: opacity = bg?.opacity ?? 0.3;
	$: blur = bg?.blur ?? 0;
</script>

<ChatBackdropHost />

{#if isVideo}
	<video
		class="video-background"
		src={url}
		autoplay
		muted
		loop
		playsinline
		style="opacity: {opacity}; filter: blur({blur}px);"
		aria-hidden="true"
	></video>
{/if}

<style>
	.video-background {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		z-index: 0;
		pointer-events: none;
	}
</style>
