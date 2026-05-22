<script lang="ts">
	import { currentUser, users } from '$lib/socket';
	import { manualCashOpen, paymentSheetOpen, paymentSheetOpenSeed } from '$lib/payments/dmPayments';
	import { parseMessage } from '$lib/markdown';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import type { Channel, Message, User } from '$lib/socket';
	import GroupAvatar from '../GroupAvatar.svelte';
	import NotesWorkspace from '../NotesWorkspace.svelte';
	import ManualCashModal from '$lib/payments/ManualCashModal.svelte';
	import PaymentSheet from '$lib/payments/PaymentSheet.svelte';

	export let channelId: string;
	export let otherUser: User;
	export let channel: Channel | undefined;
	export let isGroup: boolean;
	export let messages: Message[];
	export let dmNotesStorageKey: string;
	export let dmNotesTitle: string;
	export let lineDmAddonEnabled: boolean;
	export let lineDmPreset: string;
	export let lineDmProfile: any;
	export let lineDmWallpaperUrl: string;
	export let selectedRetentionValue: string | number;
	export let MESSAGE_RETENTION_PRESETS: readonly string[];
	export let MESSAGE_RETENTION_LABELS: Record<string, string>;
	export let paymentButtonEnabled: boolean;
	export let paymentTargetLabel: string;
	export let mentionSuggestions: any[];
	export let mentionSelectedIndex: number;
	export let showMentionSuggestions: boolean;
	export let placeholderText: string;
	export let dmInputMaxLength: number;
	export let dmSpellcheckEnabled: boolean;
	export let dmCharCounterEnabled: boolean;
	export let dmCharCounterVisible: boolean;
	export let dmCharCounterWarn: boolean;
	export let dmCharCount: number;
	export let unicodeEmojisEnabled: boolean;
	export let dmUnicodePreviewTokens: number;
	export let dmUnicodePreview: string;
	export let messageInput: string;
	export let messagesContainer: HTMLDivElement;
	export let textareaElement: HTMLTextAreaElement;
	export let mentionMenuContainer: HTMLElement | null;
	export let showDmNotes: boolean;
	export let handleRetentionChange: (event: Event) => void;
	export let openMap: () => void;
	export let openPaymentSheet: () => void;
	export let openManualCashModal: () => void;
	export let handleClose: () => void;
	export let applyMentionSuggestion: (index: number) => void | Promise<void>;
	export let handleKeydown: (event: KeyboardEvent) => void;
	export let handleInput: () => void;
	export let handleSend: () => void;
	export let handleMessageContentClick: (event: MouseEvent) => void | Promise<void>;
	export let openMapPanel: (placeId?: string | null, options?: any) => any;
	export let openFullMapTab: (placeId?: string | null, options?: any) => any;
	export let openPreferredMapSurface: (placeId?: string | null, options?: any) => any;
	export let onOpenSettings: () => void;

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function isDirectionsCard(message: Message): boolean {
		return message.userId === 'local-directions' && message.localCard?.kind === 'directions';
	}

	function formatDirectionsExpiry(expiresAt?: number): string {
		if (!expiresAt) return 'Temporary';
		const remainingMs = Math.max(0, expiresAt - Date.now());
		const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
		return `Expires in ${remainingMinutes} min`;
	}

	function openDirectionsExternal(url?: string): void {
		if (!url || typeof window === 'undefined') return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function getMsgColor(msg: Message): string {
		if (msg.userId === $currentUser?.id) {
			return resolveUserDisplayColor($currentUser?.roleColor, $currentUser?.color || '#fff');
		}
		if (isGroup) {
			const sender = $users.find((user) => user.id === msg.userId);
			if (sender) return resolveUserDisplayColor(sender.roleColor, sender.color);
			const memberUser = channel?.memberUsers?.find((user) => user.id === msg.userId);
			if (memberUser) return resolveUserDisplayColor(memberUser.roleColor, memberUser.color);
			return '#888';
		}
		return resolveUserDisplayColor(otherUser.roleColor, otherUser.color);
	}
</script>

<div
	class="dm-message-view"
	class:addon-enabled={lineDmAddonEnabled}
	class:preset-line={lineDmPreset === 'line'}
	class:preset-discord={lineDmPreset === 'discord'}
	class:preset-minimal={lineDmPreset === 'minimal'}
	class:direct-thread={!isGroup}
	style:--line-dm-wallpaper-url={lineDmWallpaperUrl}
	style:--line-dm-wallpaper-opacity={String(lineDmProfile.wallpaperOpacity)}
	style:--line-dm-wallpaper-blur={`${lineDmProfile.wallpaperBlur}px`}
	style:--line-dm-wallpaper-size={lineDmProfile.wallpaperSize}
	style:--line-dm-wallpaper-position={lineDmProfile.wallpaperPosition}
	style:--line-dm-wallpaper-repeat={lineDmProfile.wallpaperRepeat}
	style:--line-dm-scrim-opacity={String(lineDmProfile.scrimOpacity)}
	style:--line-dm-surface-opacity={String(lineDmProfile.surfaceOpacity)}
	style:--line-dm-bubble-opacity={String(lineDmProfile.bubbleOpacity)}
>
	<div class="dm-background-layer" aria-hidden="true"></div>
	<div class="dm-background-scrim" aria-hidden="true"></div>

	<div class="dm-shell">
		<div class="dm-header">
			<div class="dm-header-info">
				{#if isGroup && channel}
					<GroupAvatar {channel} size={28} />
					<div class="dm-header-text">
						<span class="dm-header-name">{channel.name}</span>
						<span class="dm-header-handle">{channel.members?.length || 0} members</span>
					</div>
				{:else}
					{#if otherUser.profilePicture}
						<img src={otherUser.profilePicture} alt={otherUser.username} class="dm-header-avatar" />
					{:else}
						<div class="dm-header-avatar-placeholder" style="--avatar-color: {otherUser.roleColor || otherUser.color}">
							{otherUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<div class="dm-header-text">
						<span class="dm-header-name">{otherUser.username}</span>
						{#if otherUser.handle}<span class="dm-header-handle">@{otherUser.handle}</span>{/if}
					</div>
				{/if}
			</div>

			<div class="dm-header-actions">
				<label class="dm-retention-control">
					<span class="dm-retention-label">Keep</span>
					<select class="dm-retention-select" value={selectedRetentionValue} on:change={handleRetentionChange} title="Message retention">
						<option value="">Never</option>
						{#each MESSAGE_RETENTION_PRESETS as duration}
							<option value={duration}>{MESSAGE_RETENTION_LABELS[duration]}</option>
						{/each}
					</select>
				</label>
				<button class="dm-notes-btn" on:click={openMap} title="Open map">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>
					<span>Map</span>
				</button>
				{#if paymentButtonEnabled}
					<button class="dm-notes-btn" on:click={openPaymentSheet} title="Create payment request">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path><path d="M7 15h3"></path></svg>
						<span>Pay</span>
					</button>
				{/if}
				{#if !isGroup && paymentButtonEnabled}
					<button class="dm-notes-btn" on:click={openManualCashModal} title="Record manual cash trade">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle><path d="M6 9h.01"></path><path d="M18 15h.01"></path></svg>
						<span>Cash</span>
					</button>
				{/if}
				<button class="dm-notes-btn" class:active={showDmNotes} on:click={() => showDmNotes = !showDmNotes} title={showDmNotes ? 'Hide notes' : 'Open notes'}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
					<span>Notes</span>
				</button>
				<button class="dm-close-btn" on:click={handleClose} title="Close">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>
		</div>

		<div class="dm-content" class:with-notes={showDmNotes}>
			<div class="dm-main">
				<div class="dm-messages" bind:this={messagesContainer}>
					{#if messages.length === 0}
						<div class="dm-empty"><p>No messages yet. Say hi!</p></div>
					{:else}
						{#each messages as msg (msg.id)}
							<div class="dm-msg" class:own={msg.userId === $currentUser?.id}>
								<div class="dm-msg-header">
									<span class="dm-msg-author" style="color: {getMsgColor(msg)}">{msg.user}</span>
									<span class="dm-msg-time">{formatTime(msg.timestamp)}</span>
									{#if msg.encrypted}
										<span class="dm-msg-encrypted" title="End-to-end encrypted">
											<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM15.1 8H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
										</span>
									{/if}
								</div>
								{#if isDirectionsCard(msg) && msg.localCard}
									<div class="dm-directions-card">
										<div class="dm-directions-head">
											<div>
												<div class="dm-directions-kicker">Local Directions</div>
												<div class="dm-directions-title">{msg.localCard.placeLabel}</div>
											</div>
											<div class="dm-directions-expiry">{formatDirectionsExpiry(msg.localCard.expiresAt)}</div>
										</div>
										<div class="dm-directions-details">
											{#if msg.localCard.poiLabel}<div><strong>POI:</strong> {msg.localCard.poiLabel}</div>{/if}
											{#if msg.localCard.layerLabel}<div><strong>Layer:</strong> {msg.localCard.layerLabel}</div>{/if}
											{#if msg.localCard.building}<div><strong>Building:</strong> {msg.localCard.building}</div>{/if}
											{#if msg.localCard.floor}<div><strong>Floor:</strong> {msg.localCard.floor}</div>{/if}
											{#if msg.localCard.coordinates}<div><strong>Coordinates:</strong> {msg.localCard.coordinates}</div>{/if}
											{#if msg.localCard.originCoordinates}<div><strong>From:</strong> {msg.localCard.originCoordinates}</div>{/if}
										</div>
										<div class="dm-directions-actions">
											<button type="button" class="dm-directions-btn" on:click={() => openMapPanel(msg.localCard?.placeId || null, { layerId: msg.localCard?.layerId || null, poiId: msg.localCard?.poiId || null })}>Mini Map</button>
											<button type="button" class="dm-directions-btn primary" on:click={() => openFullMapTab(msg.localCard?.placeId || null, { layerId: msg.localCard?.layerId || null, poiId: msg.localCard?.poiId || null })}>Full Map</button>
											<button type="button" class="dm-directions-btn" on:click={() => openPreferredMapSurface(msg.localCard?.placeId || null, { layerId: msg.localCard?.layerId || null, poiId: msg.localCard?.poiId || null })}>Smart Open</button>
											{#if msg.localCard.externalUrl}
												<button type="button" class="dm-directions-btn" on:click={() => openDirectionsExternal(msg.localCard?.externalUrl)}>
													{msg.localCard.externalLabel || 'Open OSM'}
												</button>
											{/if}
										</div>
									</div>
								{:else}
									<!-- svelte-ignore a11y-click-events-have-key-events -->
									<!-- svelte-ignore a11y-no-static-element-interactions -->
									<div class="dm-msg-text" on:click={handleMessageContentClick}>
										{@html parseMessage(msg.text, msg.entities || [])}
									</div>
								{/if}
							</div>
						{/each}
					{/if}
				</div>

				<div class="dm-input-area">
					{#if showMentionSuggestions && mentionSuggestions.length > 0}
						<div class="mention-suggestions" bind:this={mentionMenuContainer}>
							{#each mentionSuggestions as suggestion, index (suggestion.key)}
								<button type="button" class="mention-suggestion" class:selected={index === mentionSelectedIndex} on:mousedown|preventDefault={() => applyMentionSuggestion(index)}>
									<span class="mention-copy">
										<span class="mention-label">{suggestion.label}</span>
										{#if suggestion.detail}<span class="mention-detail">{suggestion.detail}</span>{/if}
									</span>
									<span class="mention-kind">{suggestion.kind === 'place' ? 'Place' : 'User'}</span>
								</button>
							{/each}
						</div>
					{/if}
					<textarea class="dm-input" bind:this={textareaElement} bind:value={messageInput} on:keydown={handleKeydown} on:input={handleInput} placeholder={placeholderText} maxlength={dmInputMaxLength} spellcheck={dmSpellcheckEnabled} rows="1"></textarea>
					{#if dmCharCounterEnabled && dmCharCounterVisible}
						<span class="dm-char-counter" class:warn={dmCharCounterWarn} class:visible={dmCharCounterVisible}>{dmCharCount}/{dmInputMaxLength}</span>
					{/if}
					{#if unicodeEmojisEnabled && dmUnicodePreviewTokens > 0 && dmUnicodePreview !== messageInput}
						<div class="dm-unicode-hint">Unicode preview: {dmUnicodePreview}</div>
					{/if}
					<button class="dm-send-btn" on:click={handleSend} disabled={!messageInput.trim()} aria-label="Send message">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
					</button>
				</div>
			</div>

			{#if showDmNotes}
				<div class="dm-notes-panel">
					<NotesWorkspace title={dmNotesTitle} storageKey={dmNotesStorageKey} emptyMessage="No notes in this conversation yet." placeholder="Write a note specific to this DM..." />
				</div>
			{/if}
		</div>
	</div>
</div>

<PaymentSheet
	isOpen={$paymentSheetOpen}
	openSeed={$paymentSheetOpenSeed}
	defaultChannelId={channelId}
	defaultTargetLabel={paymentTargetLabel}
	defaultTargetKind={isGroup ? 'group' : 'dm'}
	onClose={() => paymentSheetOpen.set(false)}
	onManageConnections={() => {
		paymentSheetOpen.set(false);
		onOpenSettings();
	}}
/>

<ManualCashModal
	isOpen={$manualCashOpen}
	{channelId}
	targetLabel={paymentTargetLabel}
	counterpartyLabel={otherUser.username}
	onClose={() => manualCashOpen.set(false)}
/>
