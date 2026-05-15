<script lang="ts">
	import { createEventDispatcher, onMount, afterUpdate, tick } from 'svelte';
import { paymentSheetOpen, paymentSheetOpenSeed, manualCashOpen } from '$lib/payments/dmPayments';
import { handleTypingInput, stopTyping, resetTyping } from '$lib/components/DMTypingManager';
	import { channelMessages, channels, sendMessage, currentUser, users, sendTyping, emojis, syncNewerMessages, updateChannelSettings } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getAuthToken } from '$lib/authSession';
	import { getDmNotesStorageKey } from '$lib/notesStore';
	import GroupAvatar from './GroupAvatar.svelte';
	import ManualCashModal from '$lib/payments/ManualCashModal.svelte';
	import NotesWorkspace from './NotesWorkspace.svelte';
	import PaymentSheet from '$lib/payments/PaymentSheet.svelte';
	import type { User, Message, Channel, MessageEntity } from '$lib/socket';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { parseMessage } from '$lib/markdown';
	import {
		applyWriteUpperCase,
		composerEnhancementSettingsStore,
		splitMessageForSending
	} from '$lib/composerEnhancements';
	import {
		previewUnicodeEmojiConversion,
		replaceEmojiShortcodesWithUnicode,
		unicodeEmojiSettingsStore
	} from '$lib/unicodeEmojis';
import {
	openPaymentSheet,
	openManualCashModal,
	clearConversationPaymentLaunch,
	getPaymentTargetLabel,
	isPaymentButtonEnabled
} from '$lib/payments/dmPayments';
	import {
		buildPlaceMessageEntity,
		buildPlaceSuggestionDetail,
		loadPlaceRegistry,
		placeRegistry,
		rebaseMessageEntitiesForText,
		reconcileMessageEntities,
		searchPlaceMentionSuggestions,
		splitEntitiesForChunks,
		type PlaceRecord
	} from '$lib/placeRegistry';
	import { openFullMapTab, openMapPanel, openPreferredMapSurface } from '$lib/mapWorkspace';
	import { pushLocalDirectionsCard } from '$lib/directionsAssist';
	import { parseCommand } from '$lib/commands';
	import { getLineDmResolvedProfile, lineDmAddonStore } from '$lib/lineDmAddon';
	import {
		DEFAULT_DM_RETENTION,
		MESSAGE_RETENTION_LABELS,
		MESSAGE_RETENTION_PRESETS,
		normalizeMessageRetentionDuration
	} from '../../../../shared/messageRetention.js';

	export let channelId: string;
	export let otherUser: User;
	export let channel: Channel | undefined = undefined;

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

let messageInput = '';
let messagesContainer: HTMLDivElement;
let shouldAutoScroll = true;
let showDmNotes = false;
let textareaElement: HTMLTextAreaElement;
let mentionMenuContainer: HTMLElement | null = null;
let showMentionSuggestions = false;
	type MentionSuggestion = {
		key: string;
		label: string;
		value: string;
		kind: 'user' | 'place';
		detail?: string;
		place?: PlaceRecord;
		poi?: PlaceRecord['pois'][number];
	};
	let mentionSuggestions: MentionSuggestion[] = [];
	let mentionSelectedIndex = 0;
	let mentionTokenStart = -1;
	let composerEntities: MessageEntity[] = [];
	let previousComposerInput = '';
	const DM_COMPOSER_MAX_HEIGHT = 160;
	let lastSyncedChannelId = '';

	$: isGroup = channel?.type === 'group';
	$: activeConversationChannel = channel || $channels.find((entry) => entry.id === channelId);
	$: messages = $channelMessages[channelId] || [];
	$: dmNotesStorageKey = getDmNotesStorageKey(channelId, $currentUser?.id);
	$: dmNotesTitle = isGroup ? 'Group Notes' : 'DM Notes';
	$: composerEnhancementSettings = $composerEnhancementSettingsStore;
	$: dmSpellcheckEnabled = composerEnhancementSettings.spellcheckEnabled;
	$: dmCharCounterEnabled = composerEnhancementSettings.charCounterEnabled;
	$: dmSplitLargeMessagesEnabled = composerEnhancementSettings.splitLargeMessagesEnabled;
	$: dmSplitLargeMessagesChunkSize = composerEnhancementSettings.splitLargeMessagesChunkSize;
	$: dmWriteUpperCaseEnabled = composerEnhancementSettings.writeUpperCaseEnabled;
	$: dmInputMaxLength = dmSplitLargeMessagesEnabled
		? composerEnhancementSettings.splitLargeMessagesInputMaxLength
		: dmSplitLargeMessagesChunkSize;
	$: unicodeEmojisEnabled = $unicodeEmojiSettingsStore.enabled;
	$: dmCharCount = messageInput.length;
	$: dmCharCounterVisible = dmInputMaxLength > 0 && dmCharCount / dmInputMaxLength >= 0.7;
	$: dmCharCounterWarn = dmInputMaxLength > 0 && dmCharCount / dmInputMaxLength >= 0.9;
