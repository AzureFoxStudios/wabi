<script lang="ts">
	import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { browser } from '$app/environment';
	import { get } from 'svelte/store';
	import {
		channelMessages,
		channels,
		currentChannel,
		typingUsers,
		sendMessage,
		sendTyping,
		lastReadMessageId,
		editMessage,
		currentUser,
		emojis,
		users,
		dmPanelSignal,
		createDM,
		getDMChannelIdForUser,
		socket,
		loadOlderHistory,
		channelHasMoreHistory,
		channelHistoryLoading,
		loadOlderMessages,
		channelAvailableArchives,
		channelLoadedArchives,
		channelLoadingOlder,
		type Message,
		type Emoji,
		type User,
		type Channel
	} from '$lib/socket';
	import { resources, graphEdges } from '$lib/business/store';
	import { todos, projects, calendarEvents, diaryEntries } from '$lib/business/store';
	import type { Resource } from '$lib/business/types';
	import { pinChannel, unpinChannel } from '$lib/socket';
	import MessageList from './MessageList.svelte';
	import ChannelQuickTabs from './ChannelQuickTabs.svelte';
	import PinnedMessages from './PinnedMessages.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import AudioRecorder from './AudioRecorder.svelte';
	import CameraCapture from './CameraCapture.svelte';
	import ManualCashModal from './ManualCashModal.svelte';
	import PaymentSheet from './PaymentSheet.svelte';
	import { parseCommand, formatCommandHelp, getMatchingCommands, type Command } from '$lib/commands';
	import { layoutStore } from '$lib/layoutStore';
	import { callMode, isInCall, outgoingCall, startCall } from '$lib/calling';
	import { getServerUrl } from '$lib/serverUrl';
	import { encryptDMFile, isE2EAvailable } from '$lib/e2eManager';
	import { getDMPrivacyMode } from '$lib/dmPrivacyMode';
	import { _, currentLocale } from '$lib/i18n';
	import { lookupDictionary, upsertDictionaryEntry, deleteDictionaryEntry } from '$lib/api';
	import { getTauriPlatform, isTauriRuntime } from '$lib/tauri-platform';
	import {
		classifyVideoCompressionFailure,
		compressVideoFileForUpload,
		estimateCompressedVideoOutput,
		inferVideoCodecHint,
		isVideoFile,
		sampleVideoCompressionInputMetadata,
		type VideoCompressionEstimate,
		type VideoCompressionInputMetadata,
		type VideoCompressionPresetId
	} from '$lib/video/videoCompressor';
	import {
		getDefaultVideoCompressionPreset,
		getVideoCompressionPresetOptions,
		getVideoCompressionRuntimeProfile,
		isVideoCompressionEnabled,
		type VideoCompressionPresetOption,
		type VideoCompressionRuntime
	} from '$lib/video/videoCompressionSettings';
	import { reportVideoCompressionTelemetry } from '$lib/video/videoCompressionTelemetry';
	import { applyChatFilter, expandInputWithChatAlias } from '$lib/chatEnhancements';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import {
		applyWriteUpperCase,
		composerEnhancementSettingsStore,
		splitMessageForSending
	} from '$lib/composerEnhancements';
	import { gifCaptionerSettingsStore } from '$lib/gifCaptionerSettings';
	import {
		previewUnicodeEmojiConversion,
		replaceEmojiShortcodesWithUnicode,
		unicodeEmojiSettingsStore
	} from '$lib/unicodeEmojis';
	import { animationPassStore, type AnimationPassPreset } from '$lib/animationPass';
	import { getAuthToken, getGuestSessionId } from '$lib/authSession';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { getSearchEngineProvider, openExternalSearch } from '$lib/searchEngineJump';
	import {
		isExperimentalStdbCallEnabled,
		setExperimentalStdbCallEnabled
	} from '$lib/experimentalStdbCalls';

	const dispatch = createEventDispatcher();
	const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
	const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
	const easeOutBack = (t: number) => {
		const c1 = 1.70158;
		const c3 = c1 + 1;
		return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
	};

	$: messages = $channelMessages[$currentChannel] || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: channelDisplayName = currentChannelData?.name || $currentChannel;
	$: channelDescription = currentChannelData?.description?.trim() || '';

	// Safeguard: DM channels should never be displayed in the main chat area
	// They should only appear in the DM panel on the right side
	// This check prevents accidental rendering of DMs in the middle chat
	$: isDMChannel = currentChannelData?.type === 'dm';
	$: isGroupChannel = currentChannelData?.type === 'group';
	$: dmCallTargetUser = getDMOtherUser(currentChannelData);
	$: paymentTargetLabel = (() => {
		if (isDMChannel && dmCallTargetUser?.username) {
			return `DM with ${dmCallTargetUser.username}`;
		}
		if (isGroupChannel) {
			return channelDisplayName;
		}
		return channelDisplayName ? `#${channelDisplayName}` : $currentChannel;
	})();
	$: paymentTargetKind = isDMChannel ? 'dm' : isGroupChannel ? 'group' : 'channel';
	$: dmDirectCallActive = ($isInCall && $callMode === 'direct') || Boolean($outgoingCall);
	$: dmDirectCallPending = Boolean($outgoingCall) && !$isInCall && $callMode === 'direct';
	$: experimentalScopeVisible = isDMChannel || isGroupChannel;
	$: channelPaneAnimation = (() => {
		const baseDuration = $animationPassStore.level === 'full' ? 340 : 250;
		const baseDistance = $animationPassStore.level === 'full' ? 34 : 22;
		return {
			enabled: $animationPassStore.enabled,
			preset: $animationPassStore.preset,
			duration: Math.max(0, Math.round(baseDuration * $animationPassStore.durationMultiplier)),
			distance: Math.max(0, Math.round(baseDistance * $animationPassStore.durationMultiplier))
		};
	})();

	let messageInput = '';
	let manualCashOpen = false;
	let paymentSheetOpen = false;
	let paymentSheetOpenSeed = 0;
	let paymentSheetPrefillAmountInput: string | null = null;
	let paymentSheetPrefillDescription: string | null = '';
	let paymentSheetPrefillCustomerRef: string | null = '';
	let chatContainer: HTMLElement;
	let typingTimeout: number;
	let lastTypingEmit = 0;
	const TYPING_THROTTLE_MS = 300; // Max one typing event per 300ms
	let showEmojiPicker = false;
	let showMediaMenu = false;
	let emojiPickerButton: HTMLButtonElement;
	let emojiPickerContainer: HTMLElement | null = null;
	let mediaMenuContainer: HTMLElement | null = null;
	let replyingTo: Message | null = null;
	let fileInput: HTMLInputElement;
	let editingMessage: Message | null = null;
	let uploadProgress = 0;
	let isUploading = false;
	let uploadStatusLabel = '';
	let compressionDialogOpen = false;
	let compressionDialogFile: File | null = null;
	let compressionDialogPreset: VideoCompressionPresetId = 'balanced_720p';
	let compressionDialogPresetOptions: VideoCompressionPresetOption[] =
		getVideoCompressionPresetOptions('desktop');
	let compressionDialogRuntime: VideoCompressionRuntime = 'desktop';
	let compressionDialogRuntimeLabel = 'Desktop';
	let selectedCompressionPresetOption: VideoCompressionPresetOption | null = null;
	let compressionDialogInputMetadata: VideoCompressionInputMetadata | null = null;
	let compressionDialogEstimate: VideoCompressionEstimate | null = null;
	let compressionDialogSuggestionCopy = '';
	let compressionDialogError = '';
	let compressionDialogProgress = 0;
	let compressionDialogBusy = false;
	let compressionDialogResolve: ((value: File | null) => void) | null = null;
	let compressionAbortController: AbortController | null = null;
	let experimentalStdbCallsEnabled = false;
	let selectedFiles: File[] = [];
	let filePreviews: { file: File; preview?: string }[] = [];
	let markAsSpoiler = false;
	let isDragging = false;
	let dragCounter = 0;
	let textareaElement: HTMLTextAreaElement;
	let mentionMenuContainer: HTMLElement | null = null;
	let showMentionSuggestions = false;
	let mentionSuggestions: { key: string; label: string; value: string; kind: 'special' | 'user' }[] = [];
	let mentionSelectedIndex = 0;
	let mentionTokenStart = -1;
	let EmojiPickerComponent: typeof import('./EmojiPicker.svelte').default | null = null;
	let emojiPickerLoadPromise: Promise<void> | null = null;
	$: paymentButtonEnabled = Boolean($currentUser?.dbUserId) && Boolean(getAuthToken());

	type PaymentSheetPrefill = {
		amountInput?: string | null;
		description?: string | null;
		customerRef?: string | null;
	};

	function openPaymentSheet(prefill: PaymentSheetPrefill = {}): void {
		if (!paymentButtonEnabled) {
			alert('Sign in with a registered account to create payments.');
			return;
		}
		paymentSheetPrefillAmountInput =
			typeof prefill.amountInput === 'string' && prefill.amountInput.trim().length > 0
				? prefill.amountInput.trim()
				: null;
		paymentSheetPrefillDescription =
			typeof prefill.description === 'string' ? prefill.description.trim() : '';
		paymentSheetPrefillCustomerRef =
			typeof prefill.customerRef === 'string' ? prefill.customerRef.trim() : '';
		paymentSheetOpenSeed += 1;
		paymentSheetOpen = true;
	}

	function openManualCashModal(): void {
		if (!paymentButtonEnabled) {
			alert('Sign in with a registered account to track manual cash trades.');
			return;
		}
		if (!isDMChannel) {
			alert('Manual cash trades are only available in direct messages.');
			return;
		}
		manualCashOpen = true;
	}
	type UploadVideoCompressionMetadata = {
		scheme: 'wabi-video-compression-v1';
		runtime: VideoCompressionRuntime;
		preset: VideoCompressionPresetId;
		originalSize: number;
		compressedSize: number;
		codec: 'vp9' | 'vp8' | 'h264' | 'hevc' | 'av1' | 'unknown';
		mimeType: string;
		durationMs: number;
		estimatedOutputBytes?: number;
	};
	const compressionMetadataByFile = new WeakMap<File, UploadVideoCompressionMetadata>();

	function getTransitionForPreset(
		node: Element,
		preset: AnimationPassPreset,
		duration: number,
		distance: number
	) {
		if (preset === 'fade') {
			return fade(node, { duration, easing: easeOutCubic });
		}
		if (preset === 'scale') {
			return scale(node, { duration, start: 0.96, opacity: 0.2, easing: easeOutBack });
		}
		if (preset === 'flip') {
			return scale(node, { duration, start: 0.92, opacity: 0.1, easing: easeOutQuint });
		}
		return fly(node, { duration, y: distance, opacity: 0.15, easing: easeOutQuint });
	}

	function channelPaneInTransition(
		node: Element,
		params: { enabled: boolean; preset: AnimationPassPreset; duration: number; distance: number }
	) {
		const reducedMotion = browser && document.documentElement.getAttribute('data-reduce-motion') === 'true';
		if (reducedMotion) {
			return fade(node, { duration: 0 });
		}
		if (!params.enabled || params.duration <= 0) {
			return fade(node, { duration: 0 });
		}
		return getTransitionForPreset(node, params.preset, params.duration, params.distance);
	}

	function channelPaneOutTransition(
		node: Element,
		params: { enabled: boolean; preset: AnimationPassPreset; duration: number; distance: number }
	) {
		const reducedMotion = browser && document.documentElement.getAttribute('data-reduce-motion') === 'true';
		if (reducedMotion) {
			return fade(node, { duration: 0 });
		}
		if (!params.enabled || params.duration <= 0) {
			return fade(node, { duration: 0 });
		}
		const outDuration = Math.max(80, Math.min(180, Math.round(params.duration * 0.5)));
		return fade(node, { duration: outDuration, easing: easeOutCubic });
	}

	function ensureEmojiPickerLoaded(): void {
		if (EmojiPickerComponent || emojiPickerLoadPromise) return;
		emojiPickerLoadPromise = import('./EmojiPicker.svelte')
			.then((mod) => {
				EmojiPickerComponent = mod.default;
			})
			.catch((error) => {
				console.error('Failed to load EmojiPicker:', error);
			})
			.finally(() => {
				emojiPickerLoadPromise = null;
			});
	}
	const RESUMABLE_UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1MB
	const RESUMABLE_UPLOAD_MAX_RETRIES = 4;
	const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024; // 1GB
	const MAX_GIF_CAPTION_LENGTH = 280;

	// Command palette
	let commandPalette: CommandPalette;
	let showCommandPalette = false;
	let commandPaletteSelectedIndex = 0;

	// Search functionality
	let searchInput = '';
	let searchExpanded = false;
	let searchContainerElement: HTMLElement | null = null;
	let searchInputElement: HTMLInputElement | null = null;
	let filteredMessages: Message[] = [];
	const MESSAGE_WORKING_SET_LIMIT_EPHEMERAL = 600;
	const MESSAGE_WORKING_SET_LIMIT_PERSISTENT_IDLE = 1200;
	const MESSAGE_WORKING_SET_LIMIT_PERSISTENT_SEARCH = 5000;
	const SEARCH_BACKFILL_THROTTLE_MS = 700;
	let lastSearchBackfillAt = 0;
	let isFullHistorySearchRunning = false;
	let fullHistorySearchAbortRequested = false;
	let fullHistorySearchPagesLoaded = 0;
	let fullHistorySearchStatus = '';
	let runtimeVersionLabel = 'unknown';
	const MAX_FULL_HISTORY_SEARCH_PAGES = 80;
	const MAX_FILE_PREVIEW_IMAGES = 8;
	let gifCaptionInput = '';
	let lastPreviewChannelId: string | null = null;
	$: composerEnhancementSettings = $composerEnhancementSettingsStore;
	$: composerSpellcheckEnabled = composerEnhancementSettings.spellcheckEnabled;
	$: composerCharCounterEnabled = composerEnhancementSettings.charCounterEnabled;
	$: splitLargeMessagesEnabled = composerEnhancementSettings.splitLargeMessagesEnabled;
	$: splitLargeMessagesChunkSize = composerEnhancementSettings.splitLargeMessagesChunkSize;
	$: writeUpperCaseEnabled = composerEnhancementSettings.writeUpperCaseEnabled;
	$: composerInputMaxLength = splitLargeMessagesEnabled
		? composerEnhancementSettings.splitLargeMessagesInputMaxLength
		: splitLargeMessagesChunkSize;
	$: gifCaptionerEnabled = $gifCaptionerSettingsStore.enabled;
	$: gifCaptionerDedicatedCaptionFieldEnabled = $gifCaptionerSettingsStore.dedicatedCaptionFieldEnabled;
	$: unicodeEmojisEnabled = $unicodeEmojiSettingsStore.enabled;
	$: composerCharCount = messageInput.length;
	$: composerCharCounterVisible =
		composerInputMaxLength > 0 && composerCharCount / composerInputMaxLength >= 0.7;
	$: composerCharCounterWarn = composerInputMaxLength > 0 && composerCharCount / composerInputMaxLength >= 0.9;
	$: gifCaptionDraftLength = gifCaptionInput.trim().length;
	$: gifCaptionDraftWarn =
		gifCaptionDraftLength > 0 &&
		gifCaptionDraftLength / MAX_GIF_CAPTION_LENGTH >= 0.9;
	let unicodeComposerPreview = '';
	let unicodeComposerPreviewTokens = 0;
	let unicodeGifCaptionPreview = '';
	let unicodeGifCaptionPreviewTokens = 0;
	$: {
		const preview = previewUnicodeEmojiConversion(messageInput, $emojis);
		unicodeComposerPreview = preview.convertedText;
		unicodeComposerPreviewTokens = preview.convertedTokens;
	}
	$: {
		const preview = previewUnicodeEmojiConversion(gifCaptionInput, $emojis);
		unicodeGifCaptionPreview = preview.convertedText;
		unicodeGifCaptionPreviewTokens = preview.convertedTokens;
	}
	$: selectedCompressionPresetOption =
		compressionDialogPresetOptions.find((option) => option.id === compressionDialogPreset) ||
		compressionDialogPresetOptions[0] ||
		null;
	$: if (compressionDialogFile && compressionDialogInputMetadata) {
		compressionDialogEstimate = estimateCompressedVideoOutput(
			compressionDialogFile.size,
			compressionDialogInputMetadata,
			compressionDialogPreset
		);
		compressionDialogSuggestionCopy = getCompressionSuggestionCopy(
			compressionDialogFile.size,
			compressionDialogRuntime,
			compressionDialogEstimate
		);
	} else {
		compressionDialogEstimate = null;
		compressionDialogSuggestionCopy = '';
	}

	// Photo and audio capture
	let showCameraCapture = false;
	let showAudioRecorder = false;
	let visibleTypingUsers: string[] = [];

	// Format typing users list with proper grammar
	function formatTypingUsers(users: string[]): string {
		const t = get(_);
		if (users.length === 0) return '';
		if (users.length === 1) return t('chat.typing.one', { values: { user: users[0] } });
		if (users.length === 2) return t('chat.typing.two', { values: { user1: users[0], user2: users[1] } });
		if (users.length >= 6) return t('chat.typing.many');

		// 3-5 users: "User1, User2, and User3 are typing..."
		const allButLast = users.slice(0, -1).join(', ');
		const lastUser = users[users.length - 1];
		return t('chat.typing.multi', { values: { users: allButLast, lastUser } });
	}

	function getTypingUserPriority(username: string): number {
		const user = $users.find((u) => u.username.toLowerCase() === username.toLowerCase());
		const role = (user?.highestRole || '').toLowerCase();

		if (role.includes('owner')) return 4;
		if (role.includes('admin')) return 3;
		if (role.includes('mod')) return 2;
		if (role.includes('staff')) return 1;
		return 0;
	}

	function getVisibleTypingUsers(names: string[]): string[] {
		const currentUsername = ($currentUser?.username || '').toLowerCase();
		const deduped = Array.from(new Set(names.filter(Boolean)));
		const othersOnly = deduped.filter((name) => name.toLowerCase() !== currentUsername);

		return othersOnly.sort((a, b) => {
			const priorityDiff = getTypingUserPriority(b) - getTypingUserPriority(a);
			if (priorityDiff !== 0) return priorityDiff;
			return a.localeCompare(b);
		});
	}

	function getDMOtherUser(channel?: Channel): User | null {
		if (!channel || channel.type !== 'dm') return null;
		if (channel.otherUser) return channel.otherUser;

		const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
		const otherStableId = (channel.members || []).find((id: string) => id !== myStableId);
		if (!otherStableId) return null;

		if (otherStableId.startsWith('user-')) {
			const dbId = parseInt(otherStableId.substring(5), 10);
			return $users.find(u => u.dbUserId === dbId) || null;
		}
		return $users.find(u => u.id === otherStableId) || null;
	}


	async function startDMVoiceCall() {
		if (!$socket || !dmCallTargetUser || dmDirectCallActive) return;
		try {
			await startCall($socket, getUserIdentityKey(dmCallTargetUser), false, { scope: 'dm', displayName: dmCallTargetUser.username });
		} catch (error) {
			alert('Failed to start voice call. Please check microphone permissions.');
		}
	}

	async function startDMVideoCall() {
		if (!$socket || !dmCallTargetUser || dmDirectCallActive) return;
		try {
			await startCall($socket, getUserIdentityKey(dmCallTargetUser), true, { scope: 'dm', displayName: dmCallTargetUser.username });
		} catch (error) {
			alert('Failed to start video call. Please check camera and microphone permissions.');
		}
	}

	// Parse search syntax: by:username, has:image, has:video, has:file, has:link, and text content

	function parseSearchQuery(query: string): { text: string; byUser?: string; hasTypes: string[] } {
		const byUserMatch = query.match(/by:(\S+)/);
		const hasMatches = query.match(/has:(\S+)/g) || [];

		const byUser = byUserMatch ? byUserMatch[1] : undefined;
		const hasTypes = hasMatches.map(m => m.replace('has:', '').toLowerCase());

		const text = query.replace(/by:\S+/g, '').replace(/has:\S+/g, '').trim().toLowerCase();

		return { text, byUser, hasTypes };
	}

	// Filter messages based on search query
	function filterMessages(msgs: Message[], query: string, workingSetLimit: number): Message[] {
		const workingSet = msgs.length > workingSetLimit
			? msgs.slice(-workingSetLimit)
			: msgs;
		if (!query.trim()) return workingSet;

		const { text, byUser, hasTypes } = parseSearchQuery(query);

		return workingSet.filter(msg => {
			// Filter by user
			if (byUser && msg.user.toLowerCase() !== byUser.toLowerCase()) {
				return false;
			}

			// Filter by type (has:image, has:file, etc.)
			if (hasTypes.length > 0) {
				const hasMatch = hasTypes.some(type => {
					if (type === 'image' && msg.type === 'file' && msg.fileUrl?.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return true;
					if (type === 'video' && msg.type === 'file' && msg.fileUrl?.match(/\.(mp4|webm|mov)$/i)) return true;
					if (type === 'file' && msg.type === 'file') return true;
					if (type === 'link' && msg.text.match(/https?:\/\//i)) return true;
					if (type === 'gif' && msg.type === 'gif') return true;
					return false;
				});
				if (!hasMatch) return false;
			}

			// Filter by text content
			if (text && !msg.text.toLowerCase().includes(text)) {
				return false;
			}

			return true;
		});
	}

	function getWorkingSetLimit(): number {
		if (currentChannelData?.persistMessages) {
			return searchInput.trim()
				? MESSAGE_WORKING_SET_LIMIT_PERSISTENT_SEARCH
				: MESSAGE_WORKING_SET_LIMIT_PERSISTENT_IDLE;
		}
		return MESSAGE_WORKING_SET_LIMIT_EPHEMERAL;
	}

	// Reactive search
	$: filteredMessages = filterMessages(messages, searchInput, getWorkingSetLimit());
	$: if (searchInput.trim() && !searchExpanded) {
		searchExpanded = true;
	}
	$: visibleTypingUsers = getVisibleTypingUsers($typingUsers[$currentChannel] || []);
	$: if (!searchInput.trim()) {
		fullHistorySearchStatus = '';
	}
	$: searchBackfillBusy =
		Boolean(searchInput.trim()) &&
		Boolean(currentChannelData?.persistMessages) &&
		(($channelHistoryLoading[$currentChannel] || false) || ($channelLoadingOlder[$currentChannel] || false));
	$: {
		if (searchInput.trim() && currentChannelData?.persistMessages && $currentChannel && !isFullHistorySearchRunning) {
			const now = Date.now();
			if (now - lastSearchBackfillAt >= SEARCH_BACKFILL_THROTTLE_MS) {
				const hasMoreServerHistory = $channelHasMoreHistory[$currentChannel] ?? false;
				const isServerLoading = $channelHistoryLoading[$currentChannel] || false;
				if (hasMoreServerHistory && !isServerLoading) {
					lastSearchBackfillAt = now;
					loadOlderHistory($currentChannel);
				} else {
					const availableArchives = $channelAvailableArchives[$currentChannel] || [];
					const loadedArchives = $channelLoadedArchives[$currentChannel] || new Set<string>();
					const hasMoreArchiveHistory = availableArchives.length > loadedArchives.size;
					const isArchiveLoading = $channelLoadingOlder[$currentChannel] || false;
					if (hasMoreArchiveHistory && !isArchiveLoading) {
						lastSearchBackfillAt = now;
						void loadOlderMessages($currentChannel);
					}
				}
			}
		}
	}
	$: if (lastPreviewChannelId !== $currentChannel) {
		lastPreviewChannelId = $currentChannel;
		clearFilePreviews();
	}

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	$: if (messages.length) {
		scrollToBottom();
	}

	function autoResizeTextarea() {
		if (!textareaElement) return;

		// Reset height to auto to get the correct scrollHeight
		textareaElement.style.height = 'auto';

		// Set height based on content, up to max-height
		const newHeight = Math.min(textareaElement.scrollHeight, 120); // ~4 lines max
		textareaElement.style.height = `${newHeight}px`;
	}

	function handleInput() {
		autoResizeTextarea();

		// Throttle typing emissions - max once per TYPING_THROTTLE_MS
		const now = Date.now();
		if (now - lastTypingEmit >= TYPING_THROTTLE_MS) {
			sendTyping(true, $currentChannel);
			lastTypingEmit = now;
		}

		// Debounce stop typing
		if (typingTimeout) {
			clearTimeout(typingTimeout);
		}

		typingTimeout = setTimeout(() => {
			sendTyping(false, $currentChannel);
		}, 1000) as unknown as number;
	}

	function handleInputChange() {
		// Show command palette if input starts with /
		if (messageInput.startsWith('/')) {
			showCommandPalette = getMatchingCommands(messageInput).length > 0;
			showMentionSuggestions = false;
		} else {
			showCommandPalette = false;
			updateMentionSuggestions();
		}
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
		const specials = [
			{ key: 'special-all', label: '@all', value: 'all', kind: 'special' as const },
			{ key: 'special-here', label: '@here', value: 'here', kind: 'special' as const },
			{ key: 'special-everyone', label: '@everyone', value: 'everyone', kind: 'special' as const }
		].filter((entry) => entry.value.startsWith(normalizedQuery));

		const userEntries = $users
			.filter((u) => u.id !== $currentUser?.id)
			.sort((a, b) => a.username.localeCompare(b.username))
			.map((u) => ({
				key: `user-${u.id}`,
				label: `@${u.username}`,
				value: u.username,
				kind: 'user' as const
			}))
			.filter((entry) => entry.value.toLowerCase().startsWith(normalizedQuery));

		const nextSuggestions = [...specials, ...userEntries].slice(0, 8);
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
		const needsTrailingSpace = after.length === 0 || !/^[\s.,!?;:)]/.test(after);
		const insertion = needsTrailingSpace ? `${mentionText} ` : mentionText;
		const nextCursor = (before + insertion).length;

		messageInput = before + insertion + after;
		showMentionSuggestions = false;
		mentionTokenStart = -1;

		await tick();
		textareaElement.focus();
		textareaElement.setSelectionRange(nextCursor, nextCursor);
	}

	function handleKeyDown(e: KeyboardEvent) {
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

		// Command palette navigation
		if (showCommandPalette && commandPalette) {
			const handled = commandPalette.handleKeyDown(e.key);
			if (handled) {
				e.preventDefault();
				return;
			}
		}

		// Arrow up to edit last message
		if (e.key === 'ArrowUp' && !messageInput.trim() && !editingMessage) {
			e.preventDefault();
			// Find the last message from the current user
			const userMessages = messages.filter((m: Message) => m.userId === $currentUser?.id);
			if (userMessages.length > 0) {
				const lastMessage = userMessages[userMessages.length - 1];
				editingMessage = lastMessage;
				messageInput = lastMessage.text;
			}
		}
		// Escape to cancel editing/command palette
		else if (e.key === 'Escape') {
			e.preventDefault();
			if (showCommandPalette) {
				showCommandPalette = false;
			} else if (editingMessage) {
				cancelEdit();
			}
		}
		// Enter without shift sends the message
		else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
		// Shift+Enter adds a new line (default textarea behavior)
	}

	function handleCommandSelect(command: Command) {
		// Replace the / command with selected command name
		messageInput = `/${command.name} `;
		showCommandPalette = false;
		textareaElement?.focus();
	}

	function normalizePayAmountInput(rawAmount: string): string | null {
		const cleaned = rawAmount.replace(/,/g, '').replace(/^\$/, '').trim();
		if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
		const parsedAmount = Number.parseFloat(cleaned);
		if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
		return parsedAmount.toFixed(2);
	}

	function resolvePayTargetUser(identifier: string): User | null {
		const normalized = identifier.trim().replace(/^@+/, '').toLowerCase();
		if (!normalized) return null;
		return $users.find((candidate) => candidate.username.toLowerCase() === normalized) || null;
	}

	function parseWordCommandPayload(rawInput: string): {
		action: 'add' | 'view' | 'remove' | 'help';
		term?: string;
		definition?: string;
		language?: string;
	} {
		const withoutPrefix = rawInput.trim().replace(/^\/word\s*/i, '');
		if (!withoutPrefix) {
			return { action: 'help' };
		}
		const firstSpace = withoutPrefix.indexOf(' ');
		const actionRaw = (firstSpace >= 0 ? withoutPrefix.slice(0, firstSpace) : withoutPrefix).trim().toLowerCase();
		const rest = firstSpace >= 0 ? withoutPrefix.slice(firstSpace + 1).trim() : '';
		const action = actionRaw === 'add' || actionRaw === 'view' || actionRaw === 'remove' ? actionRaw : 'help';
		if (action === 'help') return { action: 'help' };

		if (action === 'add') {
			const parts = rest.split('|').map((part) => part.trim()).filter(Boolean);
			return {
				action,
				term: parts[0],
				definition: parts[1],
				language: (parts[2] || $currentLocale || 'en').toLowerCase()
			};
		}

		const parts = rest.split('|').map((part) => part.trim()).filter(Boolean);
		return {
			action,
			term: parts[0],
			language: (parts[1] || $currentLocale || 'en').toLowerCase()
		};
	}

	function getWordCommandHelp(): string {
		return [
			'Word Dictionary Commands:',
			'',
			'/word add <term> | <definition> | [language]',
			'Example: /word add がんばって | to cheer / do your best | ja',
			'',
			'/word view <term> | [language]',
			'Example: /word view がんばって | ja',
			'',
			'/word remove <term> | [language]'
		].join('\n');
	}

	async function executeCommand(commandInput: string) {
		const parsed = parseCommand(commandInput);

		if (parsed.error) {
			console.warn(parsed.error);
			return;
		}

		if (!parsed.command) return;

		const commandName = parsed.command.name;

		switch (commandName) {
			case 'help':
			case 'h':
			case '?':
				alert(`Available Commands:\n\n${formatCommandHelp()}`);
				break;

			case 'resource':
			case 'res':
			case 'r': {
				// /resource <name> [-a] [-tag tagname]
				const resourceName = parsed.args.join(' ');
				if (!resourceName) {
					alert('Resource name is required.\nUsage: /resource <name> [-a] [-tag tagname]');
					return;
				}

					const tag = typeof parsed.flags['tag'] === 'string' ? parsed.flags['tag'] : undefined;
					const newResource: Resource = {
						id: `res-${Date.now()}`,
						name: resourceName,
						type: 'note',
						storageType: 'inline',
						createdAt: Date.now(),
						updatedAt: Date.now(),
						createdBy: parsed.flags['a'] ? 'Anonymous' : ($currentUser?.username || 'Unknown'),
						isAnonymous: !!parsed.flags['a'],
						visibilityType: 'public',
						tags: tag ? [tag] : []
					};

				resources.update(r => [...r, newResource]);
				alert(`Resource "${resourceName}" created!`);
				break;
			}

			case 'search':
			case 's': {
				// /search <term> [-by username] [-has image|video|file|link]
				const searchTerm = parsed.args.join(' ');
				if (!searchTerm) {
					alert('Search term is required.\nUsage: /search <term> [-by username] [-has image|video|file|link]');
					return;
				}
				searchInput = searchTerm;
				if (parsed.flags['by']) {
					searchInput += ` by:${parsed.flags['by']}`;
				}
				if (parsed.flags['has']) {
					searchInput += ` has:${parsed.flags['has']}`;
				}
				break;
			}

			case 'pin':
			case 'p': {
				// /pin [channelName] - pin a channel by name, or current channel if no arg
				let targetChannelId = $currentChannel;
				if (parsed.args.length > 0) {
					const channelName = parsed.args.join(' ');
					const targetChannel = $channels.find(ch =>
						ch.name.toLowerCase() === channelName.toLowerCase()
					);
					if (!targetChannel) {
						alert(`Channel "${channelName}" not found!`);
						return;
					}
					targetChannelId = targetChannel.id;
				}
				pinChannel(targetChannelId);
				const channelName = $channels.find(ch => ch.id === targetChannelId)?.name || 'Channel';
				alert(`"${channelName}" pinned!`);
				break;
			}

			case 'unpin':
			case 'up': {
				// /unpin [channelName] - unpin a channel by name, or current channel if no arg
				let targetChannelId = $currentChannel;
				if (parsed.args.length > 0) {
					const channelName = parsed.args.join(' ');
					const targetChannel = $channels.find(ch =>
						ch.name.toLowerCase() === channelName.toLowerCase()
					);
					if (!targetChannel) {
						alert(`Channel "${channelName}" not found!`);
						return;
					}
					targetChannelId = targetChannel.id;
				}
				unpinChannel(targetChannelId);
				const channelName = $channels.find(ch => ch.id === targetChannelId)?.name || 'Channel';
				alert(`"${channelName}" unpinned!`);
				break;
			}

			case 'todo':
			case 'todos':
			case 'tasks': {
				// /todo [-open]
				const todoList = $todos;
				if (todoList.length === 0) {
					alert('No todos yet!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const todoText = todoList
					.map((t, i) => `${i + 1}. ${t.status === 'done' ? 'DONE' : 'OPEN'} ${t.title}`)
					.join('\n');

				const message = `My Todos${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${todoText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`My Todos:\n\n${todoText}`);
				}
				break;
			}

			case 'calendar':
			case 'cal':
			case 'events': {
				// /calendar [-open]
				const now = Date.now();
				const upcoming = $calendarEvents
					.filter(e => e.startDate >= now)
					.sort((a, b) => a.startDate - b.startDate)
					.slice(0, 10);

				if (upcoming.length === 0) {
					alert('No upcoming events!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const eventText = upcoming
					.map(e => {
						const date = new Date(e.startDate).toLocaleDateString();
						return `${e.title} - ${date}`;
					})
					.join('\n');

				const message = `Upcoming Events${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${eventText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`Upcoming Events:\n\n${eventText}`);
				}
				break;
			}

			case 'journal':
			case 'j':
			case 'diary': {
				// /journal [-open]
				const entries = $diaryEntries.slice(0, 5);

				if (entries.length === 0) {
					alert('No journal entries yet!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const entryText = entries
					.map(e => {
						const date = new Date(e.createdAt).toLocaleDateString();
						return `${date}: ${e.content.substring(0, 100)}...`;
					})
					.join('\n');

				const message = `Recent Journal Entries${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${entryText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`Recent Journal Entries:\n\n${entryText}`);
				}
				break;
			}

			case 'projects':
			case 'proj': {
				// /projects [-open]
				const projectList = $projects;

				if (projectList.length === 0) {
					alert('No projects yet!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const projText = projectList
					.map(p => `${p.name} - ${p.status}`)
					.join('\n');

				const message = `My Projects${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${projText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`My Projects:\n\n${projText}`);
				}
				break;
			}

			case 'art':
			case 'a':
			case 'graph':
			case 'resources': {
				// /art - Navigate to Art/Knowledge Graph portal
				window.location.href = '/art';
				break;
			}

			case 'business':
			case 'b':
			case 'hub':
			case 'tasks': {
				// /business - Navigate to Business Hub
				window.location.href = '/business';
				break;
			}

			case 'mainchat':
			case 'main':
			case 'chat':
			case 'home': {
				// /mainchat - Return to main Wabi Chat
				window.location.href = '/';
				break;
			}

			case 'dm':
			case 'message':
			case 'msg': {
				const username = parsed.args.join(' ');
				if (!username) {
					alert('Please specify a username.\nUsage: /dm <username>');
					return;
				}

				const targetUser = $users.find(u =>
					u.username.toLowerCase() === username.toLowerCase()
				);

				if (!targetUser) {
					alert(`User "${username}" not found or offline.`);
					return;
				}

				// Check if DM already exists using stable IDs
				const dmId = getDMChannelIdForUser($currentUser, targetUser);
				const existingDM = $channels.find(ch => ch.id === dmId);

				if (existingDM) {
					// Open existing DM in right panel
					dmPanelSignal.set({ channelId: dmId, otherUser: targetUser });
				} else {
					// Create new DM (will auto-open via dmPanelSignal)
					createDM(targetUser.id);
				}
				break;
			}

			case 'pay': {
				if (!paymentButtonEnabled) {
					alert('Sign in with a registered account to create payments.');
					break;
				}

				const userFlagValue =
					typeof parsed.flags['user'] === 'string'
						? parsed.flags['user']
						: typeof parsed.flags['u'] === 'string'
							? parsed.flags['u']
							: '';
				const amountFlagValue =
					typeof parsed.flags['amt'] === 'string'
						? parsed.flags['amt']
						: typeof parsed.flags['amount'] === 'string'
							? parsed.flags['amount']
							: '';

				let requestedUser = userFlagValue.trim();
				let requestedAmount = amountFlagValue.trim();

				for (const arg of parsed.args) {
					const amountCandidate = normalizePayAmountInput(arg);
					if (!requestedAmount && amountCandidate) {
						requestedAmount = amountCandidate;
						continue;
					}
					if (!requestedUser) {
						requestedUser = arg;
					}
				}

				const normalizedAmount = requestedAmount ? normalizePayAmountInput(requestedAmount) : null;
				if (requestedAmount && !normalizedAmount) {
					alert('Invalid amount.\nUsage: /pay [@username] [amount] [-user username] [-amt 12.34]');
					break;
				}

				let targetUser: User | null = null;
				if (requestedUser) {
					targetUser = resolvePayTargetUser(requestedUser);
					if (!targetUser) {
						alert(`User "${requestedUser}" not found.\nUsage: /pay [@username] [amount]`);
						break;
					}
				}

				openPaymentSheet({
					amountInput: normalizedAmount,
					description: targetUser ? `Payment request for @${targetUser.username}` : '',
					customerRef: ''
				});
				break;
			}

			case 'logout':
			case 'signout':
			case 'exit': {
				// /logout - Log out and clear session
				dispatch('logout');
				break;
			}

			case 'word':
			case 'dict':
			case 'dictionary': {
				const payload = parseWordCommandPayload(commandInput);
				if (payload.action === 'help' || !payload.term) {
					alert(getWordCommandHelp());
					break;
				}

				if (payload.action === 'view') {
					try {
						const entries = await lookupDictionary(payload.term, payload.language || 'en', 5);
						if (entries.length === 0) {
							alert(`No dictionary entry found for "${payload.term}" (${payload.language || 'en'}).`);
							break;
						}
						const lines = entries.map((entry, index) => {
							const editor = entry.createdByUsername ? ` (by ${entry.createdByUsername})` : '';
							return `${index + 1}. ${entry.term} [${entry.language}] -> ${entry.definition}${editor}`;
						});
						alert(lines.join('\n'));
					} catch (error) {
						alert(error instanceof Error ? error.message : 'Failed to lookup dictionary entry.');
					}
					break;
				}

				if (payload.action === 'add') {
					if (!payload.definition) {
						alert(getWordCommandHelp());
						break;
					}
					const authToken = getAuthToken();
					if (!authToken) {
						alert('Login is required to add dictionary entries.');
						break;
					}
					try {
						const saved = await upsertDictionaryEntry(
							authToken,
							payload.term,
							payload.definition,
							payload.language || 'en'
						);
						alert(`Saved: ${saved.term} [${saved.language}] -> ${saved.definition}`);
					} catch (error) {
						alert(error instanceof Error ? error.message : 'Failed to save dictionary entry.');
					}
					break;
				}

				if (payload.action === 'remove') {
					const authToken = getAuthToken();
					if (!authToken) {
						alert('Login is required to remove dictionary entries.');
						break;
					}
					try {
						await deleteDictionaryEntry(authToken, payload.term, payload.language || 'en');
						alert(`Removed dictionary entry for "${payload.term}" (${payload.language || 'en'}).`);
					} catch (error) {
						alert(error instanceof Error ? error.message : 'Failed to remove dictionary entry.');
					}
				}
				break;
			}

			default:
				console.warn(`Unknown command: ${commandName}`);
		}
	}

	function handleSubmit() {
		if (messageInput.trim()) {
			if (editingMessage) {
				// Edit the existing message
				editMessage($currentChannel, editingMessage.id, messageInput.trim());
				editingMessage = null;
			} else {
				const trimmedMessage = messageInput.trim();
				const aliasExpandedMessage = expandInputWithChatAlias(trimmedMessage);
				const outgoingFilterResult = applyChatFilter(aliasExpandedMessage, 'outgoing');

				if (outgoingFilterResult.hidden) {
					const blockedTerms = outgoingFilterResult.matchedTerms.join(', ');
					alert(
						blockedTerms
							? `Message blocked by Chat Filter: ${blockedTerms}`
							: 'Message blocked by Chat Filter.'
					);
					return;
				}

				const finalMessage = outgoingFilterResult.text.trim();
				if (!finalMessage) {
					alert('Message is empty after Chat Filter processing.');
					return;
				}

				const normalizedSentenceCaseMessage = applyWriteUpperCase(
					finalMessage,
					writeUpperCaseEnabled
				);

				// Check if it's a command
				if (normalizedSentenceCaseMessage.startsWith('/')) {
					void executeCommand(normalizedSentenceCaseMessage);
					messageInput = '';
					return;
				}

				const normalizedMessage = replaceEmojiShortcodesWithUnicode(
					normalizedSentenceCaseMessage,
					$emojis,
					unicodeEmojisEnabled
				);

				if (splitLargeMessagesEnabled && normalizedMessage.length > splitLargeMessagesChunkSize) {
					const chunks = splitMessageForSending(normalizedMessage, splitLargeMessagesChunkSize);
					if (chunks.length === 0) {
						alert('Unable to split message into chunks.');
						return;
					}
					for (const [index, chunk] of chunks.entries()) {
						sendMessage($currentChannel, chunk, 'text', {
							replyTo: index === 0 ? replyingTo?.id : undefined,
							isSpoiler: markAsSpoiler
						});
					}
				} else {
					// Check if message is ONLY emoji syntax (e.g., ":smile:" or ":smile::heart:")
					const emojiOnlyPattern = /^(?::[a-zA-Z0-9_+-]+:)+$/;
					const isEmojiOnly = emojiOnlyPattern.test(normalizedMessage);

					if (isEmojiOnly) {
						// Extract emoji names and find their URLs
						const emojiNames =
							normalizedMessage.match(/:[a-zA-Z0-9_+-]+:/g)?.map((e) => e.slice(1, -1)) ||
							[];
						const firstEmojiName = emojiNames[0];
						const firstEmoji = $emojis.find((e) => e.name === firstEmojiName);

						// Send as emoji type for large display
						sendMessage($currentChannel, normalizedMessage, 'emoji', {
							emojiUrl: firstEmoji?.url,
							emojiName: firstEmojiName,
							replyTo: replyingTo?.id,
							isSpoiler: markAsSpoiler
						});
					} else {
						// Send as regular text message
						sendMessage($currentChannel, normalizedMessage, 'text', {
							replyTo: replyingTo?.id,
							isSpoiler: markAsSpoiler
						});
					}
				}
				replyingTo = null;
			}
			messageInput = '';
			showMentionSuggestions = false;
			showMediaMenu = false;
			sendTyping(false, $currentChannel);

			if (typingTimeout) {
				clearTimeout(typingTimeout);
			}

			// Reset textarea height
			if (textareaElement) {
				textareaElement.style.height = 'auto';
			}
			textareaElement?.focus();
		}
	}

	function resolveOutgoingAttachmentCaption(): string | null {
		if (!gifCaptionerEnabled) return '';
		const captionSource = gifCaptionerDedicatedCaptionFieldEnabled ? gifCaptionInput : messageInput;
		const trimmedMessage = captionSource.trim();
		if (!trimmedMessage) return '';
		if (trimmedMessage.length > MAX_GIF_CAPTION_LENGTH) {
			alert(`GIF caption cannot exceed ${MAX_GIF_CAPTION_LENGTH} characters.`);
			return null;
		}
		const aliasExpandedMessage = expandInputWithChatAlias(trimmedMessage);
		const outgoingFilterResult = applyChatFilter(aliasExpandedMessage, 'outgoing');

		if (outgoingFilterResult.hidden) {
			const blockedTerms = outgoingFilterResult.matchedTerms.join(', ');
			alert(
				blockedTerms
					? `Message blocked by Chat Filter: ${blockedTerms}`
					: 'Message blocked by Chat Filter.'
			);
			return null;
		}

		const finalCaption = outgoingFilterResult.text.trim();
		if (!finalCaption && aliasExpandedMessage.trim()) {
			alert('Message is empty after Chat Filter processing.');
			return null;
		}
		const normalizedSentenceCaseCaption = applyWriteUpperCase(
			finalCaption,
			writeUpperCaseEnabled
		);
		if (normalizedSentenceCaseCaption.length > MAX_GIF_CAPTION_LENGTH) {
			alert(`GIF caption cannot exceed ${MAX_GIF_CAPTION_LENGTH} characters.`);
			return null;
		}

		const normalizedCaption = replaceEmojiShortcodesWithUnicode(
			normalizedSentenceCaseCaption,
			$emojis,
			unicodeEmojisEnabled
		);
		if (normalizedCaption.length > MAX_GIF_CAPTION_LENGTH) {
			alert(`GIF caption cannot exceed ${MAX_GIF_CAPTION_LENGTH} characters.`);
			return null;
		}
		return normalizedCaption;
	}

	function cancelEdit() {
		editingMessage = null;
		messageInput = '';

		// Reset textarea height
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	function handleGifSelect(event: CustomEvent<string>) {
		const caption = resolveOutgoingAttachmentCaption();
		if (caption === null) return;
		sendMessage($currentChannel, caption, 'gif', {
			gifUrl: event.detail,
			replyTo: replyingTo?.id,
			isSpoiler: markAsSpoiler
		});
		replyingTo = null;
		if (gifCaptionerDedicatedCaptionFieldEnabled) {
			gifCaptionInput = '';
		} else {
			messageInput = '';
		}
		showMentionSuggestions = false;
		showEmojiPicker = false;
		showMediaMenu = false;
		sendTyping(false, $currentChannel);
		if (typingTimeout) {
			clearTimeout(typingTimeout);
		}
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
		textareaElement?.focus();
	}

	function handleEmojiSelect(event: CustomEvent<{ emoji: Emoji }>) {
		const emoji = event.detail.emoji;
		showEmojiPicker = false;
		showMediaMenu = false;

		// Insert emoji syntax into the composer and let the user send explicitly.
		const emojiToken = `:${emoji.name}:`;
		const shouldAddSpace = messageInput.length > 0 && !/\s$/.test(messageInput);
		messageInput = shouldAddSpace ? `${messageInput} ${emojiToken}` : `${messageInput}${emojiToken}`;
		textareaElement?.focus();
	}

	function handleReply(message: Message) {
		replyingTo = message;
		textareaElement?.focus();
	}

	function handleQuickMention(message: Message) {
		const mentionToken = `@${message.user}`;
		const needsSpace = messageInput.length > 0 && !/\s$/.test(messageInput);
		messageInput = needsSpace ? `${messageInput} ${mentionToken} ` : `${mentionToken} `;
		showMentionSuggestions = false;
		textareaElement?.focus();
	}

	function cancelReply() {
		replyingTo = null;
	}

	function revokePreviewUrl(preview?: string): void {
		if (!preview || !preview.startsWith('blob:')) return;
		try {
			URL.revokeObjectURL(preview);
		} catch {
			// no-op
		}
	}

	function clearFilePreviews(): void {
		for (const item of filePreviews) {
			revokePreviewUrl(item.preview);
			compressionMetadataByFile.delete(item.file);
		}
		filePreviews = [];
		selectedFiles = [];
	}

	function enforcePreviewBudget(): void {
		if (filePreviews.length <= MAX_FILE_PREVIEW_IMAGES) return;
		const overflow = filePreviews.slice(0, filePreviews.length - MAX_FILE_PREVIEW_IMAGES);
		for (const item of overflow) {
			revokePreviewUrl(item.preview);
		}
		filePreviews = filePreviews.slice(-MAX_FILE_PREVIEW_IMAGES);
		selectedFiles = selectedFiles.slice(-MAX_FILE_PREVIEW_IMAGES);
	}

	function buildPreviewEntries(files: File[]): { file: File; preview?: string }[] {
		return files.map((file) => {
			if (file.type.startsWith('image/')) {
				const preview = URL.createObjectURL(file);
				return { file, preview };
			}
			return { file };
		});
	}

	function formatFileMb(bytes: number): string {
		return (bytes / 1024 / 1024).toFixed(1);
	}

	function formatSignedMb(bytes: number): string {
		const sign = bytes >= 0 ? '+' : '-';
		return `${sign}${formatFileMb(Math.abs(bytes))} MB`;
	}

	function getCompressionSuggestionCopy(
		fileSize: number,
		runtime: VideoCompressionRuntime,
		estimate: VideoCompressionEstimate | null
	): string {
		if (!estimate) return '';
		const runtimeProfile = getVideoCompressionRuntimeProfile(runtime);
		const nearThresholdMargin = Math.max(runtimeProfile.promptBytes * 0.18, 5 * 1024 * 1024);
		const nearThreshold = fileSize <= runtimeProfile.promptBytes + nearThresholdMargin;
		if (nearThreshold && estimate.estimatedReductionRatio <= 0.2) {
			return 'This file is only slightly above the compression prompt threshold. Keeping the original may be fine on strong connections.';
		}
		if (estimate.estimatedReductionRatio >= 0.45) {
			return 'This preset is expected to significantly reduce upload size.';
		}
		if (estimate.estimatedReductionRatio <= 0.08) {
			return 'Only a small reduction is expected with this preset. Keeping the original may preserve better quality.';
		}
		return '';
	}

	function resolveVideoCompressionRuntime(): VideoCompressionRuntime {
		if (!isTauriRuntime()) return 'web';
		const runtime = getTauriPlatform();
		if (runtime === 'android' || runtime === 'ios' || runtime === 'desktop') {
			return runtime;
		}
		return 'desktop';
	}

	function applyCompressionRuntimeProfile(runtime: VideoCompressionRuntime): void {
		const profile = getVideoCompressionRuntimeProfile(runtime);
		compressionDialogRuntime = runtime;
		compressionDialogRuntimeLabel = profile.label;
		compressionDialogPresetOptions = getVideoCompressionPresetOptions(runtime);
		const preferredPreset = getDefaultVideoCompressionPreset(runtime);
		const presetAllowed = compressionDialogPresetOptions.some((option) => option.id === preferredPreset);
		compressionDialogPreset = presetAllowed ? preferredPreset : profile.recommendedPreset;
	}

	function resetCompressionDialogState(): void {
		if (compressionAbortController) {
			try {
				compressionAbortController.abort();
			} catch {
				// no-op
			}
		}
		compressionDialogOpen = false;
		compressionDialogFile = null;
		compressionDialogInputMetadata = null;
		compressionDialogEstimate = null;
		compressionDialogSuggestionCopy = '';
		compressionDialogError = '';
		compressionDialogProgress = 0;
		compressionDialogBusy = false;
		compressionAbortController = null;
		compressionDialogResolve = null;
	}

	function resolveCompressionDialog(result: File | null): void {
		const resolve = compressionDialogResolve;
		resetCompressionDialogState();
		resolve?.(result);
	}

	function openCompressionDialog(file: File, runtime: VideoCompressionRuntime): Promise<File | null> {
		return new Promise((resolve) => {
			if (compressionDialogResolve) {
				resolveCompressionDialog(null);
			}
			applyCompressionRuntimeProfile(runtime);
			compressionDialogOpen = true;
			compressionDialogFile = file;
			compressionDialogInputMetadata = null;
			compressionDialogEstimate = null;
			compressionDialogSuggestionCopy = '';
			compressionDialogError = '';
			compressionDialogProgress = 0;
			compressionDialogBusy = false;
			compressionDialogResolve = resolve;

			const targetFile = file;
			void sampleVideoCompressionInputMetadata(targetFile)
				.then((metadata) => {
					if (!compressionDialogOpen || compressionDialogFile !== targetFile) return;
					compressionDialogInputMetadata = metadata;
				})
				.catch(() => {
					// metadata sampling is best-effort
				});
		});
	}

	function keepOriginalVideoFile(): void {
		if (compressionDialogFile) {
			compressionMetadataByFile.delete(compressionDialogFile);
			void reportVideoCompressionTelemetry({
				outcome: 'skipped',
				runtime: compressionDialogRuntime,
				preset: compressionDialogPreset,
				inputBytes: compressionDialogFile.size,
				failureCode: 'kept_original'
			});
		}
		resolveCompressionDialog(compressionDialogFile);
	}

	function removeVideoFileFromQueue(): void {
		if (compressionDialogFile) {
			compressionMetadataByFile.delete(compressionDialogFile);
			void reportVideoCompressionTelemetry({
				outcome: 'skipped',
				runtime: compressionDialogRuntime,
				preset: compressionDialogPreset,
				inputBytes: compressionDialogFile.size,
				failureCode: 'removed_from_queue'
			});
		}
		resolveCompressionDialog(null);
	}

	function cancelCompressionRun(): void {
		if (!compressionDialogBusy) return;
		compressionAbortController?.abort();
	}

	async function runVideoCompression(): Promise<void> {
		if (!compressionDialogFile || compressionDialogBusy) return;
		compressionDialogBusy = true;
		compressionDialogError = '';
		compressionDialogProgress = 0;
		const inputFile = compressionDialogFile;
		const runtimeProfile = getVideoCompressionRuntimeProfile(compressionDialogRuntime);
		const selectedPreset = compressionDialogPresetOptions.some(
			(option) => option.id === compressionDialogPreset
		)
			? compressionDialogPreset
			: runtimeProfile.recommendedPreset;
		if (selectedPreset !== compressionDialogPreset) {
			compressionDialogPreset = selectedPreset;
		}
		const startedAt = Date.now();
		const abortController = new AbortController();
		compressionAbortController = abortController;

		try {
			const compressed = await compressVideoFileForUpload(inputFile, {
				preset: selectedPreset,
				timeoutMs: runtimeProfile.timeoutMs,
				signal: abortController.signal,
				onProgress: (percent) => {
					compressionDialogProgress = Math.min(100, Math.max(0, Math.round(percent)));
				}
			});
			const inputMetadata = compressionDialogInputMetadata;
			const estimate = compressionDialogEstimate;
			compressionMetadataByFile.delete(inputFile);
			compressionMetadataByFile.set(compressed, {
				scheme: 'wabi-video-compression-v1',
				runtime: compressionDialogRuntime,
				preset: selectedPreset,
				originalSize: inputFile.size,
				compressedSize: compressed.size,
				codec: inferVideoCodecHint(compressed.type || '', compressed.name),
				mimeType: compressed.type || 'video/webm',
				durationMs: inputMetadata
					? Math.max(0, Math.round(inputMetadata.durationSeconds * 1000))
					: Date.now() - startedAt,
				estimatedOutputBytes: estimate?.estimatedBytes
			});
			void reportVideoCompressionTelemetry({
				outcome: 'success',
				runtime: compressionDialogRuntime,
				preset: selectedPreset,
				inputBytes: inputFile.size,
				outputBytes: compressed.size,
				durationMs: Date.now() - startedAt
			});
			resolveCompressionDialog(compressed);
			return;
		} catch (error) {
			const failureCode = abortController.signal.aborted
				? 'cancelled'
				: classifyVideoCompressionFailure(error);
			const cancelled = failureCode === 'cancelled';
			void reportVideoCompressionTelemetry({
				outcome: cancelled ? 'cancelled' : 'failure',
				runtime: compressionDialogRuntime,
				preset: selectedPreset,
				inputBytes: inputFile.size,
				durationMs: Date.now() - startedAt,
				failureCode
			});
			if (cancelled) {
				compressionDialogError = 'Compression was cancelled.';
			} else if (failureCode === 'timeout') {
				compressionDialogError = 'Compression timed out. Try a lower preset or keep the original file.';
			} else {
				compressionDialogError = error instanceof Error ? error.message : 'Compression failed.';
			}
		} finally {
			if (compressionAbortController === abortController) {
				compressionAbortController = null;
			}
			compressionDialogBusy = false;
		}
	}

	async function maybeCompressVideoFile(file: File): Promise<File | null> {
		const runtime = resolveVideoCompressionRuntime();
		const runtimeProfile = getVideoCompressionRuntimeProfile(runtime);
		if (!runtimeProfile.enabled) return file;
		if (!isVideoCompressionEnabled()) return file;
		if (!isVideoFile(file)) return file;
		if (runtimeProfile.maxInputBytes !== null && file.size > runtimeProfile.maxInputBytes) {
			void reportVideoCompressionTelemetry({
				outcome: 'skipped',
				runtime,
				preset: getDefaultVideoCompressionPreset(runtime),
				inputBytes: file.size,
				failureCode: 'input_above_runtime_limit'
			});
			alert(
				`"${file.name}" is ${formatFileMb(file.size)} MB. ${runtimeProfile.label} runtime keeps very large videos uncompressed to reduce device heat and instability.`
			);
			return file;
		}
		if (file.size < runtimeProfile.promptBytes) return file;
		return openCompressionDialog(file, runtime);
	}

	async function prepareIncomingFiles(files: File[]): Promise<File[]> {
		for (const file of files) {
			if (file.size > MAX_UPLOAD_FILE_BYTES) {
				alert(
					`File too large! Maximum size is 1GB per file. "${file.name}" is ${formatFileMb(file.size)}MB`
				);
				return [];
			}
		}

		const prepared: File[] = [];
		for (const file of files) {
			const candidate = await maybeCompressVideoFile(file);
			if (candidate) prepared.push(candidate);
		}
		return prepared;
	}

	function applySelectedFiles(files: File[], mode: 'replace' | 'append'): void {
		if (mode === 'replace') {
			clearFilePreviews();
			selectedFiles = files;
			filePreviews = buildPreviewEntries(files);
			enforcePreviewBudget();
			return;
		}

		selectedFiles = [...selectedFiles, ...files];
		filePreviews = [...filePreviews, ...buildPreviewEntries(files)];
		enforcePreviewBudget();
	}

	async function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);

		if (files.length === 0) {
			console.log('No files selected');
			return;
		}

		console.log('Files selected:', files.length);
		const preparedFiles = await prepareIncomingFiles(files);
		if (preparedFiles.length > 0) {
			applySelectedFiles(preparedFiles, 'replace');
		}

		input.value = '';
		return;
	}

	function removeFile(index: number) {
		const removed = filePreviews[index];
		revokePreviewUrl(removed?.preview);
		if (removed?.file) {
			compressionMetadataByFile.delete(removed.file);
		}
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
		filePreviews = filePreviews.filter((_, i) => i !== index);
	}

	function cancelUpload() {
		clearFilePreviews();
	}

	function handleDragEnter(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		dragCounter++;
		if (e.dataTransfer?.types.includes('Files')) {
			isDragging = true;
		}
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		dragCounter--;
		if (dragCounter === 0) {
			isDragging = false;
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		isDragging = false;
		dragCounter = 0;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;
		const preparedFiles = await prepareIncomingFiles(files);
		if (preparedFiles.length > 0) {
			applySelectedFiles(preparedFiles, 'replace');
		}
	}

	async function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;

		// Check for files/images in clipboard
		const files: File[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) {
					e.preventDefault(); // Prevent default paste
					files.push(file);
				}
			}
		}

		// If files found, add to selectedFiles (reuse existing upload logic)
		if (files.length > 0) {
			const preparedFiles = await prepareIncomingFiles(files);
			if (preparedFiles.length > 0) {
				applySelectedFiles(preparedFiles, 'append');
			}
			return;
		}

		// If no files, check if text content exists
		const text = e.clipboardData?.getData('text');
		if (text && text.trim()) {
			// Only send typing indicator if actual text content exists
			handleInput();
		}
		// If empty paste (no files, no text), do nothing - prevents false typing
	}

	async function uploadSelectedFiles() {
		if (selectedFiles.length === 0) return;

		const activeChannel = $channels.find(ch => ch.id === $currentChannel);
		const dmOtherUser = activeChannel?.type === 'dm' ? getDMOtherUser(activeChannel) : null;
		const dmOtherDbUserId = typeof dmOtherUser?.dbUserId === 'number' ? dmOtherUser.dbUserId : null;
		const authToken = getAuthToken();
		const dmPrivacyMode = activeChannel?.type === 'dm' ? getDMPrivacyMode(activeChannel.id) : null;
		const requiresEncryptedDmAttachment = activeChannel?.type === 'dm' && dmPrivacyMode !== 'open';
		if (requiresEncryptedDmAttachment) {
			if (!dmOtherDbUserId || !authToken || !isE2EAvailable()) {
				alert('This DM is in sealed/private mode. File upload requires E2E encryption and was blocked.');
				return;
			}
		}

		isUploading = true;
		uploadStatusLabel = get(_)('chat.upload.uploading');
		const totalFiles = selectedFiles.length;
		let completedFiles = 0;

		try {
			const serverUrl = getServerUrl();

			console.log('Upload serverUrl:', serverUrl);
			console.log('Upload URL will be:', `${serverUrl}/api/upload`);

			// Upload all files and collect their URLs
			const uploadedFiles: {
				fileUrl: string;
				fileName: string;
				fileSize: number;
				attachmentStorage?: {
					scheme: 'wabi-storage-v1';
					compressed: boolean;
					codec: 'identity' | 'gzip';
					originalSize: number;
					storedSize: number;
					atRestEncrypted: boolean;
				};
				attachmentEncryption?: {
					scheme: 'dm-e2ee-v1';
					iv: string;
					mimeType?: string;
					originalSize?: number;
				};
			}[] = [];

			const canEncryptDmAttachment =
				requiresEncryptedDmAttachment &&
				!!dmOtherDbUserId &&
				!!authToken &&
				isE2EAvailable();

			for (const file of selectedFiles) {
				let uploadFile = file;
				let attachmentEncryption:
					| { scheme: 'dm-e2ee-v1'; iv: string; mimeType?: string; originalSize?: number }
					| undefined;
				let persistentResume = true;
				let videoCompressionMetadata = compressionMetadataByFile.get(file);

				if (canEncryptDmAttachment && authToken && dmOtherDbUserId) {
					const encrypted = await encryptDMFile(file, dmOtherDbUserId, authToken);
					if (!encrypted) {
						alert('This DM is in sealed/private mode. Encryption failed, so upload was cancelled.');
						isUploading = false;
						uploadStatusLabel = '';
						uploadProgress = 0;
						return;
					}
					uploadFile = encrypted.encryptedFile;
					attachmentEncryption = {
						scheme: 'dm-e2ee-v1',
						iv: encrypted.iv,
						mimeType: encrypted.mimeType,
						originalSize: encrypted.originalSize
					};
					// Ciphertext is randomized; cross-reload resume can't safely assume identical bytes.
					persistentResume = false;
					videoCompressionMetadata = undefined;
				}

				const result = await uploadFileResumable(
					uploadFile,
					$currentChannel,
					(fileProgressPercent) => {
						const overallProgress = ((completedFiles + fileProgressPercent / 100) / totalFiles) * 100;
						uploadProgress = Math.round(overallProgress);
					},
					persistentResume,
					videoCompressionMetadata
				);
				completedFiles++;
				uploadedFiles.push({
					fileUrl: result.fileUrl,
					fileName: file.name,
					fileSize: file.size,
					attachmentStorage: result.attachmentStorage,
					attachmentEncryption
				});
			}

			// Send a single message with all uploaded files
			if (uploadedFiles.length === 1) {
				// Single file - use old format for backward compatibility
				sendMessage($currentChannel, messageInput.trim() || `Shared: ${uploadedFiles[0].fileName}`, 'file', {
					fileUrl: uploadedFiles[0].fileUrl,
					fileName: uploadedFiles[0].fileName,
					fileSize: uploadedFiles[0].fileSize,
					attachmentStorage: uploadedFiles[0].attachmentStorage,
					attachmentEncryption: uploadedFiles[0].attachmentEncryption,
					replyTo: replyingTo?.id,
					isSpoiler: markAsSpoiler
				});
			} else {
				// Multiple files - use new format
				sendMessage($currentChannel, messageInput.trim() || `Shared ${uploadedFiles.length} files`, 'file', {
					files: uploadedFiles,
					replyTo: replyingTo?.id,
					isSpoiler: markAsSpoiler
				});
			}

			console.log('All files uploaded');
			messageInput = '';
			replyingTo = null;
			clearFilePreviews();
			isUploading = false;
			uploadStatusLabel = '';
			uploadProgress = 0;
			textareaElement?.focus();
		} catch (error) {
			console.error('Upload error:', error);
			alert('Failed to upload files. Please try again.');
			isUploading = false;
			uploadStatusLabel = '';
			uploadProgress = 0;
		}
	}

	function getUploadAuthHeaders(includeJsonContentType = false): Record<string, string> {
		const headers: Record<string, string> = {};
		if (includeJsonContentType) {
			headers['Content-Type'] = 'application/json';
		}
		const authToken = getAuthToken();
		if (authToken) {
			headers['Authorization'] = `Bearer ${authToken}`;
			return headers;
		}
		const sessionId = getGuestSessionId();
		if (sessionId) {
			headers['X-Session-Id'] = sessionId;
		}
		return headers;
	}

	function getResumeStorageKey(channelId: string, file: File): string {
		return `upload-resume:${channelId}:${file.name}:${file.size}:${file.lastModified}`;
	}

	async function uploadFileResumable(
		file: File,
		channelId: string,
		onProgress: (fileProgressPercent: number) => void,
		allowPersistentResume = true,
		videoCompression?: UploadVideoCompressionMetadata
	): Promise<{
		fileUrl: string;
		fileName: string;
		fileSize: number;
		attachmentStorage?: {
			scheme: 'wabi-storage-v1';
			compressed: boolean;
			codec: 'identity' | 'gzip';
			originalSize: number;
			storedSize: number;
			atRestEncrypted: boolean;
		};
	}> {
		const serverUrl = getServerUrl();
		const resumeKey = getResumeStorageKey(channelId, file);
		const previousUploadId = allowPersistentResume ? (localStorage.getItem(resumeKey) || undefined) : undefined;

		const initResponse = await fetch(`${serverUrl}/api/upload/resumable/init`, {
			method: 'POST',
			headers: getUploadAuthHeaders(true),
			credentials: 'include',
			body: JSON.stringify({
				uploadId: previousUploadId,
				fileName: file.name,
				fileSize: file.size,
				mimeType: file.type || 'application/octet-stream',
				channelId,
				videoCompression: videoCompression || null
			})
		});
		if (!initResponse.ok) {
			throw new Error(`Resumable init failed (${initResponse.status})`);
		}

		const initResult = await initResponse.json();
		const uploadId = initResult.uploadId as string;
		let uploadToken = initResult.uploadToken as string;
		if (allowPersistentResume) {
			localStorage.setItem(resumeKey, uploadId);
		}

		if (initResult.completed && initResult.fileUrl) {
			if (allowPersistentResume) localStorage.removeItem(resumeKey);
			return {
				fileUrl: initResult.fileUrl as string,
				fileName: file.name,
				fileSize: file.size,
				attachmentStorage: initResult.attachmentStorage as
					| {
							scheme: 'wabi-storage-v1';
							compressed: boolean;
							codec: 'identity' | 'gzip';
							originalSize: number;
							storedSize: number;
							atRestEncrypted: boolean;
					  }
					| undefined
			};
		}

		let uploadedBytes = Number(initResult.uploadedBytes || 0);
		onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);

		while (uploadedBytes < file.size) {
			const chunkEnd = Math.min(uploadedBytes + RESUMABLE_UPLOAD_CHUNK_SIZE, file.size);
			const chunkBlob = file.slice(uploadedBytes, chunkEnd);

			let uploadedThisChunk = false;
			let attempt = 0;
			while (!uploadedThisChunk && attempt < RESUMABLE_UPLOAD_MAX_RETRIES) {
				attempt++;
				try {
					const chunkResponse = await fetch(
						`${serverUrl}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(uploadId)}&offset=${uploadedBytes}&uploadToken=${encodeURIComponent(uploadToken)}`,
						{
							method: 'PUT',
							headers: getUploadAuthHeaders(),
							credentials: 'include',
							body: chunkBlob
						}
					);
					if (chunkResponse.status === 403) {
						const refreshResponse = await fetch(`${serverUrl}/api/upload/resumable/init`, {
							method: 'POST',
							headers: getUploadAuthHeaders(true),
							credentials: 'include',
							body: JSON.stringify({
								uploadId,
								fileName: file.name,
								fileSize: file.size,
								mimeType: file.type || 'application/octet-stream',
								channelId,
								videoCompression: videoCompression || null
							})
						});
						if (!refreshResponse.ok) {
							throw new Error(`Upload token refresh failed (${refreshResponse.status})`);
						}
						const refresh = await refreshResponse.json();
						uploadToken = refresh.uploadToken as string;
						uploadedBytes = Number(refresh.uploadedBytes || uploadedBytes);
						onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);
						uploadedThisChunk = true;
						break;
					}

					if (chunkResponse.status === 409) {
						const conflict = await chunkResponse.json();
						const expectedOffset = Number(conflict.expectedOffset);
						if (Number.isFinite(expectedOffset) && expectedOffset >= 0) {
							uploadedBytes = expectedOffset;
							if (conflict.uploadToken) {
								uploadToken = conflict.uploadToken as string;
							}
							onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);
							uploadedThisChunk = true;
							break;
						}
					}

					if (!chunkResponse.ok) {
						throw new Error(`Chunk upload failed (${chunkResponse.status})`);
					}

					const chunkResult = await chunkResponse.json();
					uploadedBytes = Number(chunkResult.uploadedBytes || uploadedBytes);
					if (chunkResult.uploadToken) {
						uploadToken = chunkResult.uploadToken as string;
					}
					onProgress((uploadedBytes / Math.max(file.size, 1)) * 100);
					uploadedThisChunk = true;
				} catch (error) {
					if (attempt >= RESUMABLE_UPLOAD_MAX_RETRIES) {
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, attempt * 400));
				}
			}
		}

		const completeResponse = await fetch(`${serverUrl}/api/upload/resumable/complete`, {
			method: 'POST',
			headers: getUploadAuthHeaders(true),
			credentials: 'include',
			body: JSON.stringify({ uploadId, uploadToken })
		});
		if (!completeResponse.ok) {
			throw new Error(`Resumable complete failed (${completeResponse.status})`);
		}

		const completeResult = await completeResponse.json();
		if (allowPersistentResume) localStorage.removeItem(resumeKey);

		return {
			fileUrl: completeResult.fileUrl as string,
			fileName: file.name,
			fileSize: file.size,
			attachmentStorage: completeResult.attachmentStorage as
				| {
						scheme: 'wabi-storage-v1';
						compressed: boolean;
						codec: 'identity' | 'gzip';
						originalSize: number;
						storedSize: number;
						atRestEncrypted: boolean;
				  }
				| undefined
		};
	}

	// Handle photo capture
	async function handlePhotoCapture(event: CustomEvent<Blob>) {
		const blob = event.detail;
		const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });

		// Validate file size (10MB limit)
		if (file.size > 10 * 1024 * 1024) {
			alert('Photo too large (max 10MB). Please try again.');
			return;
		}

		clearFilePreviews();
		selectedFiles = [file];
		filePreviews = buildPreviewEntries([file]);
		await uploadSelectedFiles();
		showCameraCapture = false;
		showMediaMenu = false;
	}

	// Handle audio recording
	async function handleAudioSend(event: CustomEvent<Blob>) {
		const blob = event.detail;
		const ext = blob.type.includes('webm') ? 'webm' : 'm4a';
		const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: blob.type });

		// Validate file size (10MB limit)
		if (file.size > 10 * 1024 * 1024) {
			alert('Audio too large (max 10MB). Please try again.');
			return;
		}

		clearFilePreviews();
		selectedFiles = [file];
		filePreviews = buildPreviewEntries([file]);
		await uploadSelectedFiles();
		showAudioRecorder = false;
		showMediaMenu = false;
	}

	function handleOpenFilePicker() {
		showMediaMenu = false;
		fileInput?.click();
	}

	function handleOpenCameraCapture() {
		showMediaMenu = false;
		showCameraCapture = true;
	}

	function handleOpenAudioRecorder() {
		showMediaMenu = false;
		showAudioRecorder = true;
	}

	// Check if browser supports media capture
	function supportsMediaCapture(): boolean {
		return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
	}

	function wait(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function getChannelHistoryFlags(channelId: string): {
		hasMoreServer: boolean;
		serverLoading: boolean;
		hasMoreArchive: boolean;
		archiveLoading: boolean;
	} {
		const hasMoreServer = get(channelHasMoreHistory)[channelId] ?? false;
		const serverLoading = get(channelHistoryLoading)[channelId] || false;
		const availableArchives = get(channelAvailableArchives)[channelId] || [];
		const loadedArchives = get(channelLoadedArchives)[channelId] || new Set<string>();
		const hasMoreArchive = availableArchives.length > loadedArchives.size;
		const archiveLoading = get(channelLoadingOlder)[channelId] || false;
		return { hasMoreServer, serverLoading, hasMoreArchive, archiveLoading };
	}

	async function waitForHistoryIdle(channelId: string, timeoutMs = 12_000): Promise<void> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			const { serverLoading, archiveLoading } = getChannelHistoryFlags(channelId);
			if (!serverLoading && !archiveLoading) return;
			await wait(120);
		}
	}

	async function runFullHistorySearchBackfill(): Promise<void> {
		if (!searchInput.trim() || !currentChannelData?.persistMessages || !$currentChannel) return;
		if (isFullHistorySearchRunning) return;
		const channelId = $currentChannel;
		const querySnapshot = searchInput.trim();
		isFullHistorySearchRunning = true;
		fullHistorySearchAbortRequested = false;
		fullHistorySearchPagesLoaded = 0;
		fullHistorySearchStatus = get(_)('chat.search.status.scanning');

		try {
			for (let i = 0; i < MAX_FULL_HISTORY_SEARCH_PAGES; i += 1) {
				if (fullHistorySearchAbortRequested) {
					fullHistorySearchStatus = get(_)('chat.search.status.stopped');
					return;
				}
				if ($currentChannel !== channelId || searchInput.trim() !== querySnapshot) {
					fullHistorySearchStatus = get(_)('chat.search.status.changed');
					return;
				}

				const flags = getChannelHistoryFlags(channelId);
				if (flags.serverLoading || flags.archiveLoading) {
					await waitForHistoryIdle(channelId);
					continue;
				}

				if (flags.hasMoreServer) {
					loadOlderHistory(channelId);
					fullHistorySearchPagesLoaded += 1;
				} else if (flags.hasMoreArchive) {
					await loadOlderMessages(channelId);
					fullHistorySearchPagesLoaded += 1;
				} else {
					fullHistorySearchStatus = get(_)('chat.search.status.loaded');
					return;
				}

				await waitForHistoryIdle(channelId);
				await tick();
			}
			fullHistorySearchStatus = get(_)('chat.search.status.limit');
		} finally {
			isFullHistorySearchRunning = false;
		}
	}

	async function openSearch(): Promise<void> {
		if (!searchExpanded) {
			searchExpanded = true;
			await tick();
		}
		searchInputElement?.focus();
	}

	function collapseSearchIfIdle(): void {
		if (!searchInput.trim()) {
			searchExpanded = false;
		}
	}

	function handleSearchInputKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (searchInput.trim()) {
			searchInput = '';
			return;
		}
		searchExpanded = false;
		searchInputElement?.blur();
	}

	function searchCurrentQueryInBrowser(): void {
		if (!$displayEnhancementSettingsStore.googleSearchReplaceEnabled) return;
		openExternalSearch(searchInput, getSearchEngineProvider());
	}

	onMount(() => {
		scrollToBottom();
		experimentalStdbCallsEnabled = isExperimentalStdbCallEnabled();

		void (async () => {
			const env = import.meta.env as Record<string, string | undefined>;
			const fallbackVersion =
				env.PUBLIC_APP_VERSION ||
				env.VITE_APP_VERSION ||
				env.npm_package_version ||
				'dev';
			runtimeVersionLabel = fallbackVersion;

			if (!isTauriRuntime()) return;
			try {
				const { getVersion } = await import('@tauri-apps/api/app');
				runtimeVersionLabel = await getVersion();
			} catch {
				// Keep fallback version label when Tauri API is unavailable.
			}
		})();

		const handleGlobalClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && emojiPickerContainer?.contains(target)) return;
			if (target && mediaMenuContainer?.contains(target)) return;
			if (target && mentionMenuContainer?.contains(target)) return;
			if (target && searchContainerElement?.contains(target)) return;
			showMediaMenu = false;
			showEmojiPicker = false;
			showMentionSuggestions = false;
			collapseSearchIfIdle();
		};

		document.addEventListener('click', handleGlobalClick);
		return () => {
			document.removeEventListener('click', handleGlobalClick);
		};
	});

	onDestroy(() => {
		clearFilePreviews();
		if (compressionDialogResolve) {
			resolveCompressionDialog(null);
		}
	});

	async function toggleExperimentalStdbCallUi() {
		const next = !experimentalStdbCallsEnabled;
		experimentalStdbCallsEnabled = next;
		await setExperimentalStdbCallEnabled(next);
	}
