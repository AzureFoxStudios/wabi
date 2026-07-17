<script lang="ts">
	import { parseMessage } from '$lib/markdown';
	import { _ } from '$lib/i18n';
	import type { Channel, FileAttachment, Message } from '$lib/socket';
	import MessageFileContent from './MessageFileContent.svelte';
	import MessageLinkEmbeds from './MessageLinkEmbeds.svelte';
	import {
		formatDirectionsExpiry,
		getDirectionsMeta,
		isLocalDirectionsMessage,
		parseAlbumAnnouncement,
		parseRoleGateText
	} from './messageItemUtils';
	import { activeServerSpoilAll, activeServerUnspoilAll } from '$lib/serverSettings';

	export let message: Message;
	export let messageText: string;

	// Spoiler layering (most specific wins, except server unspoil overrides all):
	//   1. message.isSpoiler          (manual, per message)
	//   2. channel.forceSpoiler       (per channel)
	//   3. activeServerSpoilAll       (per server, local)
	//   4. spoilerAllMessagesEnabled  (global, device-wide, local)
	// A server "unspoil all" override forces everything visible, even on
	// spoiler channels / individually spoiled messages ("server is king").
	$: effectiveSpoiler = $activeServerUnspoilAll
		? false
		: (message.isSpoiler ||
				(channels.find((ch) => ch.id === currentChannel)?.forceSpoiler ?? false) ||
				$activeServerSpoilAll ||
				$displayEnhancementSettingsStore.spoilerAllMessagesEnabled);
	export let albumAnnouncementUploadName: string | null;
	export let translatedText: string | undefined;
	export let translationLoading: boolean;
	export let gifCaptionStyleClass: string;
	export let displayEnhancementSettingsStore: any;
	export let currentChannel: string;
	export let channels: Channel[];
	export let onOpenMapPanel: (placeId: string, options: any) => void;
	export let onOpenFullMapTab: (placeId: string, options: any) => void;
	export let onOpenPreferredMapSurface: (placeId: string, options: any) => void;
	export let onOpenDirectionsExternal: (url?: string) => void;
	export let onHandleAlbumActivate: (meta: any, hasFiles: boolean) => void;
	export let onTriggerAlbumUpload: (meta: any) => void;
	export let onOpenAlbumPanel: () => void;
	export let onOpenAlbumPreview: (message: Message, fileAttachment: FileAttachment) => void;
	export let onEnlargeImage: (url: string, gallery?: string[]) => void;
	export let onEnlargeVideo: (url: string) => void;
	export let onImageContextMenu: (event: MouseEvent, message: Message) => void;
	export let onDownloadAttachment: (fileUrl: string, fileName: string, encryption?: any) => void;
	export let onOpenBlendImportSettings: (sourcePath: string, fileName: string) => void;
	export let onOpenModelInDedicatedTab: (src: string, fileName: string) => void;
	export let onHandleMarkdownContentClick: (event: MouseEvent) => void;
	export let LinkPreviewComponent: any;
	export let ensureLinkPreviewLoaded: () => void;
	export let onHandleAlbumAnnouncementKeydown: (event: KeyboardEvent, meta: any, hasFiles: boolean) => void;

	function getAlbumAnnouncementStatusLabel(meta: { name: string }, itemCount = 0): string {
		if (albumAnnouncementUploadName === meta.name) return 'Uploading';
		return itemCount > 0 ? `${itemCount} items` : 'Click to upload';
	}

	function getAlbumAnnouncementSupportText(meta: { name: string }, itemCount = 0): string {
		if (albumAnnouncementUploadName === meta.name) return 'Uploading files into this shared album now.';
		if (itemCount > 0) return 'Open Albums to browse this shared album or add more files.';
		return 'Click anywhere on this row to add the first image, or open Albums to manage it.';
	}

	$: albumAnnouncement = parseAlbumAnnouncement(message.text);
</script>