$: paymentButtonEnabled = isPaymentButtonEnabled($currentUser);
$: paymentTargetLabel = getPaymentTargetLabel(isGroup, channel, otherUser);
	$: lineDmAddonEnabled = $lineDmAddonStore.enabled;
	$: lineDmProfile = getLineDmResolvedProfile(channelId, $lineDmAddonStore);
	$: lineDmPreset = lineDmAddonEnabled ? lineDmProfile.preset : 'discord';
	$: lineDmWallpaperUrl =
		lineDmAddonEnabled && lineDmProfile.wallpaperUrl
			? `url("${lineDmProfile.wallpaperUrl}")`
			: 'none';
	let dmUnicodePreview = '';
	let dmUnicodePreviewTokens = 0;
	$: {
		const preview = previewUnicodeEmojiConversion(messageInput, $emojis);
		dmUnicodePreview = preview.convertedText;
		dmUnicodePreviewTokens = preview.convertedTokens;
	}
	$: if (
		$pendingConversationPaymentLaunch &&
		doesConversationPaymentLaunchMatch($pendingConversationPaymentLaunch, otherUser)
	) {
		if ($pendingConversationPaymentLaunch.surface === 'payment_request') {
			openPaymentSheet();
		} else if (!isGroup) {
			openManualCashModal();
		}
		clearConversationPaymentLaunch();
	}

function openPaymentSheet(): void {
	openPaymentSheet(paymentButtonEnabled);
}

