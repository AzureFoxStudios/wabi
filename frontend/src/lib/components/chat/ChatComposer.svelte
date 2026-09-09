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
	import { getAuthToken } from '$lib/authSession';
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
	import { applyMentionToInput, computeMentionSuggestions } from './mentionSuggestions';
	import { checkSendBurst, detectMessageKind, processAttachmentCaption, processOutgoingText } from './messageSend';
	import { orchestrateUpload } from './uploadOrchestrator';
	import VideoCompressionController from './VideoCompressionController.svelte';
	import type { MediaAlbumScopeType } from '$lib/api';
	import type { FilePreview } from './fileHandlers';
	import type { MentionSuggestion } from './types';

	interface Props {
		isDMChannel?: boolean;
		channelId?: string | null;
		draftSurface?: string;
		paymentButtonEnabled?: boolean;
		replyingTo?: Message | null;
		composerVisible?: boolean;
		isTextareaFocused?: boolean;
		onExecuteCommand: (cmd: string) => Promise<void>;
		onOpenPaymentSheet: (prefill?: { amountInput?: string; description?: string; customerRef?: string }) => void;
	}

	let {
		isDMChannel = false,
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
	let mediaMenuContainer: HTMLElement | null = $state(null);
	let showCommandPalette = $state(false);
	let commandPaletteSelectedIndex = $state(0);
	let commandPalette: CommandPalette = $state();
	let showMentionSuggestions = $state(false);
	let mentionSuggestions: MentionSuggestion[] = $state([]);
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
	const COMPOSER_MAX_HEIGHT = 160;
	const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
	const MAX_GIF_CAPTION_LENGTH = 280;
	const MAX_FILE_PREVIEW_IMAGES = 8;

	let composerSettings = $derived($composerEnhancementSettingsStore);
	let composerSpellcheckEnabled = $derived(composerSettings.spellcheckEnabled);
	let composerCharCounterEnabled = $derived(composerSettings.charCounterEnabled);
	let splitLargeMessagesEnabled = $derived(composerSettings.splitLargeMessagesEnabled);
	let splitLargeMessagesChunkSize = $derived(composerSettings.splitLargeMessagesChunkSize);
	let writeUpperCaseEnabled = $derived(composerSettings.writeUpperCaseEnabled);
	let composerInputMaxLength = $derived(splitLargeMessagesEnabled ? composerSettings.splitLargeMessagesInputMaxLength : splitLargeMessagesChunkSize);
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
	function autoResizeTextarea() { if (!textareaElement) return; textareaElement.style.height = 'auto'; textareaElement.style.height = `${Math.min(textareaElement.scrollHeight, COMPOSER_MAX_HEIGHT)}px`; }
	function handleInput() { autoResizeTextarea(); const now = Date.now(); if (now - lastTypingEmit >= TYPING_THROTTLE_MS) { sendTyping(true, effectiveChannel); lastTypingEmit = now; } if (typingTimeout) clearTimeout(typingTimeout); typingTimeout = setTimeout(() => sendTyping(false, effectiveChannel), 1000) as unknown as number; }
	function handleInputChange() {
		syncComposerEntities();
		if (messageInput.startsWith('/')) { showCommandPalette = getMatchingCommands(messageInput).length > 0; showMentionSuggestions = false; }
		else { showCommandPalette = false; const caret = textareaElement?.selectionStart ?? messageInput.length; if (!$placeRegistry.length) void loadPlaceRegistry(); const result = computeMentionSuggestions(messageInput, caret, $users as User[], $currentUser?.id, $placeRegistry); if (result.show) { mentionTokenStart = result.tokenStart; mentionSuggestions = result.suggestions; mentionSelectedIndex = 0; showMentionSuggestions = true; } else showMentionSuggestions = false; updateEmojiSuggestions(caret); }
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
		if (isSending || isUploading || !operationCurrent()) return;
		const hasFiles = selectedFiles.length > 0;
		const hasText = Boolean(messageInput.trim());
		if (!hasFiles && !hasText) return;
		if (sendCooldownUntil > Date.now()) {
			sendCooldownMessage = 'Hold on buster. Give chat a second before sending more.';
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
			sendCooldownMessage = 'Hold on buster. Give chat a second before sending more.';
			if (sendCooldownTimer) clearTimeout(sendCooldownTimer);
			sendCooldownTimer = setTimeout(() => {
				sendCooldownUntil = 0;
				sendCooldownMessage = '';
				sendCooldownTimer = null;
			}, SEND_BURST_COOLDOWN_MS);
			return;
		}

		if (processed.text.startsWith('/')) {
			void onExecuteCommand(processed.text);
			messageInput = '';
			resetComposerEntityState();
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
	function supportsMediaCapture(): boolean { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
	function handleGlobalClick(event: MouseEvent) { const target = event.target as Node | null; if (target && emojiPickerContainer?.contains(target)) return; if (target && mediaMenuContainer?.contains(target)) return; if (target && mentionMenuContainer?.contains(target)) return; showMediaMenu = false; showEmojiPicker = false; showMentionSuggestions = false; }
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
<EditReplyStatus {editingMessage} {replyingTo} onCancelEdit={cancelEdit} onCancelReply={cancelReply} />

<CameraCapture isOpen={showCameraCapture} on:close={() => (showCameraCapture = false)} on:capture={handlePhotoCapture} />
<AudioRecorder isOpen={showAudioRecorder} on:close={() => (showAudioRecorder = false)} on:send={handleAudioSend} />

<div class="input-wrapper" class:hidden={$isMobile && !composerVisible}>
	{#if showEmojiPicker}
		<!-- 2026-08-27: this container used to render at composer-root level with
			 NO positioning CSS — an inline block that pushed the whole message list
			 up when opened. Now anchored inside .input-wrapper (position:relative)
			 as an overlay popover, matching MentionSuggestions. -->
		<div class="emoji-picker-container" bind:this={emojiPickerContainer}>
			{#if EmojiPickerComponent}
				<EmojiPickerComponent on:select={handleEmojiSelect} on:gif={handleGifSelect} on:close={() => (showEmojiPicker = false)} />
			{:else if emojiPickerLoadFailed}
				<div class="emoji-picker-loading error" role="alert">
					<span>Failed to load the emoji/GIF panel.</span>
					<button type="button" onclick={stopPropagation(ensureEmojiPickerLoaded)}>Retry</button>
				</div>
			{:else}
				<div class="emoji-picker-loading">{$_('emoji_picker.loading')}</div>
			{/if}
		</div>
	{/if}
	{#if showMentionSuggestions && mentionSuggestions.length > 0}<MentionSuggestions suggestions={mentionSuggestions} selectedIndex={mentionSelectedIndex} bind:container={mentionMenuContainer} onApply={applyMentionSuggestion} />{/if}
	{#if showEmojiSuggestions}<EmojiSuggestions suggestions={emojiSuggestions} selectedIndex={emojiSuggestionSelectedIndex} onApply={applyEmojiSuggestion} />{/if}
	{#if filePreviews.length > 0 && !isUploading}		<FileUploadPreview {filePreviews} bind:markAsSpoiler spoilerLocked={channelForceSpoiler} {albumEligibleSelection} {createAlbumFromUpload} bind:uploadAlbumName albums={uploadAlbums} bind:targetAlbumId={uploadTargetAlbumId} onAlbumTargetChange={(id) => (uploadTargetAlbumId = id)} buildDefaultUploadAlbumName={() => buildDefaultUploadAlbumName($channels.find(ch => ch.id === effectiveChannel)?.name || effectiveChannel, messageInput)} onAlbumUploadToggle={handleAlbumUploadToggle} onCancelUpload={clearFilePreviews} onRemoveFile={removeFile} onUploadSelectedFiles={uploadSelectedFiles} />{/if}
	{#if isUploading}<div class="upload-progress-bar"><div class="upload-progress-info"><span>{uploadStatusLabel || $_('chat.upload.uploading')}</span><span>{uploadProgress}%</span></div><div class="progress-bar"><div class="progress-fill" style="width: {uploadProgress}%"></div></div></div>{/if}
	<input type="file" bind:this={fileInput} onchange={handleFileSelect} multiple class="hidden" />
	{#if sendCooldownMessage}<div class="composer-rate-limit-notice" role="status" aria-live="polite">{sendCooldownMessage}</div>{/if}
	<div class="input-container">
		<CommandPalette bind:this={commandPalette} bind:input={messageInput} bind:isVisible={showCommandPalette} bind:selectedIndex={commandPaletteSelectedIndex} onSelect={handleCommandSelect} />
		<textarea bind:this={textareaElement} bind:value={messageInput} onpaste={handlePaste} oninput={() => { handleInput(); handleInputChange(); }} onkeydown={handleKeyDown} onfocus={() => { isTextareaFocused = true; composerVisible = true; }} onblur={() => { isTextareaFocused = false; }} placeholder={$isMobile ? 'Message...' : $_('chat.compose.placeholder')} maxlength={composerInputMaxLength} spellcheck={composerSpellcheckEnabled} rows="1"></textarea>
		{#if composerCharCounterEnabled && composerCharCounterVisible}<span class="composer-char-counter" class:warn={composerCharCounterWarn} class:visible={composerCharCounterVisible}>{composerCharCount}/{composerInputMaxLength}</span>{/if}
		<button bind:this={emojiPickerButton} class="input-icon-button" onclick={stopPropagation(() => { showEmojiPicker = !showEmojiPicker; if (showEmojiPicker) { ensureEmojiPickerLoaded(); showMediaMenu = false; } })} title={$_('chat.compose.add_emoji')} aria-label={$_('chat.compose.add_emoji')}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg></button>
		<div class="input-buttons-right">
			{#if paymentButtonEnabled}
				<button class="input-icon-button" onclick={() => onOpenPaymentSheet()} title="Create payment request" aria-label="Create payment request"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"></rect><path d="M2.5 10h19"></path><path d="M7.5 15h4"></path></svg></button>
			{/if}
			<div class="media-menu-container" bind:this={mediaMenuContainer}>
				<button class="input-icon-button add-button" onclick={stopPropagation(() => { showMediaMenu = !showMediaMenu; if (showMediaMenu) showEmojiPicker = false; })} title={$_('chat.compose.add_media')} aria-label={$_('chat.compose.add_media')}><span aria-hidden="true">+</span></button>
				{#if showMediaMenu}<div class="media-menu"><button class="media-menu-item" onclick={() => { showMediaMenu = false; fileInput?.click(); }}>{$_('chat.compose.upload_file')}</button>{#if supportsMediaCapture()}<button class="media-menu-item" onclick={() => { showMediaMenu = false; showCameraCapture = true; }}>{$_('chat.compose.take_photo')}</button><button class="media-menu-item" onclick={() => { showMediaMenu = false; showAudioRecorder = true; }}>{$_('chat.compose.record_audio')}</button>{/if}</div>{/if}
			</div>
		</div>
		<button class="send-button" onclick={handleSubmit} disabled={(selectedFiles.length === 0 && !messageInput.trim()) || sendCooldownUntil > Date.now() || isUploading || isSending} title={selectedFiles.length > 0 ? 'Send selected media' : $_('chat.compose.send_message')} aria-label={selectedFiles.length > 0 ? 'Send selected media' : $_('chat.compose.send_message')}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button>
	</div>
	{#if unicodeEmojisEnabled && unicodeComposerPreviewTokens > 0 && unicodeComposerPreview !== messageInput}<div class="unicode-conversion-hint">Unicode preview: {unicodeComposerPreview}</div>{/if}
	{#if gifCaptionerEnabled && gifCaptionerDedicatedCaptionFieldEnabled}<div class="gif-caption-draft-row"><input type="text" class="gif-caption-draft-input input input-sm" bind:value={gifCaptionInput} maxlength={MAX_GIF_CAPTION_LENGTH} placeholder="GIF caption (used when sending from GIF picker)" /><span class="gif-caption-draft-count" class:warn={gifCaptionDraftWarn}>{gifCaptionDraftLength}/{MAX_GIF_CAPTION_LENGTH}</span></div>{#if unicodeEmojisEnabled && unicodeGifCaptionPreviewTokens > 0 && unicodeGifCaptionPreview !== gifCaptionInput}<div class="unicode-conversion-hint">GIF caption preview: {unicodeGifCaptionPreview}</div>{/if}{/if}
</div>
