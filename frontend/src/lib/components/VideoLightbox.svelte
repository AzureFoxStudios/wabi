<script lang="ts">
	import { _ } from '$lib/i18n';

	export let videoUrl: string | null = null;
	export let onClose: () => void = () => {};

	function closeEnlargedVideo() {
		onClose();
	}
</script>

{#if videoUrl}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="video-modal"
		role="button"
		tabindex="0"
		on:click={closeEnlargedVideo}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeEnlargedVideo();
			}
		}}
	>
		<!-- svelte-ignore a11y-media-has-caption -->
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<video
			controls
			autoplay
			class="enlarged-video"
			on:click|stopPropagation
		>
			<source src={videoUrl} />
			{$_('messages.viewer.video_not_supported')}
		</video>
		<button class="close-modal" on:click={closeEnlargedVideo}>X</button>
		<a href={videoUrl} target="_blank" rel="noopener noreferrer" class="open-new-tab">
			{$_('messages.viewer.open_new_tab')}
		</a>
	</div>
{/if}