function openManualCashModal(): void {
	openManualCashModal(paymentButtonEnabled, isGroup);
}

	function syncComposerEntities() {
		composerEntities = reconcileMessageEntities(previousComposerInput, messageInput, composerEntities);
		previousComposerInput = messageInput;
	}

	function resetComposerEntityState() {
		composerEntities = [];
		previousComposerInput = messageInput;
	}

	function resetComposerHeight(): void {
		if (!textareaElement) return;
		textareaElement.style.height = 'auto';
	}

	function autoResizeTextarea(): void {
		if (!textareaElement) return;
		textareaElement.style.height = 'auto';
		const nextHeight = Math.min(textareaElement.scrollHeight, DM_COMPOSER_MAX_HEIGHT);
		textareaElement.style.height = `${nextHeight}px`;
	}

	function resolveOutgoingPlaceEntities(text: string): MessageEntity[] {
		if (!composerEntities.length || !text) return [];
		return rebaseMessageEntitiesForText(text, composerEntities);
	}

	function getAddressableUsers(): User[] {
		if (isGroup && channel?.members?.length) {
			const stableMemberIds = new Set(channel.members);
			const selfStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
			return $users
				.filter((candidate) => {
					const stableId = candidate.dbUserId ? `user-${candidate.dbUserId}` : candidate.id;
					return stableId !== selfStableId && stableMemberIds.has(stableId);
				})
				.sort((a, b) => a.username.localeCompare(b.username));
		}
		return otherUser ? [otherUser] : [];
	}

	function updateMentionSuggestions() {
		if (!textareaElement) {
			showMentionSuggestions = false;
			return;
		}

		const caret = textareaElement.selectionStart ?? messageInput.length;
		const beforeCaret = messageInput.slice(0, caret);
		const atIndex = beforeCaret.lastIndexOf('@');
		if (atIndex < 0) {
			showMentionSuggestions = false;
			return;
		}

		const prefixChar = atIndex > 0 ? beforeCaret[atIndex - 1] : '';
		if (prefixChar && !/\s|\(/.test(prefixChar)) {
			showMentionSuggestions = false;
			return;
		}

		const query = beforeCaret.slice(atIndex + 1);
		if (/\s/.test(query)) {
			showMentionSuggestions = false;
			return;
		}

		const normalizedQuery = query.toLowerCase();
		const userEntries = getAddressableUsers()
			.map((entry) => ({
				key: `user-${entry.id}`,
				label: `@${entry.username}`,
				value: entry.username,
				kind: 'user' as const,
				detail: entry.handle ? `@${entry.handle}` : undefined
			}))
			.filter((entry) => entry.value.toLowerCase().startsWith(normalizedQuery));

		if (!$placeRegistry.length) {
			void loadPlaceRegistry();
		}
		const placeEntries = searchPlaceMentionSuggestions(normalizedQuery, 8).map((entry) => ({
			key: entry.key,
			label: entry.label,
			value: entry.value,
			kind: 'place' as const,
			detail: entry.detail || buildPlaceSuggestionDetail(entry.place),
			place: entry.place,
			poi: entry.poi
		}));

		const nextSuggestions = [...userEntries, ...placeEntries].slice(0, 8);
		if (nextSuggestions.length === 0) {
			showMentionSuggestions = false;
			return;
		}

		mentionTokenStart = atIndex;
		mentionSuggestions = nextSuggestions;
		mentionSelectedIndex = 0;
		showMentionSuggestions = true;
	}

	async function applyMentionSuggestion(index: number) {
		if (!textareaElement || index < 0 || index >= mentionSuggestions.length || mentionTokenStart < 0) return;
		const selected = mentionSuggestions[index];
		const caret = textareaElement.selectionStart ?? messageInput.length;
		const before = messageInput.slice(0, mentionTokenStart);
		const after = messageInput.slice(caret);
		const mentionText = `@${selected.value}`;
		const needsTrailingSpace = after.length === 0 || !/^[\\s.,!?;:)]/.test(after);
		const insertion = needsTrailingSpace ? `${mentionText} ` : mentionText;
		const nextMessageInput = before + insertion + after;
		const nextCursor = (before + insertion).length;

		composerEntities = reconcileMessageEntities(messageInput, nextMessageInput, composerEntities);
		if (selected.kind === 'place' && selected.place) {
			composerEntities = [
				...composerEntities,
				buildPlaceMessageEntity(selected.place, before.length, before.length + mentionText.length, {
					poi: selected.poi,
					displayText: mentionText
				})
			].sort((a, b) => a.start - b.start || a.end - b.end);
		}

		messageInput = nextMessageInput;
		previousComposerInput = messageInput;
		showMentionSuggestions = false;
		mentionTokenStart = -1;

		await tick();
		autoResizeTextarea();
		textareaElement.focus();
		textareaElement.setSelectionRange(nextCursor, nextCursor);
	}

	function handleSend() {
		const trimmed = messageInput.trim();
		if (!trimmed) return;
		const normalizedSentenceCaseMessage = applyWriteUpperCase(trimmed, dmWriteUpperCaseEnabled);
		const normalizedMessage = replaceEmojiShortcodesWithUnicode(
			normalizedSentenceCaseMessage,
			$emojis,
			unicodeEmojisEnabled
		);

		if (normalizedMessage.startsWith('/')) {
			const parsed = parseCommand(normalizedMessage);
			if (parsed.command?.name === 'directions' || parsed.command?.name === 'dir' || parsed.command?.name === 'where') {
				const rawTarget = parsed.args.join(' ').trim();
				if (!rawTarget) {
					alert('Place is required.\nUsage: /directions <@place|place-slug[/poi]>');
					return;
				}
				void pushLocalDirectionsCard(channelId, rawTarget).then((ok) => {
					if (!ok) {
						alert(`Place "${rawTarget}" was not found.`);
					}
				});
				messageInput = '';
				resetComposerEntityState();
				resetComposerHeight();
				showMentionSuggestions = false;
				shouldAutoScroll = true;
				resetTyping(sendTyping);
				return;
			}
		}

		const normalizedEntities = resolveOutgoingPlaceEntities(normalizedMessage);

		if (dmSplitLargeMessagesEnabled && normalizedMessage.length > dmSplitLargeMessagesChunkSize) {
			const chunks = splitMessageForSending(normalizedMessage, dmSplitLargeMessagesChunkSize);
			if (chunks.length === 0) return;
			const chunkEntities = splitEntitiesForChunks(normalizedMessage, chunks, normalizedEntities);
			for (const [index, chunk] of chunks.entries()) {
				sendMessage(channelId, chunk, 'text', { entities: chunkEntities[index] });
			}
		} else {
			sendMessage(channelId, normalizedMessage, 'text', { entities: normalizedEntities });
		}

		messageInput = '';
		resetComposerEntityState();
		resetComposerHeight();
		showMentionSuggestions = false;
		shouldAutoScroll = true;
		resetTyping(sendTyping);
		sendTyping(false, channelId);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (showMentionSuggestions) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionSuggestions.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionSuggestions.length) % mentionSuggestions.length;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				void applyMentionSuggestion(mentionSelectedIndex);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				showMentionSuggestions = false;
				return;
			}
		}

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

