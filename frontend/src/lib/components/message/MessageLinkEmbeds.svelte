<script lang="ts">
	import type { Channel, Message } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import ModelViewerLauncher from '../ModelViewerLauncher.svelte';
	import YouTubeWatchEmbed from '../plugins/YouTubeWatchEmbed.svelte';
	import SpotifyControlsEmbed from '../plugins/SpotifyControlsEmbed.svelte';
	import RemoteMediaGate from './RemoteMediaGate.svelte';
	import { LINK_PREVIEW_OFF_HINT, keepReasonFor } from '$lib/privacy/contentEgress';
	import { e2eeStatusRevision, roomContentKeepReason } from '$lib/dm/dmE2eeState';
	import { needsLinkPreviewComponent, planLinkEmbeds, type LinkEmbedContext } from './linkEmbedPolicy';

	export let message: Message;
	export let messageText: string;
	export let currentChannel: string;
	export let channels: Channel[];
	export let displayEnhancementSettingsStore: any;
	export let LinkPreviewComponent: any;
	export let ensureLinkPreviewLoaded: () => void;
	export let onOpenModelInDedicatedTab: (src: string, fileName: string) => void;

	// Kept content (privacy/contentEgress.ts), derived here from the message and the room so no
	// parent can switch it off: no server-side link preview, and media from other hosts waits for
	// a click (linkEmbedPolicy.ts).
	$: contentOnDevice =
		keepReasonFor(
			message,
			roomContentKeepReason(currentChannel, channels.find((channel) => channel.id === currentChannel)?.type ?? null, $e2eeStatusRevision)
		) !== null;

	function isYouTubeQueueChannel(channelId: string, list: Channel[]): boolean {
		const channel = list.find((channelRecord) => channelRecord.id === channelId);
		return Boolean(channel?.watchQueueEnabled);
	}

	$: embedContext = {
		keepOnDevice: contentOnDevice,
		spotifyControlsEnabled: Boolean(displayEnhancementSettingsStore?.spotifyControlsEnabled),
		youtubeQueueChannel: isYouTubeQueueChannel(currentChannel, channels)
	} satisfies LinkEmbedContext;
	$: plans = planLinkEmbeds(messageText, embedContext);
	// One note per message, not per link; the links themselves are already in the message text.
	$: previewOffShown = contentOnDevice && plans.length > 0;

	// Load the preview card component as soon as the message has a link that will use it. This must
	// live in script: a side effect inside a template {@const} is dropped by the production
	// compiler, which left every link as a bare URL on built (non-dev) deployments.
	$: if (messageText && !LinkPreviewComponent && needsLinkPreviewComponent(messageText, embedContext)) ensureLinkPreviewLoaded();

	function modelName(url: string): string {
		return url.split('/').pop() || $_('messages.media.model_fallback_name');
	}
</script>

{#each plans as plan}
	{@const url = plan.url}
	{#if plan.preview}
		{#if LinkPreviewComponent}
			<svelte:component this={LinkPreviewComponent} {url} />
		{:else}
			<a href={url} target="_blank" rel="noopener noreferrer" class="plain-link-fallback">{url}</a>
		{/if}
	{/if}
	{#if plan.direct}
		{#if plan.directNeedsClick}
			<RemoteMediaGate {url} showLink={false} showHint={false}>
				{#if plan.direct === 'youtube-queue'}
					<div class="youtube-queue-section"><YouTubeWatchEmbed url={url} channelId={currentChannel} /></div>
				{:else if plan.direct === 'spotify'}
					<SpotifyControlsEmbed {url} noReferrer />
				{:else if plan.direct === 'image'}
					<img
						src={url}
						alt={$_('messages.media.embedded_image_alt')}
						class="embedded-media embedded-image {message.isSpoiler ? 'spoiler' : ''}"
						data-spoiler={message.isSpoiler ? 'true' : 'false'}
						referrerpolicy="no-referrer"
					/>
				{:else if plan.direct === 'video'}
					<!-- svelte-ignore a11y-media-has-caption -->
					<video controls class="embedded-media embedded-video {message.isSpoiler ? 'spoiler' : ''}" data-spoiler={message.isSpoiler ? 'true' : 'false'}>
						<source src={url} />
						{$_('messages.viewer.video_not_supported')}
					</video>
				{:else if plan.direct === 'audio'}
					<!-- svelte-ignore a11y-media-has-caption -->
					<audio controls class="embedded-media embedded-audio">
						<source src={url} />
						{$_('messages.media.audio_not_supported')}
					</audio>
				{:else if plan.direct === 'model'}
					<div class="embedded-model-container">
						<ModelViewerLauncher src={url} fileName={modelName(url)} height={280} />
					</div>
				{/if}
			</RemoteMediaGate>
		{:else if plan.direct === 'youtube-queue'}
			<div class="youtube-queue-section">
				<YouTubeWatchEmbed url={url} channelId={currentChannel} />
			</div>
		{:else if plan.direct === 'spotify'}
			<SpotifyControlsEmbed {url} />
		{:else if plan.direct === 'image'}
			<img
				src={url}
				alt={$_('messages.media.embedded_image_alt')}
				class="embedded-media embedded-image {message.isSpoiler ? 'spoiler' : ''}"
				data-spoiler={message.isSpoiler ? 'true' : 'false'}
				loading="lazy"
			/>
		{:else if plan.direct === 'video'}
			<!-- svelte-ignore a11y-media-has-caption -->
			<video
				controls
				class="embedded-media embedded-video {message.isSpoiler ? 'spoiler' : ''}"
				data-spoiler={message.isSpoiler ? 'true' : 'false'}
			>
				<source src={url} />
				{$_('messages.viewer.video_not_supported')}
			</video>
		{:else if plan.direct === 'audio'}
			<!-- svelte-ignore a11y-media-has-caption -->
			<audio controls class="embedded-media embedded-audio">
				<source src={url} />
				{$_('messages.media.audio_not_supported')}
			</audio>
		{:else if plan.direct === 'model'}
			<div class="embedded-model-container">
				<ModelViewerLauncher src={url} fileName={modelName(url)} height={280} />
				<button
					class="open-viewport-btn"
					on:click={() => onOpenModelInDedicatedTab(url, modelName(url))}
				>
					{$_('messages.media.open_3d_tab')}
				</button>
			</div>
		{/if}
	{/if}
{/each}
{#if previewOffShown}
	<p class="link-preview-off">{LINK_PREVIEW_OFF_HINT}</p>
{/if}

<style>
	.link-preview-off {
		margin: 2px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
</style>
