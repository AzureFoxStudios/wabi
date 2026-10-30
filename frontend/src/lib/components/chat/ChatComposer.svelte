<script lang="ts">
	import { stopPropagation } from 'svelte/legacy';

	import { createEventDispatcher, onDestroy, onMount, tick, untrack } from 'svelte';
	import { composerDrafts, type ComposerDraft } from '$lib/composerDraftState';
	import { sendComposerBatch } from '$lib/composerSendBatch';
	import { settleComposerText, settleComposerUpload } from '$lib/composerSendSettlement';
	import { captureGroupAccess } from '$lib/groupAccess';
	import { get } from 'svelte/store';
	import { channelMessages, channels, currentChannel, currentUser, editMessage, emojis, getDMOtherUser, sendMessage, sendTyping, userLookup, users, type Emoji, type Message, type MessageEntity, type User } from '$lib/socket';
	import { pinChannel, unpinChannel } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import { isMobile } from '$lib/layoutStoreStates';
	import { showToast } from '$lib/toast';
import { addQuickReactionCustomEmojiId } from '$lib/quickReactions';
import type { MediaAlbum } from '$lib/api';
	import { getMatchingCommands, type Command } from '$lib/commands';
	import { authSessionGeneration, getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { composerEnhancementSettingsStore, splitMessageForSending } from '$lib/composerEnhancements';
	import { gifCaptionerSettingsStore } from '$lib/gifCaptionerSettings';
	import { previewUnicodeEmojiConversion, unicodeEmojiSettingsStore } from '$lib/unicodeEmojis';
	import { placeRegistry } from '$lib/placeStore';
	import { loadPlaceRegistry, rebaseMessageEntitiesForText, reconcileMessageEntities, splitEntitiesForChunks } from '$lib/placeRegistry';
	import { createDM, dmPanelSignal, getDMChannelIdForUser, serverMembers } from '$lib/socket';
	import { openFullMapTab } from '$lib/mapWorkspace';
	import { openModelViewportSurface } from '$lib/modelViewportTab';
	import { openReaderSurface } from '$lib/readerWorkspace';
	import { pushLocalDirectionsCard } from '$lib/directionsAssist';
	import AudioRecorder from '../AudioRecorder.svelte';
	import CameraCapture from '../CameraCapture.svelte';
	import CommandPalette from '../CommandPalette.svelte';
	import { executeChatCommand } from './commandExecutor';
	import EditReplyStatus from './EditReplyStatus.svelte';
	import { buildDefaultUploadAlbumName, buildPreviewEntries, enforcePreviewBudget, formatFileMb, getMediaAlbumScope, isAlbumEligibleFile, revokePreviewUrl } from './fileHandlers';
	import FileUploadPreview from './FileUploadPreview.svelte';
	import MentionSuggestions from './MentionSuggestions.svelte';
	import EmojiSuggestions from './EmojiSuggestions.svelte';
	import { applyMentionToInput, computeMentionSuggestions, mentionDirectory } from './mentionSuggestions';
	import { loadSharedGamesForMentions } from '$lib/games/mentions';
	import type { GameSelection } from '$lib/games/model';
	import { checkSendBurst, detectMessageKind, processAttachmentCaption, processOutgoingText } from './messageSend';
	import { orchestrateUpload } from './uploadOrchestrator';
	import VideoCompressionController from './VideoCompressionController.svelte';
	import type { MediaAlbumScopeType } from '$lib/api';
	import type { FilePreview } from './fileHandlers';
	import type { MentionSuggestion } from './types';
	import type { E2eeRoomStatus } from '$lib/e2ee';
	import Icon from '../ui/Icon.svelte';
	import Menu from '../ui/Menu.svelte';
	import Tooltip from '../ui/Tooltip.svelte';
	import PrivacyBadge from '../PrivacyBadge.svelte';
	import type { MenuEntry } from '../context-menu/ContextMenu.svelte';
	import { stagePrivacySummary } from './ChatHeader.svelte';
	import { cachedE2eeStatus, refreshE2eeStatus } from '$lib/dm/dmE2eeState';
	import { isPrivateConversationType, type PrivacyPolicy } from '$lib/privacy/privacyState';
	import { currentSavedServer } from '$lib/savedServers';
	import { getSocket } from '$lib/socket';
	import { composerChannelType, composerFieldLabel, composerPrivacyInput, composerReadsRoomStatus, composerRetention, composerRoomFact, holdComposerColophon } from './composerPrivacy';

	interface Props {
		isDMChannel?: boolean;
		channelId?: string | null;
		/** The room's kind ('text', 'dm', 'group', …); null while it is unknown. Omitted: read from the channel store. */
		channelType?: string | null;
		draftSurface?: string;
		paymentButtonEnabled?: boolean;
		/** The host knows the room will encrypt (display only: the send path asks the server's room status itself). */
		encryptSend?: boolean;
		/** The DM/group E2EE room status the host already holds. Omitted: the composer reads it for DMs and groups. */
		e2eeStatus?: E2eeRoomStatus | null;
		/** Retention for the colophon chip. Omitted: the masthead's privacy summary for this channel. */
		retention?: PrivacyPolicy | string | null;
		/** The privacy popover's Room fact. Omitted: "#general · Common Ground" or the conversation's name. */
		roomLabel?: string | null;
		/** The colophon under the field (privacy state, retention chip, newline hint). */
		showColophon?: boolean;
		replyingTo?: Message | null;
		composerVisible?: boolean;
		isTextareaFocused?: boolean;
		onExecuteCommand: (cmd: string) => Promise<void>;
		onOpenPaymentSheet: (prefill?: { amountInput?: string; description?: string; customerRef?: string }) => void;
	}

	let {
		isDMChannel = false,
		encryptSend = false,
		e2eeStatus,
		channelType,
		retention,
		roomLabel,
		showColophon = true,
		channelId = null,
		draftSurface = 'channel',
		paymentButtonEnabled = false,
		replyingTo = $bindable(null),
		composerVisible = $bindable(true),
		isTextareaFocused = $bindable(false),
		onExecuteCommand,
		onOpenPaymentSheet
	}: Props = $props();

	const dispatch = createEventDispatcher();
	type SendChatMessage = (
		channelId: string,
		text: string,
		type: string,
		opts?: Record<string, unknown>
	) => void | Promise<{ ok: boolean; reason?: string } | void>;
	const sendChatMessage = sendMessage as unknown as SendChatMessage;
	const resolveDmChannelId = "" as unknown as (u: User | null, t: User) => string;
	const openExistingDmSignal = dmPanelSignal as unknown as { set(v: { channelId: string; otherUser: User }): void };

	// Chat keys the composer by identity/channel. Capture ownership once; never
	// let a later channel selection redirect an upload or a split message.
	const draftChannel = untrack(() => channelId || get(currentChannel));
	const draftOwner = composerDrafts.open(draftChannel, captureGroupAccess(draftChannel), untrack(() => draftSurface));
	const restoredDraft = draftOwner.initial;
	let mounted = true;
	let isSending = $state(draftOwner.isSending());
	let commandBusy = $state(false);
	const operationCurrent = () => mounted && draftOwner.current();
	let messageInput = $state(restoredDraft?.text || '');
	let gifCaptionInput = $state(restoredDraft?.gifCaption || '');
	let editingMessage: Message | null = $state(restoredDraft?.editing || null);
	let textareaElement: HTMLTextAreaElement = $state();
	let fileInput: HTMLInputElement = $state();
	let typingTimeout: number;
	let lastTypingEmit = 0;
	let showEmojiPicker = $state(false);
	let emojiPickerButton: HTMLButtonElement = $state();
	let emojiPickerContainer: HTMLElement | null = $state(null);
	let EmojiPickerComponent: typeof import('../EmojiPicker.svelte').default | null = $state(null);
	let emojiPickerLoadFailed = $state(false);
	let emojiPickerLoadPromise: Promise<void> | null = null;
	let showMediaMenu = $state(false);
	let showCommandPalette = $state(false);
	let commandPaletteSelectedIndex = $state(0);
	let commandPalette: CommandPalette = $state();
	let showMentionSuggestions = $state(false);
	let mentionSuggestions: MentionSuggestion[] = $state([]);
	let sharedGameMentions: GameSelection[] = $state([]);
	let gameMentionsLoading = false;
	let gameMentionsLoaded = false;
	let gameMentionsScope = '';
	function currentGameMentionsScope(): string {
		const server = getServerUrl();
		return `${server}|${$currentUser?.dbUserId || ''}|${authSessionGeneration(server)}`;
	}
	let mentionSelectedIndex = $state(0);
	let mentionTokenStart = -1;
	let mentionMenuContainer: HTMLElement | null = $state(null);
	let showEmojiSuggestions = $state(false);
	let emojiSuggestions: Emoji[] = $state([]);
	let emojiSuggestionSelectedIndex = $state(0);
	let composerEntities: MessageEntity[] = $state(restoredDraft?.entities || []);
	let previousComposerInput = restoredDraft?.text || '';
	let selectedFiles: File[] = $state(restoredDraft?.files || []);
	let filePreviews: FilePreview[] = $state(buildPreviewEntries(restoredDraft?.files || []));
	let markAsSpoiler = $state(restoredDraft?.spoiler || false);
	let createAlbumFromUpload = $state(restoredDraft?.createAlbum || false);
	let uploadAlbumName = $state(restoredDraft?.albumName || '');
	/** Existing album the upload should be added to (0 = create new). */
	let uploadTargetAlbumId = $state<number>(0);
	let uploadAlbums: MediaAlbum[] = $state([]);
	let uploadAlbumsLoadedForScope = $state('');
	let isUploading = $state(false);
	let uploadProgress = $state(0);
	let uploadStatusLabel = $state('');
	let showCameraCapture = $state(false);
	let showAudioRecorder = $state(false);
	let manualSendTimestamps: number[] = [];
	let sendCooldownUntil = $state(0);
	let sendCooldownMessage = $state('');
	let sendCooldownTimer: ReturnType<typeof setTimeout> | null = null;
	let videoCompressionController: VideoCompressionController = $state();
	let unicodeComposerPreview = $state('');
	let unicodeComposerPreviewTokens = $state(0);
	let unicodeGifCaptionPreview = $state('');
	let unicodeGifCaptionPreviewTokens = $state(0);

	const TYPING_THROTTLE_MS = 300;
	const SEND_BURST_WINDOW_MS = 2500;
	const SEND_BURST_LIMIT = 5;
	const SEND_BURST_COOLDOWN_MS = 3000;
	/** The field grows upward to at most 40% of the stage (§7.20); never less than this. */
	const COMPOSER_MIN_MAX_HEIGHT = 160;
	const SEND_COOLDOWN_WORDS = 'Sending paused for a moment. Your message is still here.';
	const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
	const MAX_GIF_CAPTION_LENGTH = 280;
	const MAX_FILE_PREVIEW_IMAGES = 8;

	let composerSettings = $derived($composerEnhancementSettingsStore);
	let composerSpellcheckEnabled = $derived(composerSettings.spellcheckEnabled);
	let composerCharCounterEnabled = $derived(composerSettings.charCounterEnabled);
	let splitLargeMessagesEnabled = $derived(composerSettings.splitLargeMessagesEnabled);
	let splitLargeMessagesChunkSize = $derived(composerSettings.splitLargeMessagesChunkSize);
	let writeUpperCaseEnabled = $derived(composerSettings.writeUpperCaseEnabled);
	// Long-form text can be sent intact when splitting is off; Reader owns the display after 2,000 chars.
	let composerInputMaxLength = $derived(composerSettings.splitLargeMessagesInputMaxLength);
	let gifCaptionerEnabled = $derived($gifCaptionerSettingsStore.enabled);
	let gifCaptionerDedicatedCaptionFieldEnabled = $derived($gifCaptionerSettingsStore.dedicatedCaptionFieldEnabled);
	let unicodeEmojisEnabled = $derived($unicodeEmojiSettingsStore.enabled);
	let composerCharCount = $derived(messageInput.length);
	let composerCharCounterVisible = $derived(composerInputMaxLength > 0 && composerCharCount / composerInputMaxLength >= 0.7);
	let effectiveChannel = $derived(channelId || $currentChannel);
	// A spoiler channel forces every outgoing message to be a spoiler, and
	// the per-message spoiler checkbox is locked on so users can't opt out.
	let channelForceSpoiler = $derived($channels.find((ch) => ch.id === effectiveChannel)?.forceSpoiler || false);
	$effect(() => {
		if (channelForceSpoiler) markAsSpoiler = true;
	});

	// ---- the room this field writes into: its name and who can read it (§7.20, §9.2)
	const roomChannel = $derived($channels.find((ch) => ch.id === effectiveChannel) ?? null);
	const roomType = $derived(composerChannelType(channelType, roomChannel?.type, isDMChannel));
	const inConversation = $derived(isPrivateConversationType(roomType));
	const roomName = $derived.by(() => {
		if (!roomChannel) return null;
		if (roomChannel.type === 'dm') return getDMOtherUser(roomChannel, $currentUser, $userLookup)?.username || roomChannel.name || null;
		return roomChannel.name || null;
	});
	const fieldLabel = $derived(composerFieldLabel((key, options) => $_(key, options), { name: roomName, conversation: inConversation }));
	const roomFact = $derived(roomLabel !== undefined ? roomLabel : composerRoomFact({ name: roomName, conversation: inConversation, community: $currentSavedServer?.effectiveName }));
	// A DM or group opened in the channel stream has no host holding its E2EE status: read it
	// here, for the colophon only. A failed request leaves it on "Checking privacy…" and asks
	// again (2 s, 4 s, 8 s); a room update from the server asks at once.
	const hostGaveStatus = $derived(e2eeStatus !== undefined);
	let ownStatus = $state<E2eeRoomStatus | null>(null);
	$effect(() => {
		const id = effectiveChannel;
		if (!id || !composerReadsRoomStatus(roomType, hostGaveStatus)) {
			ownStatus = null;
			return;
		}
		ownStatus = cachedE2eeStatus(id);
		let live = true;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const ask = (attempt: number) => {
			refreshE2eeStatus(id)
				.then((status) => {
					if (live) ownStatus = status;
				})
				.catch(() => {
					if (live && attempt < 3) retry = setTimeout(() => ask(attempt + 1), 2000 * 2 ** attempt);
				});
		};
		ask(0);
		const sock = getSocket();
		const onRoomUpdate = (payload: { channelId?: string } | undefined) => {
			if (payload?.channelId === id) {
				clearTimeout(retry);
				ask(3);
			}
		};
		sock?.on?.('e2ee-room-updated', onRoomUpdate);
		return () => {
			live = false;
			clearTimeout(retry);
			sock?.off?.('e2ee-room-updated', onRoomUpdate);
		};
	});
	const privacyInput = $derived(composerPrivacyInput({ channelType: roomType, encryptSend, hostStatus: e2eeStatus, ownStatus, hostGaveStatus }));
	const keptSource = $derived(composerRetention(retention, $stagePrivacySummary, effectiveChannel));
	// While this colophon is on screen it says the channel's retention, so the masthead does not.
	$effect(() => {
		const id = effectiveChannel;
		if (!showColophon || !id) return;
		return holdComposerColophon(id);
	});
	// "Shift Enter for a new line" only while the field is focused and empty (§7.20).
	const composerUid = $props.id();
	const hintId = `composer-hint-${composerUid}`;
	const newlineHintShown = $derived(isTextareaFocused && messageInput.length === 0);
	const sendReady = $derived((selectedFiles.length > 0 || Boolean(messageInput.trim())) && !isUploading && !isSending && !commandBusy && sendCooldownUntil <= Date.now());
	const sendLabel = $derived(selectedFiles.length > 0 ? 'Send selected media' : $_('chat.compose.send_message'));
	const canCapture = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
	const attachItems = $derived.by<MenuEntry[]>(() => {
		const items: MenuEntry[] = [{ id: 'file', label: $_('chat.compose.upload_file'), icon: 'upload', onSelect: () => fileInput?.click() }];
		if (canCapture) {
			items.push({ id: 'photo', label: $_('chat.compose.take_photo'), icon: 'image', onSelect: () => { showCameraCapture = true; } });
			items.push({ id: 'audio', label: $_('chat.compose.record_audio'), icon: 'mic', onSelect: () => { showAudioRecorder = true; } });
		}
		// Phones have no emoji key in the field (the keyboard has emoji); the picker's GIFs stay here.
		// Opened after the click that chose it, so the outside-click close does not catch that click.
		if ($isMobile) items.push({ id: 'emoji', label: $_('chat.compose.add_emoji'), icon: 'smile', onSelect: () => { setTimeout(openEmojiPicker, 0); } });
		if (paymentButtonEnabled) {
			items.push({ id: 'payment-sep', type: 'separator' });
			items.push({ id: 'payment', label: 'Create payment request', icon: 'transfers', onSelect: () => onOpenPaymentSheet() });
		}
		return items;
	});
	function openEmojiPicker(): void {
		showEmojiPicker = true;
		showMediaMenu = false;
		ensureEmojiPickerLoaded();
	}
	let composerCharCounterWarn = $derived(composerInputMaxLength > 0 && composerCharCount / composerInputMaxLength >= 0.9);
	let gifCaptionDraftLength = $derived(gifCaptionInput.trim().length);
	let gifCaptionDraftWarn = $derived(gifCaptionDraftLength > 0 && gifCaptionDraftLength / MAX_GIF_CAPTION_LENGTH >= 0.9);
	let albumEligibleSelection = $derived(selectedFiles.length > 1 && selectedFiles.every(isAlbumEligibleFile));
	$effect(() => {
		if (!albumEligibleSelection && createAlbumFromUpload) { createAlbumFromUpload = false; uploadAlbumName = ''; }
	});
	$effect(() => { const p = previewUnicodeEmojiConversion(messageInput, $emojis as unknown as Emoji[]); unicodeComposerPreview = p.convertedText; unicodeComposerPreviewTokens = p.convertedTokens; });
	$effect(() => { const p = previewUnicodeEmojiConversion(gifCaptionInput, $emojis as unknown as Emoji[]); unicodeGifCaptionPreview = p.convertedText; unicodeGifCaptionPreviewTokens = p.convertedTokens; });

	function snapshotDraft(): ComposerDraft {
		// Svelte's snapshot structured-clones Files. Keep these immutable browser
		// objects by reference so a send can identify exactly which selection it
		// consumed across snapshots/remounts (and retain compression metadata).
		return { ...$state.snapshot({ text: messageInput, gifCaption: gifCaptionInput, entities: composerEntities,
			spoiler: markAsSpoiler, createAlbum: createAlbumFromUpload,
			albumName: uploadAlbumName, reply: replyingTo, editing: editingMessage }), files: [...selectedFiles] };
	}
	function applySettledDraft(next: ComposerDraft): void {
		if (selectedFiles.length !== next.files.length || selectedFiles.some((file, i) => file !== next.files[i])) {
			for (const preview of filePreviews) {
				revokePreviewUrl(preview.preview);
				if (!next.files.includes(preview.file)) videoCompressionController?.deleteCompressionMetadata(preview.file);
			}
			selectedFiles = next.files;
			filePreviews = buildPreviewEntries(next.files);
		}
		messageInput = next.text; gifCaptionInput = next.gifCaption; composerEntities = next.entities;
		previousComposerInput = next.text; replyingTo = next.reply; markAsSpoiler = next.spoiler;
		createAlbumFromUpload = next.createAlbum; uploadAlbumName = next.albumName;
	}

	export function focus(): void { textareaElement?.focus(); }
	export function handleCommandPaletteKeyDown(key: string): boolean { return commandPalette?.handleKeyDown(key) || false; }
	export async function receiveFiles(files: File[], mode: 'replace' | 'append'): Promise<void> { const prepared = await prepareIncomingFiles(files); if (operationCurrent() && prepared.length > 0) applySelectedFiles(prepared, mode); }
	export function insertQuickMention(username: string): void { const token = `@${username}`; const needsSpace = messageInput.length > 0 && !/\s$/.test(messageInput); const next = needsSpace ? `${messageInput} ${token} ` : `${token} `; composerEntities = reconcileMessageEntities(messageInput, next, composerEntities); messageInput = next; previousComposerInput = messageInput; showMentionSuggestions = false; textareaElement?.focus(); }
	export function startEditingLastMessage(): void { const messages = $channelMessages[effectiveChannel] || []; const userMessages = messages.filter((m: Message) => m.userId === $currentUser?.id); if (userMessages.length > 0) { const last = userMessages[userMessages.length - 1]; editingMessage = last; messageInput = last.text; composerEntities = []; previousComposerInput = messageInput; } }
	function syncComposerEntities() { composerEntities = reconcileMessageEntities(previousComposerInput, messageInput, composerEntities); previousComposerInput = messageInput; }
	function resetComposerEntityState() { composerEntities = []; previousComposerInput = messageInput; }
	function resolveOutgoingPlaceEntities(text: string): MessageEntity[] { if (!composerEntities.length || !text) return []; return rebaseMessageEntitiesForText(text, composerEntities); }
	function composerMaxHeight(): number {
		const stage = textareaElement?.closest('.chat-container, .dm-conversation, .right-panel') as HTMLElement | null;
		const height = stage?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
		// 40% of the stage for the whole field; the textarea is the field less its 12px padding.
		return Math.max(COMPOSER_MIN_MAX_HEIGHT, Math.floor(height * 0.4) - 12);
	}
	function autoResizeTextarea() { if (!textareaElement) return; textareaElement.style.height = 'auto'; textareaElement.style.height = `${Math.min(textareaElement.scrollHeight, composerMaxHeight())}px`; }
	function handleInput() { autoResizeTextarea(); const now = Date.now(); if (now - lastTypingEmit >= TYPING_THROTTLE_MS) { sendTyping(true, effectiveChannel); lastTypingEmit = now; } if (typingTimeout) clearTimeout(typingTimeout); typingTimeout = setTimeout(() => sendTyping(false, effectiveChannel), 1000) as unknown as number; }
	function handleInputChange() {
		syncComposerEntities();
		if (gameMentionsScope !== currentGameMentionsScope()) {
			sharedGameMentions = [];
			gameMentionsLoaded = false;
		}
		if (messageInput.startsWith('/')) { showCommandPalette = getMatchingCommands(messageInput).length > 0; showMentionSuggestions = false; }
		else { showCommandPalette = false; const caret = textareaElement?.selectionStart ?? messageInput.length; if (!$placeRegistry.length) void loadPlaceRegistry(); if (/@game(?::[^\s]*)?$/i.test(messageInput.slice(0, caret))) void loadGameMentionChoices(); const result = computeMentionSuggestions(messageInput, caret, mentionDirectory($serverMembers as User[], $users as User[]), $currentUser?.id, $placeRegistry, sharedGameMentions); if (result.show) { mentionTokenStart = result.tokenStart; mentionSuggestions = result.suggestions; mentionSelectedIndex = 0; showMentionSuggestions = true; } else showMentionSuggestions = false; updateEmojiSuggestions(caret); }
	}
	async function loadGameMentionChoices(): Promise<void> {
		if (gameMentionsLoading || gameMentionsLoaded) return;
		gameMentionsLoading = true;
		const scope = currentGameMentionsScope();
		const games = await loadSharedGamesForMentions();
		gameMentionsLoading = false;
		if (!operationCurrent() || scope !== currentGameMentionsScope()) return;
		gameMentionsScope = scope;
		gameMentionsLoaded = true;
		sharedGameMentions = games;
		const caret = textareaElement?.selectionStart ?? messageInput.length;
		const result = computeMentionSuggestions(messageInput, caret, mentionDirectory($serverMembers as User[], $users as User[]), $currentUser?.id, $placeRegistry, sharedGameMentions);
		if (result.show) { mentionTokenStart = result.tokenStart; mentionSuggestions = result.suggestions; mentionSelectedIndex = 0; showMentionSuggestions = true; }
	}
	function updateEmojiSuggestions(caret: number): void {
		const match = messageInput.slice(0, caret).match(/(^|\s):([\w+_-]*)$/);
		if (!match) { showEmojiSuggestions = false; emojiSuggestions = []; return; }
		const query = (match[2] || '').toLowerCase();
		emojiSuggestions = ($emojis as unknown as Emoji[]).filter((emoji) => (emoji.type || 'emoji') === 'emoji' && emoji.name.toLowerCase().startsWith(query)).slice(0, 12);
		emojiSuggestionSelectedIndex = 0;
		showEmojiSuggestions = emojiSuggestions.length > 0;
	}
	async function applyEmojiSuggestion(index: number): Promise<void> {
		const caret = textareaElement?.selectionStart ?? messageInput.length;
		const match = messageInput.slice(0, caret).match(/(^|\s):([\w+_-]*)$/);
		const emoji = emojiSuggestions[index];
		if (!match || !emoji) return;
		const start = caret - match[0].length + match[1].length;
		messageInput = `${messageInput.slice(0, start)}:${emoji.name}: ${messageInput.slice(caret)}`;
		showEmojiSuggestions = false;
		await tick();
		textareaElement?.focus();
		textareaElement?.setSelectionRange(start + emoji.name.length + 3, start + emoji.name.length + 3);
	}
	async function applyMentionSuggestion(index: number) {
		if (!textareaElement || index < 0 || index >= mentionSuggestions.length || mentionTokenStart < 0) return;
		const caret = textareaElement.selectionStart ?? messageInput.length;
		const applied = applyMentionToInput(messageInput, composerEntities, mentionSuggestions[index], mentionTokenStart, caret);
		messageInput = applied.input;
		composerEntities = applied.entities;
		previousComposerInput = messageInput;
		showMentionSuggestions = false;
		mentionTokenStart = -1;
		await tick();
		textareaElement.focus();
		textareaElement.setSelectionRange(applied.cursor, applied.cursor);
	}
	function handleKeyDown(e: KeyboardEvent) {
		if (showEmojiSuggestions) {
			if (e.key === 'ArrowDown') { e.preventDefault(); emojiSuggestionSelectedIndex = (emojiSuggestionSelectedIndex + 1) % emojiSuggestions.length; return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); emojiSuggestionSelectedIndex = (emojiSuggestionSelectedIndex - 1 + emojiSuggestions.length) % emojiSuggestions.length; return; }
			if (e.key === 'Tab') { e.preventDefault(); void applyEmojiSuggestion(emojiSuggestionSelectedIndex); return; }
			if (e.key === 'Escape') { e.preventDefault(); showEmojiSuggestions = false; return; }
		}
		if (showMentionSuggestions) {
			if (e.key === 'ArrowDown') { e.preventDefault(); mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionSuggestions.length; return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionSuggestions.length) % mentionSuggestions.length; return; }
			if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); void applyMentionSuggestion(mentionSelectedIndex); return; }
			if (e.key === 'Escape') { e.preventDefault(); showMentionSuggestions = false; return; }
		}
		if (showCommandPalette) { const handled = commandPalette?.handleKeyDown(e.key); if (handled) { e.preventDefault(); return; } }
		if (e.key === 'ArrowUp' && !messageInput.trim() && !editingMessage) { e.preventDefault(); startEditingLastMessage(); }
		else if (e.key === 'Escape') { e.preventDefault(); if (showCommandPalette) showCommandPalette = false; else if (editingMessage) cancelEdit(); }
		else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
	}
	function handleCommandSelect(command: Command) { messageInput = `/${command.name} `; resetComposerEntityState(); showCommandPalette = false; textareaElement?.focus(); }
	async function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (let i = 0; i < items.length; i++) { const item = items[i]; if (item.kind === 'file') { const f = item.getAsFile(); if (f) { e.preventDefault(); files.push(f); } } }
		if (files.length > 0) { await receiveFiles(files, 'append'); return; }
		const text = e.clipboardData?.getData('text');
		if (text && text.trim()) handleInput();
	}
	function resolveOutgoingAttachmentCaption(): string | null { if (!gifCaptionerEnabled) return ''; const src = gifCaptionerDedicatedCaptionFieldEnabled ? gifCaptionInput : messageInput; return processAttachmentCaption(src, { maxLength: MAX_GIF_CAPTION_LENGTH, writeUpperCaseEnabled, unicodeEmojisEnabled, emojis: $emojis as unknown as Emoji[] }); }
	function cancelEdit() { editingMessage = null; messageInput = ''; resetComposerEntityState(); if (textareaElement) textareaElement.style.height = 'auto'; }
	function cancelReply() { replyingTo = null; }
	function clearAfterSend() { messageInput = ''; resetComposerEntityState(); showMentionSuggestions = false; showMediaMenu = false; sendCooldownMessage = ''; sendTyping(false, effectiveChannel); if (typingTimeout) clearTimeout(typingTimeout); if (textareaElement) textareaElement.style.height = 'auto'; textareaElement?.focus(); }
	async function handleSubmit() {
		if (isSending || commandBusy || isUploading || !operationCurrent()) return;
		const hasFiles = selectedFiles.length > 0;
		const hasText = Boolean(messageInput.trim());
		if (!hasFiles && !hasText) return;
		if (sendCooldownUntil > Date.now()) {
			sendCooldownMessage = SEND_COOLDOWN_WORDS;
			return;
		}
		if (hasFiles) {
			void uploadSelectedFiles();
			return;
		}
		if (editingMessage) {
			editMessage(effectiveChannel, editingMessage.id, messageInput.trim());
			editingMessage = null;
			clearAfterSend();
			return;
		}

		const processed = processOutgoingText(messageInput.trim(), {
			writeUpperCaseEnabled,
			unicodeEmojisEnabled,
			emojis: $emojis as unknown as Emoji[]
		});
		if (processed.blocked) {
			showToast(processed.reason, 'warning');
			return;
		}
		if (!processed.text) {
			showToast('Message is empty after processing.', 'warning');
			return;
		}

		const now = Date.now();
		const burst = checkSendBurst(manualSendTimestamps, now, SEND_BURST_LIMIT, SEND_BURST_WINDOW_MS);
		manualSendTimestamps = burst.updatedTimestamps;
		if (!burst.allowed) {
			sendCooldownUntil = now + SEND_BURST_COOLDOWN_MS;
			sendCooldownMessage = SEND_COOLDOWN_WORDS;
			if (sendCooldownTimer) clearTimeout(sendCooldownTimer);
			sendCooldownTimer = setTimeout(() => {
				sendCooldownUntil = 0;
				sendCooldownMessage = '';
				sendCooldownTimer = null;
			}, SEND_BURST_COOLDOWN_MS);
			return;
		}

		if (processed.text.startsWith('/')) {
			const inputAtSubmit = messageInput;
			commandBusy = true;
			try {
				await onExecuteCommand(processed.text);
				if (operationCurrent() && messageInput === inputAtSubmit) clearAfterSend();
			} catch (error) {
				if (operationCurrent()) showToast(error instanceof Error ? error.message : 'Command was not sent. Try again.', 'error');
			} finally {
				commandBusy = false;
			}
			return;
		}

		if (!effectiveChannel) {
			showToast('No channel selected.', 'error');
			return;
		}

		const normalizedEntities = resolveOutgoingPlaceEntities(processed.text);
		const replyId = replyingTo?.id;
		const spoiler = markAsSpoiler;

		const payloads: Array<{ text: string; type: string; opts: Record<string, unknown> }> = [];
		if (splitLargeMessagesEnabled && processed.text.length > splitLargeMessagesChunkSize) {
			const chunks = splitMessageForSending(processed.text, splitLargeMessagesChunkSize);
			if (chunks.length === 0) {
				showToast('Unable to split message into chunks.', 'error');
				return;
			}
			const chunkEntities = splitEntitiesForChunks(processed.text, chunks, normalizedEntities);
			for (const [i, chunk] of chunks.entries()) {
				payloads.push({
					text: chunk,
					type: 'text',
					opts: {
						replyTo: i === 0 ? replyId : undefined,
						isSpoiler: spoiler,
						entities: chunkEntities[i]
					}
				});
			}
		} else {
			// The shared send boundary encrypts exactly once, after message-kind
			// detection. Encrypting here as well nested an E2EE envelope inside a
			// second one and made the recipient see ciphertext after decryption.
			const kind = detectMessageKind(processed.text, $emojis as unknown as Emoji[]);
			if (kind.type === 'emoji') {
				payloads.push({
					text: processed.text,
					type: 'emoji',
					opts: {
						emojiUrl: kind.emojiUrl,
						emojiName: kind.emojiName,
						replyTo: replyId,
						isSpoiler: spoiler
					}
				});
			} else {
				payloads.push({
					text: processed.text,
					type: 'text',
					opts: {
						replyTo: replyId,
						isSpoiler: spoiler,
						entities: normalizedEntities
					}
				});
			}
		}

		// A handed-off chunk is no longer a draft. Track the pending handoff
		// through remounts, but only this mounted owner may submit the next part.
		draftOwner.save(snapshotDraft());
		const transaction = draftOwner.beginSend();
		if (!transaction) return;
		let pendingText = messageInput;
		try {
			const result = await sendComposerBatch({
				payloads,
				canContinue: operationCurrent,
				send: payload => sendChatMessage(draftChannel, payload.text, payload.type, payload.opts),
				accepted: sent => {
					const remaining = payloads.slice(sent);
					const text = remaining.map(payload => payload.text).join('\n\n');
					let offset = 0;
					const entities = remaining.flatMap(payload => {
						const next = ((payload.opts.entities as MessageEntity[] | undefined) || []).map(entity => ({ ...entity, start: entity.start + offset, end: entity.end + offset }));
						offset += payload.text.length + 2;
						return next;
					});
					const expectedText = pendingText;
					const clearSpoiler = remaining.length === 0 && !channelForceSpoiler;
					transaction.settle(draft => settleComposerText(draft, { expectedText, text, entities, replyId, spoiler, clearSpoiler }));
					pendingText = text;
				}
			});
			if (!operationCurrent()) return;
			if (result.reason) {
				showToast(result.sent > 0 ? `Sent ${result.sent} of ${payloads.length} parts. The unsent remainder is still in your draft.` : 'Message could not be sent or queued. Your draft is unchanged.', 'error');
			} else if (!messageInput) {
				showMentionSuggestions = false; showMediaMenu = false; sendCooldownMessage = '';
				sendTyping(false, draftChannel);
				if (typingTimeout) clearTimeout(typingTimeout);
				textareaElement?.focus();
			}
		} finally { transaction.finish(); }
	}
	async function handleGifSelect(event: CustomEvent<string>) {
		if (isSending || isUploading || !operationCurrent()) return;
		const submittedInput = messageInput;
		const submittedCaption = gifCaptionInput;
		const caption = resolveOutgoingAttachmentCaption();
		if (caption === null) return;
		if (!effectiveChannel) {
			showToast('No channel selected.', 'error');
			return;
		}
		const submittedReplyId = replyingTo?.id;
		const submittedSpoiler = markAsSpoiler;
		const dedicatedCaption = gifCaptionerDedicatedCaptionFieldEnabled;
		draftOwner.save(snapshotDraft());
		const transaction = draftOwner.beginSend();
		if (!transaction) return;
		try {
		const result = await sendComposerBatch({
			payloads: [event.detail], canContinue: operationCurrent,
			send: gifUrl => sendChatMessage(draftChannel, caption, 'gif', {
				gifUrl,
				replyTo: submittedReplyId,
				isSpoiler: submittedSpoiler,
				entities: resolveOutgoingPlaceEntities(caption)
			}),
			accepted: () => transaction.settle(draft => {
				if (draft.text !== submittedInput || draft.gifCaption !== submittedCaption) return draft;
				return { ...draft, text: dedicatedCaption ? draft.text : '', gifCaption: dedicatedCaption ? '' : draft.gifCaption,
					entities: dedicatedCaption ? draft.entities : [],
					reply: draft.reply?.id === submittedReplyId ? null : draft.reply,
					spoiler: !channelForceSpoiler && draft.spoiler === submittedSpoiler ? false : draft.spoiler };
			})
		});
		if (!operationCurrent()) return;
		if (result.reason) { showToast('GIF could not be sent or queued. Your draft is unchanged.', 'error'); return; }
		showMentionSuggestions = false;
		showEmojiPicker = false;
		showMediaMenu = false;
		sendTyping(false, effectiveChannel);
		if (typingTimeout) clearTimeout(typingTimeout);
		if (textareaElement) textareaElement.style.height = 'auto';
		textareaElement?.focus();
		} finally { transaction.finish(); }
	}
	function handleEmojiSelect(event: CustomEvent<{ emoji: Emoji }>) {
		const { emoji } = event.detail;
		showEmojiPicker = false;
		showMediaMenu = false;
		// Remember this emoji for the quick-reaction strip on every message,
		// not just the current one (Discord-style recency, cap 12).
		try {
			addQuickReactionCustomEmojiId(emoji.id);
		} catch {
			// best-effort; recency memory must never block inserting the emoji
		}
		const token = `:${emoji.name}:`;
		const needsSpace = messageInput.length > 0 && !/\s$/.test(messageInput);
		const next = needsSpace ? `${messageInput} ${token}` : `${messageInput}${token}`;
		composerEntities = reconcileMessageEntities(messageInput, next, composerEntities);
		messageInput = next;
		previousComposerInput = messageInput;
		textareaElement?.focus();
	}
	function clearFilePreviews(): void { videoCompressionController?.clearCompressionMetadata(filePreviews.map(i => i.file)); for (const item of filePreviews) revokePreviewUrl(item.preview); filePreviews = []; selectedFiles = []; createAlbumFromUpload = false; uploadAlbumName = ''; }
	function applySelectedFiles(files: File[], mode: 'replace' | 'append'): void { if (mode === 'replace') { clearFilePreviews(); selectedFiles = files; filePreviews = buildPreviewEntries(files); } else { selectedFiles = [...selectedFiles, ...files]; filePreviews = [...filePreviews, ...buildPreviewEntries(files)]; } const b = enforcePreviewBudget(filePreviews, selectedFiles, MAX_FILE_PREVIEW_IMAGES); filePreviews = b.previews; selectedFiles = b.files; }
	async function prepareIncomingFiles(files: File[]): Promise<File[]> { for (const file of files) { if (file.size > MAX_UPLOAD_FILE_BYTES) { showToast(`File too large! Maximum size is 1GB per file. "${file.name}" is ${formatFileMb(file.size)}MB`, 'error'); return []; } } const prepared: File[] = []; for (const file of files) { const candidate = videoCompressionController ? await videoCompressionController.maybeCompressVideoFile(file) : file; if (candidate) prepared.push(candidate); } return prepared; }
	async function handleFileSelect(event: Event) { const input = event.target as HTMLInputElement; const files = Array.from(input.files || []); if (files.length === 0) return; await receiveFiles(files, 'replace'); input.value = ''; }
	function removeFile(index: number) { const removed = filePreviews[index]; revokePreviewUrl(removed?.preview); if (removed?.file) videoCompressionController?.deleteCompressionMetadata(removed.file); selectedFiles = selectedFiles.filter((_, i) => i !== index); filePreviews = filePreviews.filter((_, i) => i !== index); }
	function handleAlbumUploadToggle(checked: boolean): void { createAlbumFromUpload = checked; if (!checked) { uploadAlbumName = ''; uploadTargetAlbumId = 0; return; } if (!uploadAlbumName.trim()) uploadAlbumName = buildDefaultUploadAlbumName($channels.find(ch => ch.id === effectiveChannel)?.name || effectiveChannel, messageInput); void loadUploadAlbums(); }
	async function loadUploadAlbums(): Promise<void> {
		const activeChannel = $channels.find(ch => ch.id === effectiveChannel);
		if (!activeChannel || !getAuthToken()) return;
		const scopeType = (activeChannel.type === 'dm' || activeChannel.type === 'group' ? 'dm' : 'channel') as any;
		const scopeId = activeChannel.id;
		const scopeKey = `${scopeType}:${scopeId}`;
		if (uploadAlbumsLoadedForScope === scopeKey) return;
		try {
			const { listMediaAlbums } = await import('$lib/api');
			const token = getAuthToken();
			if (!token) return;
			uploadAlbums = await listMediaAlbums(token, scopeType, scopeId, 100);
			uploadAlbumsLoadedForScope = scopeKey;
		} catch {
			uploadAlbums = [];
		}
	}
	async function uploadSelectedFiles() {
		if (selectedFiles.length === 0 || isUploading || isSending || !operationCurrent()) return;
		const submitted = snapshotDraft();
		const activeChannel = $channels.find(ch => ch.id === effectiveChannel);
		const dmOtherUser = activeChannel?.type === 'dm' ? getDMOtherUser(activeChannel, $currentUser, $userLookup) : null;
		const dmOtherDbUserId = typeof dmOtherUser?.dbUserId === 'number' ? dmOtherUser.dbUserId : null;
		const authToken = getAuthToken();
		const albumScope = createAlbumFromUpload ? getMediaAlbumScope(activeChannel as {type:string; id:string} | undefined) : null;
		if (createAlbumFromUpload && !authToken) { showToast('Sign in with a registered account to turn multi-photo uploads into an album.', 'warning'); return; }
		if (createAlbumFromUpload && !albumScope) { showToast('Cannot determine album scope for this upload.', 'error'); return; }
		isUploading = true;
		uploadStatusLabel = get(_)('chat.upload.uploading');
		uploadProgress = 0;
		try {
			const captionEntities = resolveOutgoingPlaceEntities(messageInput.trim());
			const spec = await orchestrateUpload({ files: submitted.files, channelId: draftChannel, channelType: activeChannel?.type || 'channel', dmChannelId: activeChannel?.type === 'dm' ? activeChannel.id : undefined, dmOtherDbUserId, authToken, messageInput: submitted.text.trim(), replyToId: submitted.reply?.id, markAsSpoiler: submitted.spoiler, captionEntities, createAlbum: submitted.createAlbum, albumName: submitted.albumName, albumScopeType: (albumScope?.scopeType ?? null) as any, albumScopeId: albumScope?.scopeId ?? null, targetAlbumId: uploadTargetAlbumId > 0 ? uploadTargetAlbumId : null, getCompressionMetadata: f => videoCompressionController?.getCompressionMetadata(f), onProgress: pct => { uploadProgress = pct; }, isCurrent: operationCurrent });
			if (!operationCurrent()) return;
			// Only an issued message handoff survives retirement. Upload requests
			// still stop when their editor leaves; an accepted handoff must consume
			// its files in the replacement draft instead of inviting a duplicate.
			draftOwner.save(snapshotDraft());
			const transaction = draftOwner.beginSend();
			if (!transaction) return;
			try {
				const result = await sendComposerBatch({ payloads: [spec], canContinue: operationCurrent,
					send: payload => sendChatMessage(draftChannel, payload.text, payload.type, payload.options),
					accepted: () => transaction.settle(draft => settleComposerUpload(draft, submitted, !channelForceSpoiler)) });
				if (!operationCurrent()) return;
				if (result.reason) {
					showToast('Files uploaded, but the message could not be sent or queued. Your draft is still available.', 'error');
					return;
				}
				textareaElement?.focus();
			} finally { transaction.finish(); }
		} catch (error) { if (operationCurrent()) { console.error('Upload error:', error); showToast('Failed to upload files. Please try again.', 'error'); } } finally { isUploading = false; uploadStatusLabel = ''; uploadProgress = 0; }
	}
	async function handlePhotoCapture(event: CustomEvent<Blob>) { const blob = event.detail; const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }); if (file.size > 10 * 1024 * 1024) { showToast('Photo too large (max 10MB). Please try again.', 'error'); return; } clearFilePreviews(); selectedFiles = [file]; filePreviews = buildPreviewEntries([file]); await uploadSelectedFiles(); showCameraCapture = false; showMediaMenu = false; }
	async function handleAudioSend(event: CustomEvent<Blob>) { const blob = event.detail; const ext = blob.type.includes('webm') ? 'weba' : 'm4a'; const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: blob.type }); if (file.size > 10 * 1024 * 1024) { showToast('Audio too large (max 10MB). Please try again.', 'error'); return; } clearFilePreviews(); selectedFiles = [file]; filePreviews = buildPreviewEntries([file]); await uploadSelectedFiles(); showAudioRecorder = false; showMediaMenu = false; }
	function ensureEmojiPickerLoaded(): void { if (EmojiPickerComponent || emojiPickerLoadPromise) return; emojiPickerLoadFailed = false; emojiPickerLoadPromise = import('../EmojiPicker.svelte').then(mod => { EmojiPickerComponent = mod.default; }).catch(err => { console.error('Failed to load EmojiPicker:', err); emojiPickerLoadFailed = true; }).finally(() => { emojiPickerLoadPromise = null; }); }
	// The attach menu (ui/Menu) closes itself on an outside click, Esc or Tab.
	function handleGlobalClick(event: MouseEvent) { const target = event.target as Node | null; if (target && emojiPickerContainer?.contains(target)) return; if (target && mentionMenuContainer?.contains(target)) return; showEmojiPicker = false; showMentionSuggestions = false; }
	onMount(() => {
		// An already-issued handoff may settle between construction and mount.
		const latestDraft = draftOwner.read();
		if (latestDraft && latestDraft !== restoredDraft) {
			applySettledDraft(latestDraft);
		}
		replyingTo = latestDraft?.reply || null;
		isSending = draftOwner.isSending();
		const unsubscribeSend = draftOwner.onSendState((pending, update) => {
			if (!operationCurrent()) return;
			isSending = pending;
			if (update) {
				const snapshot = snapshotDraft();
				const next = update(snapshot);
				if (next !== snapshot) {
					applySettledDraft(next);
					draftOwner.save(next); autoResizeTextarea();
				}
			}
		});
		autoResizeTextarea(); document.addEventListener('click', handleGlobalClick); void loadPlaceRegistry();
		return () => { unsubscribeSend(); document.removeEventListener('click', handleGlobalClick); };
	});
	onDestroy(() => {
		draftOwner.save(snapshotDraft());
		mounted = false;
		if (typingTimeout) clearTimeout(typingTimeout);
		clearFilePreviews();
		if (sendCooldownTimer) { clearTimeout(sendCooldownTimer); sendCooldownTimer = null; }
	});