function handleInput() {
	autoResizeTextarea();
	syncComposerEntities();
	updateMentionSuggestions();
	handleTypingInput(channelId, sendTyping);
}

	async function handleMessageContentClick(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		if (!target) return;
		const placeToken = target.closest('.mention-token-place');
		if (!(placeToken instanceof HTMLElement)) return;
		const placeId = placeToken.dataset.placeId || '';
		if (!placeId) return;
		const layerId = placeToken.dataset.placeLayerId || '';
		const poiId = placeToken.dataset.placePoiId || '';
		event.preventDefault();
		event.stopPropagation();
		await openPreferredMapSurface(placeId, { layerId: layerId || null, poiId: poiId || null });
	}

	function handleClose() {
		layoutStore.closeDM();
	}

	function handleRetentionChange(event: Event): void {
		const select = event.currentTarget as HTMLSelectElement | null;
		if (!select || !activeConversationChannel) return;
		const nextRetention = normalizeMessageRetentionDuration(select.value);
		updateChannelSettings(activeConversationChannel.id, {
			autoDeleteAfter: nextRetention
		});
	}

	function scrollToBottom() {
		if (messagesContainer && shouldAutoScroll) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	function formatTime(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
			// Find the sender in the users store
			const sender = $users.find(u => u.id === msg.userId);
			if (sender) return resolveUserDisplayColor(sender.roleColor, sender.color);
			// Try memberUsers
			const memberUser = channel?.memberUsers?.find(u => u.id === msg.userId);
			if (memberUser) return resolveUserDisplayColor(memberUser.roleColor, memberUser.color);
			return '#888';
		}
		return resolveUserDisplayColor(otherUser.roleColor, otherUser.color);
	}

	$: placeholderText = isGroup ? `Message ${channel?.name}...` : `Message ${otherUser.username}...`;
	$: selectedRetentionValue = activeConversationChannel
		? (activeConversationChannel.autoDeleteAfter ?? '')
		: DEFAULT_DM_RETENTION;
	$: if (channelId && channelId !== lastSyncedChannelId) {
		lastSyncedChannelId = channelId;
		syncNewerMessages(channelId);
	}

	afterUpdate(() => {
		scrollToBottom();
	});

	onMount(() => {
		void loadPlaceRegistry();
		tick().then(() => {
			scrollToBottom();
			autoResizeTextarea();
		});
	});
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
					{#if otherUser.handle}
						<span class="dm-header-handle">@{otherUser.handle}</span>
					{/if}
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
			<button
				class="dm-notes-btn"
				on:click={() => void openPreferredMapSurface()}
				title="Open map"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>
				<span>Map</span>
			</button>
			<button
				class="dm-notes-btn"
				on:click={openPaymentSheet}
				title="Create payment request"
				disabled={!paymentButtonEnabled}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path><path d="M7 15h3"></path></svg>
				<span>Pay</span>
			</button>
			{#if !isGroup}
				<button
					class="dm-notes-btn"
					on:click={openManualCashModal}
					title="Record manual cash trade"
					disabled={!paymentButtonEnabled}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle><path d="M6 9h.01"></path><path d="M18 15h.01"></path></svg>
					<span>Cash</span>
				</button>
			{/if}
			<button
				class="dm-notes-btn"
				class:active={showDmNotes}
				on:click={() => showDmNotes = !showDmNotes}
				title={showDmNotes ? 'Hide notes' : 'Open notes'}
			>
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
					<div class="dm-empty">
						<p>No messages yet. Say hi!</p>
					</div>
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
										{#if msg.localCard.poiLabel}
											<div><strong>POI:</strong> {msg.localCard.poiLabel}</div>
										{/if}
										{#if msg.localCard.layerLabel}
											<div><strong>Layer:</strong> {msg.localCard.layerLabel}</div>
										{/if}
										{#if msg.localCard.building}
											<div><strong>Building:</strong> {msg.localCard.building}</div>
										{/if}
										{#if msg.localCard.floor}
											<div><strong>Floor:</strong> {msg.localCard.floor}</div>
										{/if}
										{#if msg.localCard.coordinates}
											<div><strong>Coordinates:</strong> {msg.localCard.coordinates}</div>
										{/if}
										{#if msg.localCard.originCoordinates}
											<div><strong>From:</strong> {msg.localCard.originCoordinates}</div>
										{/if}
									</div>
									<div class="dm-directions-actions">
										<button
											type="button"
											class="dm-directions-btn"
											on:click={() =>
												openMapPanel(msg.localCard?.placeId || null, {
													layerId: msg.localCard?.layerId || null,
													poiId: msg.localCard?.poiId || null
												})}
										>
											Mini Map
										</button>
										<button
											type="button"
											class="dm-directions-btn primary"
											on:click={() =>
												openFullMapTab(msg.localCard?.placeId || null, {
													layerId: msg.localCard?.layerId || null,
													poiId: msg.localCard?.poiId || null
												})}
										>
											Full Map
										</button>
										<button
											type="button"
											class="dm-directions-btn"
											on:click={() =>
												openPreferredMapSurface(msg.localCard?.placeId || null, {
													layerId: msg.localCard?.layerId || null,
													poiId: msg.localCard?.poiId || null
												})}
										>
											Smart Open
										</button>
										{#if msg.localCard.externalUrl}
											<button
												type="button"
												class="dm-directions-btn"
												on:click={() => openDirectionsExternal(msg.localCard?.externalUrl)}
											>
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
							<button
								type="button"
								class="mention-suggestion"
								class:selected={index === mentionSelectedIndex}
								on:mousedown|preventDefault={() => applyMentionSuggestion(index)}
							>
								<span class="mention-copy">
									<span class="mention-label">{suggestion.label}</span>
									{#if suggestion.detail}
										<span class="mention-detail">{suggestion.detail}</span>
									{/if}
								</span>
								<span class="mention-kind">{suggestion.kind === 'place' ? 'Place' : 'User'}</span>
							</button>
						{/each}
					</div>
				{/if}
				<textarea
					class="dm-input"
					bind:this={textareaElement}
					bind:value={messageInput}
					on:keydown={handleKeydown}
					on:input={handleInput}
					placeholder={placeholderText}
					maxlength={dmInputMaxLength}
					spellcheck={dmSpellcheckEnabled}
					rows="1"
				></textarea>
				{#if dmCharCounterEnabled && dmCharCounterVisible}
					<span class="dm-char-counter" class:warn={dmCharCounterWarn} class:visible={dmCharCounterVisible}>
						{dmCharCount}/{dmInputMaxLength}
					</span>
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
				<NotesWorkspace
					title={dmNotesTitle}
					storageKey={dmNotesStorageKey}
					emptyMessage="No notes in this conversation yet."
					placeholder="Write a note specific to this DM..."
				/>
			</div>
		{/if}
	</div>
	</div>
</div>

<PaymentSheet
  isOpen=$paymentSheetOpen
  openSeed=$paymentSheetOpenSeed
  defaultChannelId={channelId}
  defaultTargetLabel={paymentTargetLabel}
  defaultTargetKind={isGroup ? 'group' : 'dm'}
  onClose={() => {
    paymentSheetOpen.set(false);
  }}
  onManageConnections={() => {
    paymentSheetOpen.set(false);
    dispatch('openSettings', { paymentSurface: 'connections' });
  }}
/>

<ManualCashModal
  isOpen=$manualCashOpen
  channelId={channelId}
  targetLabel={paymentTargetLabel}
  counterpartyLabel={otherUser.username}
  onClose={() => {
    manualCashOpen.set(false);
  }}
/>

<style>
	.dm-message-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		position: relative;
		overflow: hidden;
		background: linear-gradient(180deg, var(--surface-app), color-mix(in srgb, var(--surface-app) 86%, black 14%));
	}

	.dm-shell {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.dm-background-layer,
	.dm-background-scrim {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.dm-background-layer {
		background-image: var(--line-dm-wallpaper-url, none);
		background-size: var(--line-dm-wallpaper-size, cover);
		background-position: var(--line-dm-wallpaper-position, center);
		background-repeat: var(--line-dm-wallpaper-repeat, no-repeat);
		opacity: 0;
		filter: blur(var(--line-dm-wallpaper-blur, 0px));
		transform: scale(1.03);
		transition: opacity 0.18s ease;
	}

	.dm-background-scrim {
		background: transparent;
		transition: background 0.18s ease;
	}

	.dm-message-view.addon-enabled .dm-background-layer {
		opacity: var(--line-dm-wallpaper-opacity, 0.32);
	}

	.dm-message-view.addon-enabled .dm-background-scrim {
		background:
			linear-gradient(
				180deg,
				rgba(10, 14, 18, calc(var(--line-dm-scrim-opacity, 0.28) + 0.08)),
				rgba(10, 14, 18, calc(var(--line-dm-scrim-opacity, 0.28) + 0.22))
			),
			radial-gradient(circle at top left, rgba(181, 255, 171, 0.16), transparent 46%);
	}

	.dm-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border-subtle);
		flex-shrink: 0;
		background: var(--surface-base);
	}

	.dm-header-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.dm-retention-control {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0 0.45rem;
		height: 28px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--surface-app);
		color: var(--text-secondary);
		font-size: 0.72rem;
	}

	.dm-retention-label {
		white-space: nowrap;
	}

	.dm-retention-select {
		border: none;
		background: transparent;
		color: var(--text-heading);
		font-size: 0.72rem;
		outline: none;
		cursor: pointer;
		max-width: 8rem;
	}

	.dm-notes-btn {
		height: 28px;
		padding: 0 0.5rem;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--surface-app);
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.dm-notes-btn:hover,
	.dm-notes-btn.active {
		color: var(--text-heading);
		background: var(--surface-hover);
	}

	.dm-header-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		flex: 1;
	}

	.dm-content {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}

	.dm-content.with-notes {
		grid-template-columns: minmax(0, 1fr) minmax(280px, 38%);
	}

	.dm-main {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.dm-notes-panel {
		border-left: 1px solid var(--border-subtle);
		min-height: 0;
	}

	.dm-header-avatar,
	.dm-header-avatar-placeholder {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}

	.dm-header-avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		font-weight: 600;
		color: white;
	}

	.dm-header-text {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		min-width: 0;
	}

	.dm-header-name {
		display: block;
		width: 100%;
		text-align: left;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-heading);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-header-handle {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.dm-close-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dm-close-btn:hover {
		background: var(--surface-hover);
		color: var(--text-heading);
	}

	.dm-messages {
		flex: 1;
		overflow-y: auto;
		padding: 0.45rem 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
	}

	.dm-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.dm-msg {
		padding: 0.12rem 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		max-width: min(74ch, 86%);
	}

	.dm-msg.own {
		align-self: flex-end;
		align-items: flex-end;
	}

	.dm-msg-header {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		margin-bottom: 0.08rem;
	}

	.dm-msg-author {
		font-size: 0.8rem;
		font-weight: 600;
	}

	.dm-msg-time {
		font-size: 0.65rem;
		color: var(--text-secondary);
	}

	.dm-msg-encrypted {
		color: var(--accent, var(--accent-primary, #5865f2));
		opacity: 0.7;
		display: inline-flex;
		align-items: center;
		margin-left: 2px;
	}

	.dm-msg-text {
		font-size: 0.85rem;
		color: var(--text-heading);
		word-wrap: break-word;
		word-break: break-word;
		overflow-wrap: break-word;
		line-height: 1.35;
		display: inline-block;
		width: fit-content;
		max-width: 100%;
		max-height: min(22rem, 55vh);
		overflow-y: auto;
		padding: 0.34rem 0.9rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-raised) 78%, var(--surface-app, var(--surface-app, #000)) 22%);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent);
		box-shadow: inset 0 1px 0 rgba(var(--text-inverse-rgb, 255, 255, 255), 0.05);
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--accent-primary) 24%, var(--border-subtle) 76%) transparent;
	}

	.dm-msg-text::-webkit-scrollbar {
		width: 8px;
	}

	.dm-msg-text::-webkit-scrollbar-track {
		background: transparent;
	}

	.dm-msg-text::-webkit-scrollbar-thumb {
		background: color-mix(in srgb, var(--accent-primary) 24%, var(--border-subtle) 76%);
		border-radius: 999px;
	}

	.dm-directions-card {
		width: min(100%, 34rem);
		padding: 0.75rem 0.85rem;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--accent-primary) 18%, var(--border-subtle) 82%);
		background:
			linear-gradient(160deg, color-mix(in srgb, var(--accent-primary) 12%, var(--surface-raised) 88%), var(--surface-raised));
		display: grid;
		gap: 0.65rem;
	}

	.dm-directions-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.dm-directions-kicker {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);
		margin-bottom: 0.18rem;
	}

	.dm-directions-title {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--text-heading);
		word-break: break-word;
	}

	.dm-directions-expiry {
		font-size: 0.72rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.dm-directions-details {
		display: grid;
		gap: 0.28rem;
		font-size: 0.82rem;
		color: var(--text-heading);
	}

	.dm-directions-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.dm-directions-btn {
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--surface-app);
		color: var(--text-heading);
		padding: 0.36rem 0.72rem;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
	}

	.dm-directions-btn.primary {
		background: color-mix(in srgb, var(--accent-primary) 18%, var(--surface-app) 82%);
		border-color: color-mix(in srgb, var(--accent-primary) 32%, var(--border-subtle) 68%);
	}

	.dm-msg-text :global(p) {
		margin: 0;
	}

	.dm-msg-text :global(.mention-token-place) {
		cursor: pointer;
		background: rgba(89, 163, 255, 0.18);
		border: 1px solid rgba(126, 196, 255, 0.28);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
	}

	.dm-msg + .dm-msg {
		margin-top: -0.06rem;
	}

	.dm-input-area {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 0.375rem;
		padding: 0.5rem;
		border-top: 1px solid var(--border-subtle);
		background: var(--surface-base);
		flex-shrink: 0;
	}

	.mention-suggestions {
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: calc(100% + 0.25rem);
		background: var(--surface-base);
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		padding: 0.35rem;
		box-shadow: 0 10px 24px var(--shadow-md, var(--shadow-sm, var(--shadow-md, var(--shadow-lg, rgba(0, 0, 0, 0.24)))));
		z-index: 25;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.mention-suggestion {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		border: none;
		background: transparent;
		color: var(--text-heading);
		padding: 0.5rem 0.55rem;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
	}

	.mention-suggestion:hover,
	.mention-suggestion.selected {
		background: var(--accent-primary);
		color: var(--text-inverse, var(--text-inverse, #fff));
	}

	.mention-copy {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 0.15rem;
	}

	.mention-label {
		font-weight: 600;
	}

	.mention-detail {
		font-size: 0.72rem;
		opacity: 0.78;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.mention-kind {
		font-size: 0.72rem;
		opacity: 0.85;
		flex-shrink: 0;
	}

	.dm-input {
		flex: 1;
		resize: none;
		padding: 0.5rem 0.625rem;
		font-size: 0.85rem;
		border: 1px solid var(--border-subtle);
		background: var(--surface-app);
		color: var(--text-heading);
		border-radius: 8px;
		min-height: 36px;
		max-height: 160px;
		overflow-y: auto;
		font-family: inherit;
		line-height: 1.4;
		scrollbar-width: thin;
		scrollbar-color: color-mix(in srgb, var(--accent-primary) 24%, var(--border-subtle) 76%) transparent;
	}

	.dm-input::-webkit-scrollbar {
		width: 8px;
	}

	.dm-input::-webkit-scrollbar-track {
		background: transparent;
	}

	.dm-input::-webkit-scrollbar-thumb {
		background: color-mix(in srgb, var(--accent-primary) 24%, var(--border-subtle) 76%);
		border-radius: 999px;
	}

	.dm-input::placeholder {
		color: var(--text-secondary);
	}

	.dm-char-counter {
		font-size: 0.66rem;
		color: var(--text-secondary);
		min-width: 4rem;
		text-align: right;
		align-self: flex-end;
		padding-bottom: 0.25rem;
		opacity: 0;
		transform: translateY(2px);
		transition: opacity 0.18s ease, transform 0.18s ease;
	}

	.dm-char-counter.visible {
		opacity: 0.85;
		transform: translateY(0);
	}

	.dm-char-counter.warn {
		color: var(--color-warning);
	}

	.dm-unicode-hint {
		font-size: 0.66rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 280px;
		align-self: center;
	}

	.dm-send-btn {
		width: 36px;
		height: 36px;
		border-radius: 8px;
		border: none;
		background: var(--accent-primary);
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	:global(html[data-clickable-send='true']) .dm-input-area .dm-send-btn {
		display: none;
	}

	:global(html[data-clickable-send='true']) .dm-input-area:focus-within .dm-send-btn {
		display: flex;
	}

	:global(html[data-clickable-send='false']) .dm-send-btn {
		display: none;
	}

	.dm-send-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.dm-send-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.dm-message-view.addon-enabled .dm-header,
	.dm-message-view.addon-enabled .dm-input-area,
	.dm-message-view.addon-enabled .dm-notes-panel {
		background: rgba(14, 20, 27, var(--line-dm-surface-opacity, 0.78));
		backdrop-filter: blur(18px);
	}

	.dm-message-view.addon-enabled .dm-notes-panel {
		border-left-color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
	}

	.dm-message-view.addon-enabled .dm-messages {
		padding: 0.8rem 0.75rem 0.95rem;
		gap: 0.32rem;
	}

	.dm-message-view.addon-enabled .dm-msg {
		max-width: min(76ch, 88%);
	}

	.dm-message-view.addon-enabled .dm-msg-text {
		border-radius: 18px;
		backdrop-filter: blur(10px);
		box-shadow: 0 10px 28px var(--shadow-lg, var(--shadow-md, var(--shadow-md, rgba(0, 0, 0, 0.18))));
	}

	.dm-message-view.addon-enabled .dm-msg:not(.own) .dm-msg-text {
		background: rgba(255, 255, 255, var(--line-dm-bubble-opacity, 0.92));
		color: var(--surface-app, #1b2430);
		border-color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.14);
	}

	.dm-message-view.addon-enabled .dm-msg.own .dm-msg-text {
		background: rgba(166, 235, 124, var(--line-dm-bubble-opacity, 0.92));
		color: var(--surface-app, #132012);
		border-color: var(--shadow-sm, var(--shadow-sm, var(--shadow-sm, rgba(0, 0, 0, 0.08))));
	}

	.dm-message-view.addon-enabled .dm-msg-time {
		color: rgba(var(--text-inverse-rgb, 241, 245, 249), 0.72);
	}

	.dm-message-view.addon-enabled.preset-line.direct-thread .dm-msg-author {
		display: none;
	}

	.dm-message-view.addon-enabled.preset-line.direct-thread .dm-msg-header {
		margin-bottom: 0.18rem;
	}

	.dm-message-view.addon-enabled.preset-discord .dm-background-scrim {
		background:
			linear-gradient(
				180deg,
				rgba(12, 16, 26, calc(var(--line-dm-scrim-opacity, 0.28) + 0.16)),
				rgba(10, 12, 20, calc(var(--line-dm-scrim-opacity, 0.28) + 0.24))
			),
			radial-gradient(circle at top right, rgba(var(--accent-primary-rgb, 88, 101, 242), 0.22), transparent 44%);
	}

	.dm-message-view.addon-enabled.preset-discord .dm-msg:not(.own) .dm-msg-text {
		background: rgba(31, 36, 46, var(--line-dm-bubble-opacity, 0.92));
		color: var(--text-inverse, #edf2f7);
		border-color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.07);
	}

	.dm-message-view.addon-enabled.preset-discord .dm-msg.own .dm-msg-text {
		background: rgba(88, 101, 242, var(--line-dm-bubble-opacity, 0.92));
		color: var(--text-inverse, #f8fbff);
	}

	.dm-message-view.addon-enabled.preset-minimal .dm-background-scrim {
		background:
			linear-gradient(
				180deg,
				rgba(9, 13, 18, calc(var(--line-dm-scrim-opacity, 0.28) + 0.18)),
				rgba(9, 13, 18, calc(var(--line-dm-scrim-opacity, 0.28) + 0.18))
			);
	}

	.dm-message-view.addon-enabled.preset-minimal .dm-msg:not(.own) .dm-msg-text {
		background: rgba(22, 28, 34, var(--line-dm-bubble-opacity, 0.92));
		color: var(--text-inverse, #eef4f8);
		border-color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.05);
		box-shadow: none;
	}

	.dm-message-view.addon-enabled.preset-minimal .dm-msg.own .dm-msg-text {
		background: rgba(63, 148, 255, var(--line-dm-bubble-opacity, 0.92));
		color: var(--text-inverse, #f8fbff);
		box-shadow: none;
	}

	@media (max-width: 1024px) {
		.dm-content.with-notes {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr) 45%;
		}

		.dm-notes-panel {
			border-left: none;
			border-top: 1px solid var(--border-subtle);
		}
	}

	.dm-header-avatar-placeholder { background-color: var(--avatar-color, var(--accent-primary)); }
</style>