<div class="message-content">
	{#if isLocalDirectionsMessage(message)}
		{@const directions = getDirectionsMeta(message)}
		{#if directions}
			<div class="directions-card">
				<div class="directions-card-head">
					<div class="directions-card-copy">
						<div class="directions-card-kicker">Local Directions</div>
						<div class="directions-card-title">{directions.placeLabel}</div>
					</div>
					<div class="directions-card-expiry">{formatDirectionsExpiry(directions.expiresAt)}</div>
				</div>
				<div class="directions-card-details">
					<div class="directions-detail-row">
						<span class="directions-detail-label">Place</span>
						<span class="directions-detail-value">{directions.placeLabel}</span>
					</div>
					{#if directions.poiLabel}
						<div class="directions-detail-row">
							<span class="directions-detail-label">POI</span>
							<span class="directions-detail-value">{directions.poiLabel}</span>
						</div>
					{/if}
					{#if directions.layerLabel}
						<div class="directions-detail-row">
							<span class="directions-detail-label">Layer</span>
							<span class="directions-detail-value">{directions.layerLabel}</span>
						</div>
					{/if}
					{#if directions.building}
						<div class="directions-detail-row">
							<span class="directions-detail-label">Building</span>
							<span class="directions-detail-value">{directions.building}</span>
						</div>
					{/if}
					{#if directions.floor}
						<div class="directions-detail-row">
							<span class="directions-detail-label">Floor</span>
							<span class="directions-detail-value">{directions.floor}</span>
						</div>
					{/if}
					{#if directions.coordinates}
						<div class="directions-detail-row">
							<span class="directions-detail-label">Coordinates</span>
							<span class="directions-detail-value">{directions.coordinates}</span>
						</div>
					{/if}
					{#if directions.originCoordinates}
						<div class="directions-detail-row">
							<span class="directions-detail-label">From</span>
							<span class="directions-detail-value">{directions.originCoordinates}</span>
						</div>
					{/if}
				</div>
				<div class="directions-card-actions">
					<button
						type="button"
						class="directions-card-btn"
						on:click={() =>
							onOpenMapPanel(directions.placeId, {
								layerId: directions.layerId || null,
								poiId: directions.poiId || null
							})}
					>
						Mini Map
					</button>
					<button
						type="button"
						class="directions-card-btn primary"
						on:click={() =>
							onOpenFullMapTab(directions.placeId, {
								layerId: directions.layerId || null,
								poiId: directions.poiId || null
							})}
					>
						Full Map
					</button>
					<button
						type="button"
						class="directions-card-btn"
						on:click={() =>
							onOpenPreferredMapSurface(directions.placeId, {
								layerId: directions.layerId || null,
								poiId: directions.poiId || null
							})}
					>
						Smart Open
					</button>
					{#if directions.externalUrl}
						<button
							type="button"
							class="directions-card-btn"
							on:click={() => onOpenDirectionsExternal(directions.externalUrl)}
						>
							{directions.externalLabel || 'Open OSM'}
						</button>
					{/if}
				</div>
			</div>
		{/if}
	{:else if albumAnnouncement && (!message.files || message.files.length === 0)}
		<div
			class="album-message-card album-message-card--actionable album-message-card--empty"
			class:is-uploading={albumAnnouncementUploadName === albumAnnouncement.name}
			role="button"
			tabindex="0"
			aria-disabled={albumAnnouncementUploadName === albumAnnouncement.name}
			on:click={() => onHandleAlbumActivate(albumAnnouncement, false)}
			on:keydown={(event) => onHandleAlbumAnnouncementKeydown(event, albumAnnouncement, false)}
		>
			<div class="album-message-main">
				<div class="album-message-head">
					<div class="album-message-copy">
						<div class="album-message-kicker">Shared album</div>
						<div class="album-message-title">{albumAnnouncement.name}</div>
					</div>
					<span class="album-message-count">{getAlbumAnnouncementStatusLabel(albumAnnouncement)}</span>
				</div>
				<div class="album-message-empty">
					{getAlbumAnnouncementSupportText(albumAnnouncement)}
				</div>
			</div>
			<div class="album-message-actions">
				<button
					type="button"
					class="album-message-btn"
					disabled={albumAnnouncementUploadName === albumAnnouncement.name}
					on:click|stopPropagation={() => onTriggerAlbumUpload(albumAnnouncement)}
				>
					{albumAnnouncementUploadName === albumAnnouncement.name ? 'Uploading...' : 'Add Media'}
				</button>
				<button type="button" class="album-message-btn primary" on:click|stopPropagation={onOpenAlbumPanel}>
					Open Albums
				</button>
			</div>
		</div>
	{:else if message.type === 'role_gate'}
		{@const gate = parseRoleGateText(messageText)}
		<div class="role-gate-card">
			<div class="role-gate-label">{$_('messages.role_gate.title')}</div>
			<div class="role-gate-title">{gate.title}</div>
			{#if gate.description}
				<div class="role-gate-description">{gate.description}</div>
			{/if}
			<div class="role-gate-hint">{$_('messages.role_gate.hint')}</div>
		</div>
	{:else if message.type === 'gif' && message.gifUrl}
		<div class="gif-message-block">
			<img src={message.gifUrl} alt="GIF" class="gif {effectiveSpoiler ? 'spoiler' : ''}" data-spoiler={effectiveSpoiler ? 'true' : 'false'} loading="lazy" decoding="async" />
				{#if messageText}
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<div
					class="markdown-content gif-caption {gifCaptionStyleClass}"
					on:click={onHandleMarkdownContentClick}
				>
			{@html parseMessage(messageText, message.entities || [])}
		</div>
			{/if}
		</div>
	{:else if message.type === 'file'}
		<MessageFileContent
			{message}
			forceSpoiler={effectiveSpoiler}
			{albumAnnouncement}
			{albumAnnouncementUploadName}
			{onHandleAlbumActivate}
			{onHandleAlbumAnnouncementKeydown}
			{onTriggerAlbumUpload}
			{onOpenAlbumPanel}
			{onOpenAlbumPreview}
			{onEnlargeImage}
			{onEnlargeVideo}
			{onOpenModelInDedicatedTab}
			{onOpenBlendImportSettings}
			{onDownloadAttachment}
			{onImageContextMenu}
		/>
		{#if !albumAnnouncement && messageText && (message.files ? messageText !== `Shared ${message.files.length} files` : messageText !== `Shared: ${message.fileName}`)}
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="markdown-content" on:click={onHandleMarkdownContentClick}>
				{@html parseMessage(messageText, message.entities || [])}
			</div>
		{/if}
	{:else if message.type === 'emoji' && message.emojiUrl}
		<img src={message.emojiUrl} alt={message.emojiName || 'emoji'} class="emoji-large {effectiveSpoiler ? 'spoiler' : ''}" data-spoiler={effectiveSpoiler ? 'true' : 'false'} loading="lazy" decoding="async" />
	{:else}
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="markdown-content" on:click={onHandleMarkdownContentClick}>
			{@html parseMessage(messageText, message.entities || [])}
		</div>
	{/if}
	{#if translatedText}
		<div class="translated-content" class:loading={translationLoading}>
			<span class="translated-label">{$_('messages.translated_label')}</span>
			<div class="translated-text">{translatedText}</div>
		</div>
	{/if}

	<MessageLinkEmbeds
		{message}
		{messageText}
		{currentChannel}
		{channels}
		{displayEnhancementSettingsStore}
		{LinkPreviewComponent}
		{ensureLinkPreviewLoaded}
		{onOpenModelInDedicatedTab}
	/>
</div>