</script>

<VideoCompressionController bind:this={videoCompressionController} />

<CameraCapture isOpen={showCameraCapture} on:close={() => (showCameraCapture = false)} on:capture={handlePhotoCapture} />
<AudioRecorder isOpen={showAudioRecorder} on:close={() => (showAudioRecorder = false)} on:send={handleAudioSend} />

<!-- The footer band (§7.20, D20, D21): the field's top edge sits on the footer rule and spans the
     stream's avatar column to its page edge; the colophon says who can read this room. Anything
     the draft needs above the field (reply, files, progress) stacks upward from it. -->
<div class="composer" class:composer--hidden={$isMobile && !composerVisible}>
	<div class="composer__page">
		{#if showEmojiPicker}
			<!-- Anchored inside the page (position: relative) as an overlay popover, like the
				 mention suggestions, so opening it never pushes the message list. -->
			<div class="emoji-picker-container" bind:this={emojiPickerContainer}>
				{#if EmojiPickerComponent}
					<EmojiPickerComponent on:select={handleEmojiSelect} on:gif={handleGifSelect} on:close={() => (showEmojiPicker = false)} />
				{:else if emojiPickerLoadFailed}
					<div class="emoji-picker-loading error" role="alert">
						<span>The emoji and GIF panel didn't load.</span>
						<button type="button" class="w-btn w-btn--sm" onclick={stopPropagation(ensureEmojiPickerLoaded)}>Retry</button>
					</div>
				{:else}
					<div class="emoji-picker-loading">{$_('emoji_picker.loading')}</div>
				{/if}
			</div>
		{/if}
		{#if showMentionSuggestions && mentionSuggestions.length > 0}<MentionSuggestions suggestions={mentionSuggestions} selectedIndex={mentionSelectedIndex} bind:container={mentionMenuContainer} onApply={applyMentionSuggestion} />{/if}
		{#if showEmojiSuggestions}<EmojiSuggestions suggestions={emojiSuggestions} selectedIndex={emojiSuggestionSelectedIndex} onApply={applyEmojiSuggestion} />{/if}
		<EditReplyStatus {editingMessage} {replyingTo} onCancelEdit={cancelEdit} onCancelReply={cancelReply} />
		{#if filePreviews.length > 0 && !isUploading}<FileUploadPreview {filePreviews} bind:markAsSpoiler spoilerLocked={channelForceSpoiler} {albumEligibleSelection} {createAlbumFromUpload} bind:uploadAlbumName albums={uploadAlbums} bind:targetAlbumId={uploadTargetAlbumId} onAlbumTargetChange={(id) => (uploadTargetAlbumId = id)} buildDefaultUploadAlbumName={() => buildDefaultUploadAlbumName($channels.find(ch => ch.id === effectiveChannel)?.name || effectiveChannel, messageInput)} onAlbumUploadToggle={handleAlbumUploadToggle} onCancelUpload={clearFilePreviews} onRemoveFile={removeFile} onUploadSelectedFiles={uploadSelectedFiles} />{/if}
		{#if isUploading}
			<div class="composer__progress" role="status" aria-live="polite">
				<span class="composer__progress-words"><span>{uploadStatusLabel || $_('chat.upload.uploading')}</span><span class="composer__progress-count">{uploadProgress}%</span></span>
				<span class="composer__progress-track" aria-hidden="true"><span class="composer__progress-fill" style:width={`${uploadProgress}%`}></span></span>
			</div>
		{/if}
		<input type="file" bind:this={fileInput} onchange={handleFileSelect} multiple hidden />
		{#if sendCooldownMessage}<div class="composer__notice" role="status" aria-live="polite"><Icon name="clock" size={14} /><span>{sendCooldownMessage}</span></div>{/if}
		{#if unicodeEmojisEnabled && unicodeComposerPreviewTokens > 0 && unicodeComposerPreview !== messageInput}<div class="composer__aside unicode-conversion-hint">Unicode preview: {unicodeComposerPreview}</div>{/if}
		{#if gifCaptionerEnabled && gifCaptionerDedicatedCaptionFieldEnabled}<div class="gif-caption-draft-row"><input type="text" class="w-field gif-caption-draft-input" bind:value={gifCaptionInput} maxlength={MAX_GIF_CAPTION_LENGTH} placeholder="GIF caption (used when sending from the GIF picker)" aria-label="GIF caption" /><span class="gif-caption-draft-count" class:warn={gifCaptionDraftWarn}>{gifCaptionDraftLength} / {MAX_GIF_CAPTION_LENGTH}</span></div>{#if unicodeEmojisEnabled && unicodeGifCaptionPreviewTokens > 0 && unicodeGifCaptionPreview !== gifCaptionInput}<div class="composer__aside unicode-conversion-hint">GIF caption preview: {unicodeGifCaptionPreview}</div>{/if}{/if}
		<div class="composer__field" data-toast-anchor>
			<CommandPalette bind:this={commandPalette} bind:input={messageInput} bind:isVisible={showCommandPalette} bind:selectedIndex={commandPaletteSelectedIndex} onSelect={handleCommandSelect} />
			<textarea class="composer__input" bind:this={textareaElement} bind:value={messageInput} onpaste={handlePaste} oninput={() => { handleInput(); handleInputChange(); }} onkeydown={handleKeyDown} onfocus={() => { isTextareaFocused = true; composerVisible = true; }} onblur={() => { isTextareaFocused = false; }} placeholder={fieldLabel} aria-label={fieldLabel} aria-describedby={showColophon && newlineHintShown ? hintId : undefined} maxlength={composerInputMaxLength} spellcheck={composerSpellcheckEnabled} enterkeyhint="send" rows="1"></textarea>
			{#if composerCharCounterEnabled && composerCharCounterVisible}<span class="composer__counter" class:composer__counter--warn={composerCharCounterWarn}>{composerCharCount} / {composerInputMaxLength}</span>{/if}
			<div class="composer__tools">
				<Tooltip text={$_('chat.compose.attach')}>
					<Menu
						items={attachItems}
						label={$_('chat.compose.add_media')}
						triggerLabel={$_('chat.compose.attach')}
						class="w-ibtn composer__tool"
						align="end"
						heading={$isMobile ? $_('chat.compose.add_media') : null}
						bind:open={showMediaMenu}
						onopenchange={(open) => { if (open) showEmojiPicker = false; }}
					>
						<Icon name="clip" />
					</Menu>
				</Tooltip>
				{#if !$isMobile}
					<Tooltip text={$_('chat.compose.add_emoji')}>
						<button
							bind:this={emojiPickerButton}
							type="button"
							class="w-ibtn composer__tool"
							aria-label={$_('chat.compose.add_emoji')}
							aria-haspopup="dialog"
							aria-expanded={showEmojiPicker}
							onclick={stopPropagation(() => { if (showEmojiPicker) showEmojiPicker = false; else openEmojiPicker(); })}
						><Icon name="smile" /></button>
					</Tooltip>
				{/if}
				<Tooltip text={sendLabel} shortcut={sendReady && selectedFiles.length === 0 ? 'Enter' : undefined}>
					<button
						type="button"
						class="w-ibtn composer__send"
						class:composer__send--ready={sendReady}
						aria-label={sendLabel}
						aria-disabled={!sendReady}
						onclick={() => { if (sendReady) void handleSubmit(); }}
					><Icon name="send" /></button>
				</Tooltip>
			</div>
		</div>
		{#if showColophon}
			<div class="composer__colophon">
				<PrivacyBadge variant="colophon" input={privacyInput} room={roomFact} retention={keptSource} />
				<span class="composer__hint" class:composer__hint--shown={newlineHintShown} id={hintId}>{$_('chat.compose.newline_hint')}</span>
			</div>
		{/if}
	</div>
</div>
