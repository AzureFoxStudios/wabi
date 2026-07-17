<script lang="ts">
	import type { Channel, Message } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import ModelViewerLauncher from '../ModelViewerLauncher.svelte';
	import YouTubeWatchEmbed from '../plugins/YouTubeWatchEmbed.svelte';
	import SpotifyControlsEmbed from '../plugins/SpotifyControlsEmbed.svelte';
	import { isSpotifyUrl } from '$lib/spotifyControls';
	import { extractUrls, getMediaType, isYouTubeUrl } from './messageItemUtils';

	export let message: Message;
	export let messageText: string;
	export let currentChannel: string;
	export let channels: Channel[];
	export let displayEnhancementSettingsStore: any;
	export let LinkPreviewComponent: any;
	export let ensureLinkPreviewLoaded: () => void;
	export let onOpenModelInDedicatedTab: (src: string, fileName: string) => void;

	function isYouTubeQueueChannel(channelId: string): boolean {
		const channel = channels.find((channelRecord) => channelRecord.id === channelId);
		return Boolean(channel?.watchQueueEnabled);
	}
</script>

{#if messageText}
	{@const urls = extractUrls(messageText)}
	{#each urls as url, urlIndex}
		{#if isYouTubeUrl(url)}
			{#if LinkPreviewComponent}
				<svelte:component this={LinkPreviewComponent} {url} />
			{:else}
				{@const _linkPreviewRequested = (ensureLinkPreviewLoaded(), true)}
				<a href={url} target="_blank" rel="noopener noreferrer" class="plain-link-fallback">{url}</a>
			{/if}
			{#if isYouTubeQueueChannel(currentChannel) && urlIndex === 0}
				<div class="youtube-queue-section">
					<YouTubeWatchEmbed url={url} channelId={currentChannel} />
				</div>
			{/if}
		{:else if displayEnhancementSettingsStore.spotifyControlsEnabled && isSpotifyUrl(url)}
			<SpotifyControlsEmbed {url} />
		{:else}
			{@const mediaType = getMediaType(url)}
			{#if mediaType === 'image'}
				<img
					src={url}
					alt={$_('messages.media.embedded_image_alt')}
					class="embedded-media embedded-image {message.isSpoiler ? 'spoiler' : ''}"
					data-spoiler={message.isSpoiler ? 'true' : 'false'}
					loading="lazy"
				/>
			{:else if mediaType === 'video'}
				<!-- svelte-ignore a11y-media-has-caption -->
				<video
					controls
					class="embedded-media embedded-video {message.isSpoiler ? 'spoiler' : ''}"
					data-spoiler={message.isSpoiler ? 'true' : 'false'}
				>
					<source src={url} />
					{$_('messages.viewer.video_not_supported')}
				</video>
			{:else if mediaType === 'audio'}
				<!-- svelte-ignore a11y-media-has-caption -->
				<audio controls class="embedded-media embedded-audio">
					<source src={url} />
					{$_('messages.media.audio_not_supported')}
				</audio>
			{:else if mediaType === 'model'}
				<div class="embedded-model-container">
					<ModelViewerLauncher src={url} fileName={url.split('/').pop() || $_('messages.media.model_fallback_name')} height={280} />
					<button
						class="open-viewport-btn"
						on:click={() => onOpenModelInDedicatedTab(url, url.split('/').pop() || $_('messages.media.model_fallback_name'))}
					>
						{$_('messages.media.open_3d_tab')}
					</button>
				</div>
			{:else if LinkPreviewComponent}
				<svelte:component this={LinkPreviewComponent} {url} />
			{:else}
				{@const _linkPreviewRequested = (ensureLinkPreviewLoaded(), true)}
				<a href={url} target="_blank" rel="noopener noreferrer" class="plain-link-fallback">{url}</a>
			{/if}
		{/if}
	{/each}
{/if}
