<script lang="ts">
	/**
	 * VideoBackground — plays the user's uploaded video loop (mp4/webm/mov)
	 * behind the chat surface. Image backgrounds (incl. animated gif/webp)
	 * keep using the CSS `--background-image-url` path on `.chat-container`;
	 * CSS backgrounds cannot play video, so those need this element.
	 *
	 * Positioned as the first child of `.chat-container` (z-index 0, same
	 * layer as the ambient canvas): paints above the container fill, below
	 * `.messages` / panels which follow it in DOM order.
	 */
	import { themeStore } from '../theme/themeStore';

	const VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?|$)/i;

	$: bg = $themeStore.customTheme?.backgroundImage;
	$: url = bg?.url ?? '';
	$: isVideo = !!url && VIDEO_EXT_RE.test(url);
	$: opacity = bg?.opacity ?? 0.3;
	$: blur = bg?.blur ?? 0;
</script>

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
