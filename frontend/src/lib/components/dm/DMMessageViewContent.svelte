<script lang="ts">
	import { createEventDispatcher, onMount, afterUpdate, tick } from 'svelte';
	import { paymentSheetOpen, paymentSheetOpenSeed, manualCashOpen } from '$lib/payments/dmPayments';
	import { handleTypingInput, resetTyping } from '$lib/components/DMTypingManager';
	import { channelMessages, channels, sendMessage, currentUser, users, sendTyping, emojis, syncNewerMessages, updateChannelSettings } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getDmNotesStorageKey } from '$lib/notesStore';
	import type { User, Message, Channel, MessageEntity, Emoji } from '$lib/socket';
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
		openPaymentSheet as launchPaymentSheet,
		openManualCashModal as launchManualCashModal,
		clearConversationPaymentLaunch,
		getPaymentTargetLabel,
		isPaymentButtonEnabled
	} from '$lib/payments/dmPayments';
	import {
		doesConversationPaymentLaunchMatch,
		pendingConversationPaymentLaunch
	} from '$lib/payments/paymentLaunch';
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
	import DMMessageViewFrame from './DMMessageViewFrame.svelte';
	import { pushLocalDirectionsCard } from '$lib/directionsAssist';
	import { parseCommand } from '$lib/commands';
	import { getLineDmResolvedProfile, lineDmAddonStore } from '$lib/lineDmAddon';
	import {
		DEFAULT_DM_RETENTION,
		MESSAGE_RETENTION_LABELS,
		MESSAGE_RETENTION_PRESETS,
		normalizeMessageRetentionDuration
	} from '../../../../../shared/messageRetention.js';

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
		const preview = previewUnicodeEmojiConversion(messageInput, $emojis as unknown as Emoji[]);
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
		launchPaymentSheet(paymentButtonEnabled);
	}

	function openManualCashModal(): void {
		launchManualCashModal(paymentButtonEnabled, isGroup);
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
			$emojis as unknown as Emoji[],
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
				(sendMessage as unknown as (channelId: string, text: string, type: string, options?: Record<string, unknown>) => void)(
					channelId,
					chunk,
					'text',
					{ entities: chunkEntities[index] }
				);
			}
		} else {
			(sendMessage as unknown as (channelId: string, text: string, type: string, options?: Record<string, unknown>) => void)(
				channelId,
				normalizedMessage,
				'text',
				{ entities: normalizedEntities }
			);
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
		} as any);
	}

	function scrollToBottom() {
		if (messagesContainer && shouldAutoScroll) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
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


<DMMessageViewFrame
	{channelId}
	{otherUser}
	{channel}
	{isGroup}
	{messages}
	{dmNotesStorageKey}
	{dmNotesTitle}
	{lineDmAddonEnabled}
	{lineDmPreset}
	{lineDmProfile}
	{lineDmWallpaperUrl}
	{selectedRetentionValue}
	{MESSAGE_RETENTION_PRESETS}
	{MESSAGE_RETENTION_LABELS}
	{paymentButtonEnabled}
	{paymentTargetLabel}
	{mentionSuggestions}
	{mentionSelectedIndex}
	{showMentionSuggestions}
	{placeholderText}
	{dmInputMaxLength}
	{dmSpellcheckEnabled}
	{dmCharCounterEnabled}
	{dmCharCounterVisible}
	{dmCharCounterWarn}
	{dmCharCount}
	{unicodeEmojisEnabled}
	{dmUnicodePreviewTokens}
	{dmUnicodePreview}
	bind:messageInput
	bind:messagesContainer
	bind:textareaElement
	bind:mentionMenuContainer
	bind:showDmNotes
	{handleRetentionChange}
	openMap={() => void openPreferredMapSurface()}
	{openPaymentSheet}
	{openManualCashModal}
	{handleClose}
	{applyMentionSuggestion}
	{handleKeydown}
	{handleInput}
	{handleSend}
	{handleMessageContentClick}
	{openMapPanel}
	{openFullMapTab}
	{openPreferredMapSurface}
	onOpenSettings={() => dispatch('openSettings', { paymentSurface: 'connections' })}
/>