</script>

<div
	class="chat-container"
	on:dragenter={handleDragEnter}
	on:dragleave={handleDragLeave}
	on:dragover={handleDragOver}
	on:drop={handleDrop}
>
	{#if isDragging}
		<div class="drag-overlay">
			<div class="drag-overlay-content">
				<div class="drag-icon">📁</div>
				<div class="drag-text">{$_('chat.drag.drop_to_upload')}</div>
			</div>
		</div>
	{/if}

	<div class="chat-header" class:dm-channel={isDMChannel}>
		<h2>
			<span class="channel-title">{channelDisplayName}</span>
			{#if isDMChannel}
				<span class="dm-badge">{$_('chat.dm.badge')}</span>
			{:else if channelDescription}
				<span class="channel-description">{channelDescription}</span>
			{/if}
		</h2>
		<div class="header-actions">
			<button
				class="albums-open-btn"
				type="button"
				on:click={() => layoutStore.showMediaTab()}
				title="Open media panel"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="3" y="3" width="18" height="18" rx="2"></rect>
					<circle cx="8.5" cy="8.5" r="1.5"></circle>
					<polyline points="21 15 16 10 5 21"></polyline>
				</svg>
			</button>
			{#if isDMChannel && dmCallTargetUser}
				<div class="dm-call-actions">
					{#if dmDirectCallActive}
						<span class="dm-call-live" role="status" aria-live="polite">{dmDirectCallPending ? 'Calling…' : 'Call active'}</span>
					{/if}
					<button
						class="dm-call-btn"
						class:active={dmDirectCallActive}
						on:click={startDMVoiceCall}
						disabled={dmDirectCallActive}
						title={$_('chat.dm.voice_call_title', { values: { user: dmCallTargetUser.username } })}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
						<span>{$_('chat.dm.call')}</span>
					</button>
					<button
						class="dm-call-btn"
						class:active={dmDirectCallActive}
						on:click={startDMVideoCall}
						disabled={dmDirectCallActive}
						title={$_('chat.dm.video_call_title', { values: { user: dmCallTargetUser.username } })}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
						<span>{$_('chat.dm.video')}</span>
					</button>
				</div>
			{/if}
			{#if experimentalScopeVisible}
				<button
					type="button"
					class="experimental-stdb-toggle"
					class:active={experimentalStdbCallsEnabled}
					on:click={toggleExperimentalStdbCallUi}
					disabled={!isTauriRuntime() || getTauriPlatform() !== 'desktop'}
					title="Experimental SpaceChatDB STDB routing for DM/group calls only"
				>
					STDB EXP {experimentalStdbCallsEnabled ? 'ON' : 'OFF'}
				</button>
			{/if}
			<div class="search-container" class:expanded={searchExpanded} bind:this={searchContainerElement}>
				<span class="search-icon" aria-hidden="true">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="11" cy="11" r="7"></circle>
						<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
					</svg>
				</span>
				<input
					type="text"
					bind:this={searchInputElement}
					bind:value={searchInput}
					placeholder={$_('chat.search.placeholder')}
					class="search-input"
					on:click={openSearch}
					on:focus={openSearch}
					on:keydown={handleSearchInputKeydown}
				/>
				{#if searchExpanded && searchInput && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
					<span class="search-results">
						{filteredMessages.length === 1
							? $_('chat.search.results_one', { values: { count: filteredMessages.length } })
							: $_('chat.search.results_many', { values: { count: filteredMessages.length } })}
					</span>
				{/if}
				{#if searchExpanded && searchBackfillBusy && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
					<span class="search-results">{$_('chat.search.loading_older')}</span>
				{/if}
				{#if searchExpanded && searchInput && $displayEnhancementSettingsStore.googleSearchReplaceEnabled && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
					<button type="button" class="search-history-btn" on:click={searchCurrentQueryInBrowser}>
						Search on Web
					</button>
				{/if}
				{#if searchExpanded && searchInput && currentChannelData?.persistMessages && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
					<button
						type="button"
						class="search-history-btn"
						on:click={() => {
							if (isFullHistorySearchRunning) {
								fullHistorySearchAbortRequested = true;
							} else {
								void runFullHistorySearchBackfill();
							}
						}}
					>
						{isFullHistorySearchRunning
							? $_('chat.search.stop', { values: { count: fullHistorySearchPagesLoaded } })
							: $_('chat.search.full_history')}
					</button>
					{#if fullHistorySearchStatus}
						<span class="search-results">{fullHistorySearchStatus}</span>
					{/if}
				{/if}
			</div>
		</div>
	</div>

	<div class="chat-tabs-row">
		<ChannelQuickTabs />
	</div>

	<!-- TEMPORARY: DMs now render in center like channels -->
	<div class="messages" bind:this={chatContainer}>
		{#if $displayEnhancementSettingsStore.betterSearchPageEnabled && searchInput}
			<div class="search-results-toolbar" role="status" aria-live="polite">
				<span class="search-toolbar-meta">
					{filteredMessages.length === 1
						? $_('chat.search.results_one', { values: { count: filteredMessages.length } })
						: $_('chat.search.results_many', { values: { count: filteredMessages.length } })}
				</span>
				{#if searchBackfillBusy}
					<span class="search-toolbar-meta">{$_('chat.search.loading_older')}</span>
				{/if}
				{#if $displayEnhancementSettingsStore.googleSearchReplaceEnabled}
					<button type="button" class="search-toolbar-btn" on:click={searchCurrentQueryInBrowser}>
						Search on Web
					</button>
				{/if}
				{#if currentChannelData?.persistMessages}
					<button
						type="button"
						class="search-toolbar-btn"
						on:click={() => {
							if (isFullHistorySearchRunning) {
								fullHistorySearchAbortRequested = true;
							} else {
								void runFullHistorySearchBackfill();
							}
						}}
					>
						{isFullHistorySearchRunning
							? $_('chat.search.stop', { values: { count: fullHistorySearchPagesLoaded } })
							: $_('chat.search.full_history')}
					</button>
				{/if}
				{#if fullHistorySearchStatus}
					<span class="search-toolbar-meta">{fullHistorySearchStatus}</span>
				{/if}
			</div>
		{/if}
		{#key `${$currentChannel}-${channelPaneAnimation.enabled ? channelPaneAnimation.preset : 'off'}`}
		<div
			class="messages-pane"
			in:channelPaneInTransition={channelPaneAnimation}
			out:channelPaneOutTransition={channelPaneAnimation}
		>
			{#if !searchInput}
				<PinnedMessages pinnedMessages={pinnedMessages} />
			{/if}
			<MessageList
				messages={filteredMessages}
				onReply={handleReply}
				onQuickMention={handleQuickMention}
				firstUnreadMessageId={$lastReadMessageId}
				on:openSettings={() => dispatch('openSettings')}
			/>

			{#if visibleTypingUsers.length > 0}
				<div class="typing-indicator">
					<span class="typing-dots"></span>
					<span>{formatTypingUsers(visibleTypingUsers)}</span>
				</div>
			{/if}
		</div>
		{/key}
	</div>

		{#if showEmojiPicker}
			<div class="emoji-picker-container" bind:this={emojiPickerContainer}>
				{#if EmojiPickerComponent}
					<svelte:component
						this={EmojiPickerComponent}
						on:select={handleEmojiSelect}
						on:gif={handleGifSelect}
						on:close={() => showEmojiPicker = false}
					/>
				{:else}
					<div class="emoji-picker-loading">{$_('emoji_picker.loading')}</div>
				{/if}
			</div>
		{/if}

		<CameraCapture
			isOpen={showCameraCapture}
			on:close={() => showCameraCapture = false}
			on:capture={handlePhotoCapture}
		/>

		<AudioRecorder
			isOpen={showAudioRecorder}
			on:close={() => showAudioRecorder = false}
			on:send={handleAudioSend}
		/>

		{#if !($layoutStore.isMobile && $isInCall)}
		{#if editingMessage}
			<div class="edit-bar">
				<div class="edit-info">
					<span class="edit-label">{$_('chat.compose.editing')}</span>
					<span class="edit-hint">{$_('chat.compose.escape_to_cancel')}</span>
				</div>
				<button class="cancel-edit" on:click={cancelEdit}>✕</button>
			</div>
		{:else if replyingTo}
			<div class="reply-bar">
				<div class="reply-info">
					<span class="reply-label">{$_('chat.compose.replying_to', { values: { user: replyingTo.user } })}</span>
					<span class="reply-preview">
						{#if replyingTo.text}
							{replyingTo.text.substring(0, 50)}{replyingTo.text.length > 50 ? '...' : ''}
						{:else if replyingTo.type === 'gif'}
							GIF
						{:else if replyingTo.type === 'emoji'}
							:{replyingTo.emojiName || 'sticker'}:
						{:else}
							{$_('chat.compose.attachment')}
						{/if}
					</span>
				</div>
				<button class="cancel-reply" on:click={cancelReply}>✕</button>
			</div>
		{/if}

		<div class="input-wrapper">
		{#if showMentionSuggestions && mentionSuggestions.length > 0}
			<div class="mention-suggestions" bind:this={mentionMenuContainer}>
				{#each mentionSuggestions as suggestion, index (suggestion.key)}
					<button
						type="button"
						class="mention-suggestion"
						class:selected={index === mentionSelectedIndex}
						on:mousedown|preventDefault={() => applyMentionSuggestion(index)}
					>
						<span class="mention-label">{suggestion.label}</span>
						<span class="mention-kind">{suggestion.kind === 'special' ? $_('chat.mentions.kind_mention') : $_('chat.mentions.kind_user')}</span>
					</button>
				{/each}
			</div>
		{/if}
		{#if filePreviews.length > 0 && !isUploading}
			<div class="file-gallery">
				<div class="gallery-header">
					<span>
						{filePreviews.length === 1
							? $_('chat.upload.files_selected_one', { values: { count: filePreviews.length } })
							: $_('chat.upload.files_selected_many', { values: { count: filePreviews.length } })}
					</span>
					<button class="cancel-gallery" on:click={cancelUpload}>✕</button>
				</div>
				<div class="gallery-grid">
					{#each filePreviews as { file, preview }, index}
						<div class="gallery-item">
							{#if preview}
								<img src={preview} alt={file.name} class="gallery-preview" />
							{:else}
								<div class="gallery-file-icon">
									{#if file.type.startsWith('video/')}
										🎬
									{:else if file.type.startsWith('audio/')}
										🎵
									{:else}
										📄
									{/if}
								</div>
							{/if}
							<div class="gallery-file-info">
								<div class="gallery-file-name">{file.name}</div>
								<div class="gallery-file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
							</div>
							<button class="remove-file" on:click={() => removeFile(index)}>✕</button>
						</div>
					{/each}
				</div>
				<div class="spoiler-checkbox-container">
					<label class="spoiler-checkbox-label">
						<input type="checkbox" bind:checked={markAsSpoiler} class="spoiler-checkbox" />
						<span>{$_('chat.upload.mark_spoiler')}</span>
					</label>
					<span class="spoiler-hint" title={$_('chat.upload.spoiler_hint')}>⚠️</span>
				</div>
				<button class="upload-files-btn" on:click={uploadSelectedFiles}>
					{filePreviews.length === 1
						? $_('chat.upload.upload_files_one', { values: { count: filePreviews.length } })
						: $_('chat.upload.upload_files_many', { values: { count: filePreviews.length } })}
				</button>
			</div>
		{/if}

		{#if isUploading}
			<div class="upload-progress-bar">
				<div class="upload-progress-info">
					<span>{uploadStatusLabel || $_('chat.upload.uploading')}</span>
					<span>{uploadProgress}%</span>
				</div>
				<div class="progress-bar">
					<div class="progress-fill" style="width: {uploadProgress}%"></div>
				</div>
			</div>
		{/if}
		<input
			type="file"
			bind:this={fileInput}
			on:change={handleFileSelect}
			multiple
			style="display: none;"
		/>
		<div class="input-container">
			<CommandPalette
				bind:this={commandPalette}
				bind:input={messageInput}
				bind:isVisible={showCommandPalette}
				bind:selectedIndex={commandPaletteSelectedIndex}
				onSelect={handleCommandSelect}
			/>
				<div class="input-buttons-left">
					<div class="media-menu-container" bind:this={mediaMenuContainer}>
						<button
						class="input-icon-button"
						on:click|stopPropagation={() => {
							showMediaMenu = !showMediaMenu;
							if (showMediaMenu) showEmojiPicker = false;
						}}
						title={$_('chat.compose.add_media')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
					</button>
					{#if showMediaMenu}
						<div class="media-menu">
							<button class="media-menu-item" on:click={handleOpenFilePicker}>{$_('chat.compose.upload_file')}</button>
							{#if supportsMediaCapture()}
								<button class="media-menu-item" on:click={handleOpenCameraCapture}>{$_('chat.compose.take_photo')}</button>
								<button class="media-menu-item" on:click={handleOpenAudioRecorder}>{$_('chat.compose.record_audio')}</button>
							{/if}
							</div>
						{/if}
					</div>
					<button
						class="input-icon-button"
						on:click={() => openPaymentSheet()}
						title="Create payment request"
						disabled={!paymentButtonEnabled}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"></rect><path d="M2.5 10h19"></path><path d="M7.5 15h4"></path></svg>
					</button>
					{#if isDMChannel}
						<button
							class="input-icon-button"
							on:click={openManualCashModal}
							title="Record manual cash trade"
							disabled={!paymentButtonEnabled}
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V7a2 2 0 0 1 2-2h4"></path><path d="M16 13v4a2 2 0 0 1-2 2h-4"></path><path d="M5 12h4"></path><path d="M15 12h4"></path><path d="m9 9 2 3-2 3"></path><path d="m15 9-2 3 2 3"></path></svg>
						</button>
					{/if}
				</div>
				<textarea
				bind:this={textareaElement}
				bind:value={messageInput}
				on:paste={handlePaste}
				on:input={() => {
					handleInput();
					handleInputChange();
				}}
				on:keydown={handleKeyDown}
				placeholder={$_('chat.compose.placeholder')}
				maxlength={composerInputMaxLength}
				spellcheck={composerSpellcheckEnabled}
				rows="1"
			></textarea>
			{#if composerCharCounterEnabled && composerCharCounterVisible}
				<span class="composer-char-counter" class:warn={composerCharCounterWarn} class:visible={composerCharCounterVisible}>
					{composerCharCount}/{composerInputMaxLength}
				</span>
			{/if}
				<button
					bind:this={emojiPickerButton}
					class="input-icon-button"
					on:click|stopPropagation={() => {
						showEmojiPicker = !showEmojiPicker;
						if (showEmojiPicker) {
							ensureEmojiPickerLoaded();
							showMediaMenu = false;
						}
					}}
					title={$_('chat.compose.add_emoji')}
				>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
			</button>
			<button
				class="send-button"
				on:click={handleSubmit}
				disabled={!messageInput.trim()}
				title={$_('chat.compose.send_message')}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
			</button>
		</div>
		{#if unicodeEmojisEnabled && unicodeComposerPreviewTokens > 0 && unicodeComposerPreview !== messageInput}
			<div class="unicode-conversion-hint">
				Unicode preview: {unicodeComposerPreview}
			</div>
		{/if}
		{#if gifCaptionerEnabled && gifCaptionerDedicatedCaptionFieldEnabled}
			<div class="gif-caption-draft-row">
				<input
					type="text"
					class="gif-caption-draft-input"
					bind:value={gifCaptionInput}
					maxlength={MAX_GIF_CAPTION_LENGTH}
					placeholder="GIF caption (used when sending from GIF picker)"
				/>
				<span class="gif-caption-draft-count" class:warn={gifCaptionDraftWarn}>
					{gifCaptionDraftLength}/{MAX_GIF_CAPTION_LENGTH}
				</span>
			</div>
			{#if unicodeEmojisEnabled && unicodeGifCaptionPreviewTokens > 0 && unicodeGifCaptionPreview !== gifCaptionInput}
				<div class="unicode-conversion-hint">
					GIF caption preview: {unicodeGifCaptionPreview}
				</div>
			{/if}
		{:else if gifCaptionerEnabled && showEmojiPicker}
			<div class="gif-caption-hint">
				GIF caption uses composer text (max {MAX_GIF_CAPTION_LENGTH} characters).
			</div>
		{/if}
	</div>
			{/if}
	</div>

	{#if compressionDialogOpen && compressionDialogFile}
		<div class="compression-modal-backdrop" role="presentation">
			<div class="compression-modal" role="dialog" aria-modal="true" aria-labelledby="video-compress-title">
				<h3 id="video-compress-title">Compress Video Before Upload</h3>
				<p class="compression-copy">
					"{compressionDialogFile.name}" is {formatFileMb(compressionDialogFile.size)} MB. Compress now or keep the original file.
				</p>
				<p class="compression-runtime-note">Runtime profile: {compressionDialogRuntimeLabel}</p>
				<div class="compression-preset-row">
					<label for="compression-preset-select">Preset</label>
					<select
						id="compression-preset-select"
						bind:value={compressionDialogPreset}
						disabled={compressionDialogBusy}
					>
						{#each compressionDialogPresetOptions as presetOption (presetOption.id)}
							<option value={presetOption.id}>{presetOption.label}</option>
						{/each}
					</select>
				</div>
				{#if selectedCompressionPresetOption}
					<div class="compression-preset-note">{selectedCompressionPresetOption.description}</div>
				{/if}
				{#if compressionDialogEstimate}
					<div class="compression-estimate">
						<span>
							Estimated output: {formatFileMb(compressionDialogEstimate.estimatedBytes)} MB
							({compressionDialogEstimate.targetWidth}x{compressionDialogEstimate.targetHeight})
						</span>
						<span class:estimate-saving={compressionDialogEstimate.estimatedReductionRatio > 0}>
							{formatSignedMb(compressionDialogEstimate.estimatedBytes - compressionDialogFile.size)}
						</span>
					</div>
				{/if}
				{#if compressionDialogSuggestionCopy}
					<div class="compression-suggestion">{compressionDialogSuggestionCopy}</div>
				{/if}
				{#if compressionDialogBusy}
					<div class="compression-progress">
						<div class="compression-progress-info">
							<span>Compressing...</span>
							<span>{compressionDialogProgress}%</span>
						</div>
						<div class="progress-bar">
							<div class="progress-fill" style="width: {compressionDialogProgress}%"></div>
						</div>
					</div>
				{:else if compressionDialogError}
					<div class="compression-error">{compressionDialogError}</div>
				{/if}
				<div class="compression-actions">
					{#if compressionDialogBusy}
						<button type="button" class="compression-btn secondary" on:click={cancelCompressionRun}>Cancel Compression</button>
					{:else if compressionDialogError}
						<button type="button" class="compression-btn" on:click={() => void runVideoCompression()}>Retry</button>
						<button type="button" class="compression-btn secondary" on:click={keepOriginalVideoFile}>Keep Original</button>
						<button type="button" class="compression-btn danger" on:click={removeVideoFileFromQueue}>Remove File</button>
					{:else}
						<button type="button" class="compression-btn" on:click={() => void runVideoCompression()}>Compress</button>
						<button type="button" class="compression-btn secondary" on:click={keepOriginalVideoFile}>Keep Original</button>
						<button type="button" class="compression-btn danger" on:click={removeVideoFileFromQueue}>Remove File</button>
					{/if}
				</div>
			</div>
		</div>
		{/if}

		<PaymentSheet
			isOpen={paymentSheetOpen}
			openSeed={paymentSheetOpenSeed}
			initialAmountInput={paymentSheetPrefillAmountInput}
			initialDescription={paymentSheetPrefillDescription}
			initialCustomerRef={paymentSheetPrefillCustomerRef}
			defaultTargetLabel={paymentTargetLabel}
			defaultTargetKind={paymentTargetKind}
			onClose={() => {
				paymentSheetOpen = false;
			}}
			onManageConnections={() => {
				paymentSheetOpen = false;
				dispatch('openSettings', { paymentSurface: 'connections' });
			}}
			defaultChannelId={$currentChannel}
		/>
		<ManualCashModal
			isOpen={manualCashOpen}
			channelId={$currentChannel}
			targetLabel={paymentTargetLabel}
			counterpartyLabel={dmCallTargetUser?.username || 'Other user'}
			onClose={() => {
				manualCashOpen = false;
			}}
		/>

		<div class="debug-version-footer" aria-hidden="true">
			Version {runtimeVersionLabel} - for debugging reasons only
		</div>

<style>
		.chat-container {
			display: flex;
			flex-direction: column;
		height: 100%;
		position: relative;
		background: var(--bg-primary);
		background-image: var(--background-image-url, none);
		background-size: var(--background-image-size, cover);
		background-position: var(--background-image-position, center);
		background-repeat: var(--background-image-repeat, no-repeat);
		background-blend-mode: var(--background-image-blend, overlay);
			overflow: hidden;
		}

		.debug-version-footer {
			position: absolute;
			left: 50%;
			bottom: 4px;
			transform: translateX(-50%);
			font-size: 0.66rem;
			letter-spacing: 0.03em;
			color: var(--text-secondary);
			opacity: 0.5;
			pointer-events: none;
			z-index: 20;
			white-space: nowrap;
		}

		.compression-modal-backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.56);
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 1rem;
			z-index: 30;
		}

		.compression-modal {
			width: min(92vw, 420px);
			border: 1px solid var(--border);
			background: var(--bg-secondary);
			border-radius: 12px;
			padding: 0.9rem;
			display: flex;
			flex-direction: column;
			gap: 0.65rem;
		}

		.compression-modal h3 {
			margin: 0;
			font-size: 0.95rem;
		}

		.compression-copy {
			margin: 0;
			font-size: 0.8rem;
			color: var(--text-secondary);
			word-break: break-word;
		}

		.compression-runtime-note {
			margin: 0;
			font-size: 0.73rem;
			color: var(--text-muted);
		}

		.compression-preset-row {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}

		.compression-preset-row label {
			font-size: 0.74rem;
			color: var(--text-secondary);
		}

		.compression-preset-row select {
			border: 1px solid var(--border);
			background: var(--bg-primary);
			color: var(--text-primary);
			border-radius: 8px;
			padding: 0.42rem 0.5rem;
			font-size: 0.8rem;
		}

		.compression-preset-note {
			font-size: 0.72rem;
			color: var(--text-muted);
			line-height: 1.35;
		}

		.compression-estimate {
			display: flex;
			justify-content: space-between;
			gap: 0.5rem;
			font-size: 0.72rem;
			color: var(--text-secondary);
		}

		.compression-estimate .estimate-saving {
			color: #34d399;
		}

		.compression-suggestion {
			border: 1px solid rgba(var(--accent-rgb), 0.35);
			background: rgba(var(--accent-rgb), 0.12);
			border-radius: 8px;
			padding: 0.45rem 0.5rem;
			font-size: 0.73rem;
			color: var(--text-secondary);
			line-height: 1.35;
		}

		.compression-progress {
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
		}

		.compression-progress-info {
			display: flex;
			justify-content: space-between;
			font-size: 0.74rem;
			color: var(--text-secondary);
		}

		.compression-error {
			border: 1px solid rgba(220, 38, 38, 0.45);
			background: rgba(220, 38, 38, 0.14);
			color: #fecaca;
			border-radius: 8px;
			padding: 0.5rem;
			font-size: 0.75rem;
			word-break: break-word;
		}

		.compression-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 0.45rem;
		}

		.compression-btn {
			border: 1px solid rgba(var(--accent-rgb), 0.5);
			background: rgba(var(--accent-rgb), 0.2);
			color: var(--text-primary);
			border-radius: 8px;
			padding: 0.4rem 0.56rem;
			font-size: 0.78rem;
			cursor: pointer;
		}

		.compression-btn.secondary {
			border-color: var(--border);
			background: rgba(255, 255, 255, 0.04);
		}

		.compression-btn.danger {
			border-color: rgba(220, 38, 38, 0.6);
			background: rgba(220, 38, 38, 0.16);
			color: #fecaca;
		}

	.chat-container::before {
		content: '';
		position: absolute;
		inset: 0;
		background-color: rgba(0, 0, 0, calc(1 - var(--background-image-opacity, 1)));
		filter: blur(var(--background-image-blur, 0px));
		pointer-events: none;
		z-index: 0;
	}

	.chat-header {
		flex-shrink: 0;
		padding: 0.75rem 1rem;
		background: var(--bg-primary);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--app-chrome-height);
		box-sizing: border-box;
		z-index: 2;
	}

	.chat-header h2 {
		font-size: var(--text-xl);
		margin: 0;
		font-weight: var(--font-weight-semibold);
		flex: 1;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.emoji-picker-loading {
		padding: 0.75rem;
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}

	.channel-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.channel-description {
		font-size: var(--text-sm);
		font-weight: var(--font-weight-regular);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-badge {
		display: inline-block;
		padding: 0.25rem 0.5rem;
		background: var(--accent);
		color: white;
		font-size: var(--text-xs);
		border-radius: var(--radius-sm);
		font-weight: var(--font-weight-medium);
	}

	.dm-redirect-message {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 1rem;
		color: var(--text-secondary);
		text-align: center;
		padding: 2rem;
	}

	.dm-redirect-message svg {
		color: var(--text-tertiary);
		opacity: 0.5;
	}

	.dm-redirect-message h3 {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-lg);
		font-weight: var(--font-weight-semibold);
	}

	.dm-redirect-message p {
		margin: 0;
		font-size: var(--text-sm);
		max-width: 300px;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.albums-open-btn {
		display: inline-flex;
		align-items: center;
		gap: 0;
		padding: 0.35rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: var(--text-sm);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition: all var(--duration-fast);
	}

	.albums-open-btn svg {
		width: 14px;
		height: 14px;
	}

	.albums-open-btn:hover {
		border-color: var(--accent);
		background: var(--bg-tertiary);
	}

	.dm-call-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.dm-call-live {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.55rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--status-online, #44b700) 65%, transparent);
		background: color-mix(in srgb, var(--status-online, #44b700) 12%, transparent);
		color: var(--status-online, #44b700);
		font-size: var(--text-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: 0.01em;
	}

	.dm-call-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: var(--text-sm);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition: all var(--duration-fast);
	}

	.dm-call-btn svg {
		width: 14px;
		height: 14px;
	}

	.dm-call-btn:hover {
		border-color: var(--accent);
		background: var(--bg-tertiary);
	}

	.dm-call-btn.active {
		border-color: color-mix(in srgb, var(--status-online, #44b700) 60%, var(--border));
		background: color-mix(in srgb, var(--status-online, #44b700) 14%, var(--bg-secondary));
	}

	.dm-call-btn:disabled {
		opacity: 0.75;
		cursor: default;
	}

	.experimental-stdb-toggle {
		display: inline-flex;
		align-items: center;
		padding: 0.32rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: 0.02em;
		cursor: pointer;
		transition: all var(--duration-fast);
	}

	.experimental-stdb-toggle:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--text-primary);
		background: var(--bg-tertiary);
	}

	.experimental-stdb-toggle.active {
		border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-secondary));
		color: var(--text-primary);
	}

	.experimental-stdb-toggle:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.search-container {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		overflow: hidden;
		position: relative;
	}

	.search-icon {
		position: absolute;
		top: 50%;
		left: 18px;
		transform: translate(-50%, -50%);
		color: color-mix(in srgb, var(--text-primary) 78%, var(--text-secondary));
		pointer-events: none;
		z-index: 3;
		transition: left 220ms ease, color 140ms ease;
	}

	.search-icon svg {
		width: 15px;
		height: 15px;
	}

	.search-container.expanded .search-icon {
		left: 12px;
		color: var(--text-primary);
	}

	.search-input {
		width: 36px;
		height: 34px;
		padding: 0;
		padding-left: 0;
		padding-right: 0.35rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: var(--text-base);
		min-width: 0;
		cursor: pointer;
		opacity: 0.95;
		transition:
			width 320ms cubic-bezier(0.34, 1.56, 0.64, 1),
			opacity 180ms ease,
			padding 220ms ease,
			border-color 140ms ease;
	}

	.search-container.expanded .search-input {
		width: clamp(180px, 22vw, 280px);
		padding-left: 1.75rem;
		padding-right: 0.75rem;
		cursor: text;
		opacity: 1;
	}

	.search-input::placeholder {
		color: transparent;
	}

	.search-container.expanded .search-input::placeholder {
		color: var(--text-secondary);
	}

	.search-input:focus {
		outline: none;
		border-color: var(--accent);
		background: var(--bg-tertiary);
	}


	.search-results {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		white-space: nowrap;
		padding: 0 0.5rem;
	}

	.search-history-btn {
		border: none;
		border-radius: 10px;
		padding: 0.2rem 0.55rem;
		font-size: 0.72rem;
		color: var(--text-secondary);
		background: var(--bg-tertiary);
		cursor: pointer;
		white-space: nowrap;
	}

	.search-history-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.search-results-toolbar {
		position: sticky;
		top: 0;
		z-index: 3;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
		padding: 0.4rem 0.55rem;
		margin: -0.35rem -0.2rem 0.45rem;
		border: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		border-radius: 10px;
		background: color-mix(in srgb, var(--bg-secondary) 90%, transparent);
		backdrop-filter: blur(6px);
	}

	.search-toolbar-meta {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.search-toolbar-btn {
		border: none;
		border-radius: 10px;
		padding: 0.2rem 0.55rem;
		font-size: 0.72rem;
		color: var(--text-secondary);
		background: var(--bg-tertiary);
		cursor: pointer;
		white-space: nowrap;
	}

	.search-toolbar-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}


	.chat-tabs-row {
		flex-shrink: 0;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		z-index: 2;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		min-height: 0; /* Important for flex overflow */
		background: transparent;
		position: relative;
	}

	.messages-pane {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 100%;
	}

	.typing-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		font-size: var(--text-sm);
		font-style: italic;
		padding: 0.5rem;
	}

	.typing-dots {
		display: inline-block;
		width: 4px;
		height: 4px;
		background: var(--accent);
		border-radius: 50%;
		animation: typing 1.4s infinite;
		position: relative;
	}

	.typing-dots::before,
	.typing-dots::after {
		content: '';
		position: absolute;
		width: 4px;
		height: 4px;
		background: var(--accent);
		border-radius: 50%;
		animation: typing 1.4s infinite;
	}

	.typing-dots::before {
		left: -8px;
		animation-delay: 0.2s;
	}

	.typing-dots::after {
		left: 8px;
		animation-delay: 0.4s;
	}

	@keyframes typing {
		0%, 60%, 100% {
			opacity: 0.3;
		}
		30% {
			opacity: 1;
		}
	}

	.edit-bar, .reply-bar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 1rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
	}

	.edit-info, .reply-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
	}
	.edit-label { color: var(--color-warning); font-weight: 600; }
	.reply-label { color: var(--color-info); font-weight: 600; }
	.edit-hint { font-style: italic; }

	.cancel-edit, .cancel-reply {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
	}

	.input-wrapper {
		flex-shrink: 0;
		background: var(--bg-primary);
		padding: 0.16rem 0.65rem;
		padding-bottom: env(safe-area-inset-bottom);
		border-top: 1px solid var(--border);
		z-index: 10;
		position: relative;
		min-height: var(--app-chrome-height);
		box-sizing: border-box;
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.3rem;
	}

	.input-container {
		display: flex;
		align-items: center;
		background: color-mix(in srgb, var(--bg-tertiary) 88%, transparent);
		border-radius: 10px;
		padding: 0.28rem 0.42rem;
		gap: 0.25rem;
		transition: background 0.2s;
		width: 100%;
	}

	.input-container:focus-within {
		background: var(--bg-tertiary);
	}

	.input-buttons-left {
		display: flex;
		align-items: center;
	}

	.media-menu-container {
		position: relative;
	}

	.mention-suggestions {
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: calc(100% + 0.25rem);
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.35rem;
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
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
		color: var(--text-primary);
		padding: 0.5rem 0.55rem;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
	}

	.mention-suggestion:hover,
	.mention-suggestion.selected {
		background: var(--accent);
		color: #fff;
	}

	.mention-label {
		font-weight: 600;
	}

	.mention-kind {
		font-size: 0.72rem;
		opacity: 0.85;
	}

	.media-menu {
		position: absolute;
		left: 0;
		bottom: calc(100% + 0.4rem);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 10rem;
		padding: 0.35rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg-secondary);
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
		z-index: 20;
	}

	.media-menu-item {
		border: none;
		background: transparent;
		color: var(--text-primary);
		text-align: left;
		padding: 0.45rem 0.55rem;
		border-radius: 0.4rem;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.media-menu-item:hover {
		background: var(--bg-hover);
		color: var(--accent);
	}

	.input-icon-button {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.1rem;
		width: 38px;
		height: 38px;
		cursor: pointer;
		border-radius: 4px;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		padding: 0;
	}

	.input-icon-button svg {
		width: 20px;
		height: 20px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.input-icon-button:hover {
		background: var(--bg-hover);
		color: var(--accent);
	}

	textarea {
		flex: 1;
		min-height: 36px;
		max-height: 120px;
		overflow-y: auto;
		resize: none;
		font-family: inherit;
		line-height: 1.4;
		padding: 0.5rem 0.55rem;
		border: none;
		background: transparent;
		color: var(--text-primary);
		outline: none;
		font-size: 1rem;
		/* Hide scrollbar while keeping scroll functionality */
		-ms-overflow-style: none;  /* IE and Edge */
		scrollbar-width: none;  /* Firefox */
	}

	/* Hide scrollbar for Chrome, Safari and Opera */
	textarea::-webkit-scrollbar {
		display: none;
	}

	.composer-char-counter {
		font-size: 0.68rem;
		color: var(--text-secondary);
		min-width: 4.25rem;
		text-align: right;
		align-self: flex-end;
		padding-bottom: 0.2rem;
		opacity: 0;
		transform: translateY(2px);
		transition: opacity 0.18s ease, transform 0.18s ease;
	}

	.composer-char-counter.visible {
		opacity: 0.85;
		transform: translateY(0);
	}

	.composer-char-counter.warn {
		color: #ffb347;
	}

	.gif-caption-draft-row {
		width: 100%;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.45rem;
		padding: 0 0.2rem;
	}

	.gif-caption-draft-input {
		width: 100%;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-tertiary) 90%, transparent);
		color: var(--text-primary);
		border-radius: 8px;
		font-size: 0.78rem;
		padding: 0.32rem 0.45rem;
	}

	.gif-caption-draft-count {
		font-size: 0.68rem;
		color: var(--text-secondary);
		min-width: 4.25rem;
		text-align: right;
	}

	.gif-caption-draft-count.warn {
		color: #ffb347;
	}

	.gif-caption-hint {
		width: 100%;
		padding: 0 0.22rem;
		font-size: 0.68rem;
		color: var(--text-secondary);
	}

	.unicode-conversion-hint {
		width: 100%;
		padding: 0 0.22rem;
		font-size: 0.68rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.send-button {
		background: var(--accent);
		color: white;
		border: none;
		padding: 0 0.75rem;
		height: 36px;
		border-radius: 6px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(html[data-clickable-send='true']) .input-container .send-button {
		display: none;
	}

	:global(html[data-clickable-send='true']) .input-container:focus-within .send-button {
		display: flex;
	}

	.send-button svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.send-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	:global(html[data-clickable-send='false']) .send-button {
		display: none;
	}

	.file-gallery, .upload-progress-bar {
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
	}

	.gallery-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.gallery-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.gallery-item {
		position: relative;
		aspect-ratio: 1;
		border-radius: 8px;
		overflow: hidden;
	}

	/* Drag & Drop Overlay - smooth fade effect */
	.drag-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 999;
		animation: fadeIn 0.2s ease-in-out forwards;
	}

	@keyframes fadeIn {
		from {
			background-color: rgba(0, 0, 0, 0);
			opacity: 0;
		}
		to {
			background-color: rgba(0, 0, 0, 0.5);
			opacity: 1;
		}
	}

	@keyframes fadeOut {
		from {
			background-color: rgba(0, 0, 0, 0.5);
			opacity: 1;
		}
		to {
			background-color: rgba(0, 0, 0, 0);
			opacity: 0;
		}
	}

	.drag-overlay-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		pointer-events: none;
	}

	.drag-icon {
		font-size: 3rem;
		animation: pulse 1s ease-in-out infinite;
	}

	.drag-text {
		color: white;
		font-size: 1.2rem;
		font-weight: 600;
	}

	@keyframes pulse {
		0%, 100% {
			transform: scale(1);
			opacity: 1;
		}
		50% {
			transform: scale(1.1);
			opacity: 0.8;
		}
	}

	/* Other existing styles for uploads, spoilers, etc. can remain here */
	/* ... */

	/* ========== MOBILE OVERHAUL ========== */
	@media (max-width: 768px) {
		.chat-container {
			height: 100%;
		}

		.chat-header {
			padding: 0.55rem 0.8rem;
			height: 50px;
			gap: 0.5rem;
			position: relative;
			justify-content: flex-start;
		}

		.chat-header h2 {
			font-size: 0.96rem;
			min-width: 0;
			position: absolute;
			left: 50%;
			transform: translateX(-50%);
			width: clamp(120px, 44vw, 260px);
			justify-content: center;
			pointer-events: none;
		}

		.channel-description,
		.dm-badge {
			display: none;
		}

		.channel-title {
			text-align: center;
			width: 100%;
		}

		.header-actions {
			flex: 0 1 auto;
			justify-content: flex-start;
			min-width: 0;
			width: min(58vw, 250px);
		}

		.search-container {
			flex-direction: row;
			align-items: center;
			gap: 0.35rem;
			min-width: 0;
			width: 100%;
			overflow: visible;
		}

		.search-input {
			min-width: unset;
			width: 100%;
			opacity: 1;
			transform: none;
			pointer-events: auto;
			font-size: 0.84rem;
			padding: 0.36rem 0.55rem 0.36rem 1.7rem;
			border-radius: 10px;
			border-color: var(--border);
		}

		.search-input::placeholder {
			color: var(--text-secondary);
		}

		.search-results,
		.search-history-btn,
		.dm-call-actions,
		.experimental-stdb-toggle {
			display: none;
		}

		.search-results-toolbar {
			top: 0;
			margin: -0.1rem 0 0.35rem;
			padding: 0.32rem 0.45rem;
			gap: 0.3rem;
		}

		.search-toolbar-meta {
			font-size: 0.7rem;
		}

		.search-toolbar-btn {
			font-size: 0.68rem;
			padding: 0.16rem 0.42rem;
		}

		.albums-open-btn {
			padding: 0.25rem 0.45rem;
			font-size: 0.78rem;
		}

		.messages {
			padding: 0.4rem 0.4rem 0.25rem;
			gap: 0.2rem;
			-ms-overflow-style: none;
			scrollbar-width: none;
		}

		.messages::-webkit-scrollbar {
			display: none;
			width: 0;
			height: 0;
		}

		.input-wrapper {
			padding: 0.38rem 0.45rem;
			padding-bottom: calc(0.38rem + env(safe-area-inset-bottom));
			border-top: 1px solid var(--border);
			background: var(--bg-secondary);
			gap: 0.26rem;
		}

		.input-container {
			padding: 0.2rem 0.25rem;
			gap: 0.22rem;
			background: color-mix(in srgb, var(--bg-tertiary) 90%, black 10%);
			border-radius: 12px;
		}

		textarea {
			font-size: 16px; /* Prevents iOS auto-zoom */
			padding: 0.58rem 0.45rem;
			min-height: 36px;
		}

		.input-icon-button {
			width: 34px;
			height: 34px;
			flex-shrink: 0;
		}

		/* Show attach/camera buttons on mobile */
		.input-buttons-left {
			display: flex;
		}

		.send-button {
			height: 34px;
			width: 34px;
			padding: 0;
			flex-shrink: 0;
			border-radius: 9px;
		}

		.gif-caption-draft-row {
			grid-template-columns: 1fr;
			gap: 0.22rem;
		}

		.gif-caption-draft-count {
			text-align: left;
			min-width: 0;
		}

		.edit-bar, .reply-bar {
			padding: 0.32rem 0.62rem;
		}
	}
</style>
