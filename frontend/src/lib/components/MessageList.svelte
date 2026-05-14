<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';
	import { get } from 'svelte/store';
	import { browser } from '$app/environment';
	import type { Message, User, Emoji, Channel, FileAttachment } from '$lib/socket';
	import { users, currentUser, currentChannel, editMessage, deleteMessage, togglePinMessage, addReaction, removeReaction, emojis, channels, loadOlderMessages, channelAvailableArchives, channelLoadedArchives, channelLoadingOlder, loadOlderHistory, channelHistoryLoading, channelHasMoreHistory, roleDefinitions, retryMessagePersistence } from '$lib/socket';
	import { themeStore } from '$lib/theme/themeStore';
	import MessageContextMenu from './MessageContextMenu.svelte';
	import ForwardDialog from './ForwardDialog.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import ZipPreviewPanel from './ZipPreviewPanel.svelte';
	import ModelViewer3D from './plugins/ModelViewer3D.svelte';
	import YouTubeWatchEmbed from './plugins/YouTubeWatchEmbed.svelte';
	import SpotifyControlsEmbed from './plugins/SpotifyControlsEmbed.svelte';
	import type { BlendImportSettingsPayload } from './plugins/BlendImportSettingsModal.svelte';
	import { parseMessage } from '$lib/markdown';
	import {
		getStoredAccessibilitySettings,
		resolveUserDisplayColor,
		type DeletionCountdownMode
	} from '$lib/accessibility';
	import '$lib/prism-theme.css';
	import { longpress } from '$lib/actions/longpress';
	import { getServerUrl } from '$lib/serverUrl';
	import { getRelayFileUrl, relayEnabled } from '$lib/relaySelector';
	import { decryptDMFileBuffer, isE2EAvailable } from '$lib/e2eManager';
	import { MODEL_VIEWPORT_ADDON_ID, openModelViewport } from '$lib/modelViewportTab';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { layoutStore } from '$lib/layoutStore';
	import { _ } from '$lib/i18n';
	import { addMediaAlbumItem, createMediaAlbum, listMediaAlbums, type MediaAlbumScopeType } from '$lib/api';
	import { messageRetentionToMs } from '../../../../shared/messageRetention.js';
	import {
		applyChatFilter,
		chatFilterStore,
		customQuoteSettingsStore,
		formatCustomQuote,
		type ChatFilterResult
	} from '$lib/chatEnhancements';
	import { gifCaptionerSettingsStore } from '$lib/gifCaptionerSettings';
	import { quickReactionSettingsStore } from '$lib/quickReactions';
	import { recordQuickReactionTelemetry } from '$lib/quickReactionTelemetry';
	import { buildReverseImageSearchUrl, getReverseImageSearchProvider } from '$lib/imageUtilities';
	import { localNicknamesStore, getUserIdentityKey } from '$lib/localNicknames';
	import { isSpotifyUrl } from '$lib/spotifyControls';
	import { animationPassStore, type AnimationPassPreset } from '$lib/animationPass';
	import { getAuthToken as getSessionAuthToken } from '$lib/authSession';
	import {
		displayEnhancementSettingsStore,
		formatTimestampForDisplay,
		type RevealAllSpoilersMinRole
	} from '$lib/displayEnhancements';
	import {
		getPersonalPinsForChannel,
		personalPinsStore,
		togglePersonalPin
	} from '$lib/personalPins';
	import {
		loadPlaceRegistry
	} from '$lib/placeRegistry';
	import { openFullMapTab, openMapPanel, openPreferredMapSurface } from '$lib/mapWorkspace';
	export let messages: Message[];
	export let onReply: (message: Message) => void = () => {};
	export let onQuickMention: (message: Message) => void = () => {};
	export let firstUnreadMessageId: string | null = null;
	const dispatch = createEventDispatcher();
	const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
	const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
	const easeOutBack = (t: number) => {
		const c1 = 1.70158;
		const c3 = c1 + 1;
		return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
	};
	const MESSAGE_RENDER_BATCH = 120;
	const MESSAGE_RENDER_MAX = 360;
	const MESSAGE_ANIMATION_BURST_WINDOW_MS = 600;
	const MESSAGE_ANIMATION_BURST_THRESHOLD = 3;
	const MESSAGE_ANIMATION_BURST_COOLDOWN_MS = 900;
	const REVEAL_ROLE_PRIORITY: Record<RevealAllSpoilersMinRole, number> = {
		guest: 0,
		member: 1,
		mod: 2,
		admin: 3,
		owner: 4
	};
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};
	let messageRenderLimit = MESSAGE_RENDER_BATCH;
	let lastChannelForRenderWindow: string | null = null;
	let lastObservedMessageCount = 0;
	let lastObservedLastMessageId: string | null = null;
	let burstArrivalTimestamps: number[] = [];
	let burstAnimationSuppressed = false;
	let burstAnimationResetHandle: number | null = null;
	let userBySocketId = new Map<string, User>();
	let userByDbId = new Map<number, User>();
	let userByUsername = new Map<string, User>();
	let userByMentionValue = new Map<string, User>();
	let messageById = new Map<string, Message>();
	let ownIdentityIds = new Set<string>();
	let incomingFilterCache = new Map<string, ChatFilterResult>();
	// User popout state
	let showUserPopout = false;
	let popoutUser: User | null = null;
	let popoutAnchorElement: HTMLElement | null = null;
	let popoutIsOwnProfile = false;
	// Context menu state
	let contextMenuVisible = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuMessage: Message | null = null;
	type AlbumAnnouncementMeta = { name: string; kind: 'opened' | 'shared' };
	let albumAnnouncementUploadInput: HTMLInputElement | null = null;
	let pendingAlbumUploadMeta: AlbumAnnouncementMeta | null = null;
	let albumAnnouncementUploadName: string | null = null;
	let recentAlbumAnnouncementUploadCounts = new Map<string, number>();
	type MessageAttachmentActionItem = Pick<
		FileAttachment,
		'fileUrl' | 'fileName' | 'fileSize' | 'attachmentEncryption'
	>;
	type TranslatorSettings = {
		model: string;
		providerUrl: string;
		sourceLang: string;
		targetLang: string;
		useProxy: boolean;
	};
	const TRANSLATOR_SETTINGS_KEY = 'addon.translator_assist.settings';
	let translatedMessages: Record<string, string> = {};
	let translatingMessageIds = new Set<string>();
	// Edit mode state
	let editingMessageId: string | null = null;
	let editText = '';
	// Delete confirmation state
	let showDeleteConfirm = false;
	let messageToDelete: Message | null = null;
	let showBlendImportSettings = false;
	let blendImportSourcePath = '';
	let blendImportFileName = '';
	let blendImportSubmitting = false;
	let EmojiPickerComponent: typeof import('./EmojiPicker.svelte').default | null = null;
	let UserPopoutComponent: typeof import('./UserPopout.svelte').default | null = null;
	let LinkPreviewComponent: typeof import('./LinkPreview.svelte').default | null = null;
	let BlendImportSettingsModalComponent: typeof import('./plugins/BlendImportSettingsModal.svelte').default | null = null;
	let emojiPickerLoadPromise: Promise<void> | null = null;
	let userPopoutLoadPromise: Promise<void> | null = null;
	let linkPreviewLoadPromise: Promise<void> | null = null;
	let blendImportModalLoadPromise: Promise<void> | null = null;
	$: messageAnimation = (() => {
		const baseDuration = $animationPassStore.level === 'full' ? 260 : 190;
		const baseDistance = $animationPassStore.level === 'full' ? 20 : 14;
		return {
			enabled: $animationPassStore.enabled,
			preset: $animationPassStore.preset,
			duration: Math.max(0, Math.round(baseDuration * $animationPassStore.durationMultiplier)),
			distance: Math.max(0, Math.round(baseDistance * $animationPassStore.durationMultiplier))
		};
	})();
	$: gifCaptionStyleClass = (() => {
		const style = $gifCaptionerSettingsStore.captionStyle;
		if (style === 'accent') return 'style-accent';
		if (style === 'card') return 'style-card';
		return 'style-plain';
	})();

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
			return scale(node, { duration, start: 0.985, opacity: 0.2, easing: easeOutBack });
		}
		if (preset === 'flip') {
			return scale(node, { duration, start: 0.93, opacity: 0.12, easing: easeOutQuint });
		}
		return fly(node, { duration, y: distance, opacity: 0.15, easing: easeOutQuint });
	}

	function messageItemTransition(
		node: Element,
		params: {
			enabled: boolean;
			preset: AnimationPassPreset;
			duration: number;
			distance: number;
			animate: boolean;
		}
	) {
		const reducedMotion = typeof document !== 'undefined' && document.documentElement.getAttribute('data-reduce-motion') === 'true';
		if (reducedMotion) {
			return fade(node, { duration: 0 });
		}
		if (!params.enabled || !params.animate || params.duration <= 0) {
			return fade(node, { duration: 0 });
		}
		return getTransitionForPreset(node, params.preset, params.duration, params.distance);
	}

	function clearBurstAnimationReset(): void {
		if (burstAnimationResetHandle !== null) {
			window.clearTimeout(burstAnimationResetHandle);
			burstAnimationResetHandle = null;
		}
	}

	function scheduleBurstAnimationReset(): void {
		clearBurstAnimationReset();
		burstAnimationResetHandle = window.setTimeout(() => {
			burstAnimationSuppressed = false;
			burstAnimationResetHandle = null;
		}, MESSAGE_ANIMATION_BURST_COOLDOWN_MS);
	}

	function recordMessageBurst(additions: number): void {
		if (typeof window === 'undefined' || additions <= 0) return;
		const now = Date.now();
		for (let index = 0; index < additions; index += 1) {
			burstArrivalTimestamps.push(now);
		}
		burstArrivalTimestamps = burstArrivalTimestamps.filter(
			(timestamp) => now - timestamp <= MESSAGE_ANIMATION_BURST_WINDOW_MS
		);
		if (burstArrivalTimestamps.length >= MESSAGE_ANIMATION_BURST_THRESHOLD) {
			burstAnimationSuppressed = true;
			scheduleBurstAnimationReset();
		}
	}

	function ensureEmojiPickerLoaded(): void {
		if (EmojiPickerComponent || emojiPickerLoadPromise) return;
		emojiPickerLoadPromise = import('./EmojiPicker.svelte')
			.then((mod) => {
				EmojiPickerComponent = mod.default;
			})
			.catch((error) => console.error('Failed to load EmojiPicker:', error))
			.finally(() => {
				emojiPickerLoadPromise = null;
			});
	}

	function ensureUserPopoutLoaded(): void {
		if (UserPopoutComponent || userPopoutLoadPromise) return;
		userPopoutLoadPromise = import('./UserPopout.svelte')
			.then((mod) => {
				UserPopoutComponent = mod.default;
			})
			.catch((error) => console.error('Failed to load UserPopout:', error))
			.finally(() => {
				userPopoutLoadPromise = null;
			});
	}

	function ensureLinkPreviewLoaded(): void {
		if (LinkPreviewComponent || linkPreviewLoadPromise) return;
		linkPreviewLoadPromise = import('./LinkPreview.svelte')
			.then((mod) => {
				LinkPreviewComponent = mod.default;
			})
			.catch((error) => console.error('Failed to load LinkPreview:', error))
			.finally(() => {
				linkPreviewLoadPromise = null;
			});
	}

	function ensureBlendImportSettingsModalLoaded(): void {
		if (BlendImportSettingsModalComponent || blendImportModalLoadPromise) return;
		blendImportModalLoadPromise = import('./plugins/BlendImportSettingsModal.svelte')
			.then((mod) => {
				BlendImportSettingsModalComponent = mod.default;
			})
			.catch((error) => console.error('Failed to load BlendImportSettingsModal:', error))
			.finally(() => {
				blendImportModalLoadPromise = null;
			});
	}
	// Emoji picker for reactions
	// TODO: Add emoji reactions feature
	// - Right-click message → "Add Reaction" → Opens emoji picker
	// - Click emoji → Adds reaction to message
	// - Display reactions below messages with counts
	// - Click reaction to toggle your reaction on/off
	let showReactionPicker = false;
	let reactionPickerX = 0;
	let reactionPickerY = 0;
	let reactionPickerMessageId: string | null = null;
	let reactionPickerChannelId: string | null = null;
	const MODEL_VIEWPORT_TAB_TOKEN = mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_ADDON_ID);

	function closeReactionPicker() {
		showReactionPicker = false;
		reactionPickerMessageId = null;
		reactionPickerChannelId = null;
	}

	function openModelInDedicatedTab(src: string, fileName: string): void {
		openModelViewport(src, fileName);
		mobileTabQueue.setActiveTab(MODEL_VIEWPORT_TAB_TOKEN);
	}
	function formatTime(timestamp: number): string {
		return formatTimestampForDisplay(
			timestamp,
			$displayEnhancementSettingsStore.timestampDisplayMode
		);
	}
	$: personalPinnedMessageIdSet = new Set(
		getPersonalPinsForChannel($currentChannel, $personalPinsStore)
	);

	function formatTimeTooltip(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}
	const DELETION_COUNTDOWN_VISIBILITY_WINDOW_MS = 60 * 60 * 1000;
	let nowMs = Date.now();
	let deletionCountdownMode: DeletionCountdownMode = 'static';

	function formatDurationCompact(durationMs: number): string {
		const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
		if (totalSeconds < 60) return `${totalSeconds}s`;
		const totalMinutes = Math.floor(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;
		const totalHours = Math.floor(totalMinutes / 60);
		if (totalHours < 24) {
			const minutes = totalMinutes % 60;
			return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
		}
		const days = Math.floor(totalHours / 24);
		const hours = totalHours % 24;
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}

	function getChannelDeleteDurationMs(channelId: string): number | null {
		const channel = $channels.find((ch) => ch.id === channelId);
		return messageRetentionToMs(channel?.autoDeleteAfter || null);
	}

	function getMessageDeletionDeadline(message: Message): number | null {
		if (typeof message.scheduledDeletionTime === 'number') {
			return message.scheduledDeletionTime;
		}
		const channelDurationMs = getChannelDeleteDurationMs($currentChannel);
		if (!channelDurationMs) return null;
		return message.timestamp + channelDurationMs;
	}

	function getMessageDeletionLabel(message: Message): string | null {
		if (deletionCountdownMode === 'off') return null;
		const deadline = getMessageDeletionDeadline(message);
		if (!deadline) return null;
		const remaining = deadline - nowMs;
		if (remaining > DELETION_COUNTDOWN_VISIBILITY_WINDOW_MS) return null;
		if (remaining <= 0) return get(_)('messages.deletion.deleting');
		return get(_)('messages.deletion.deletes_in', { values: { duration: formatDurationCompact(remaining) } });
	}

	function readDeletionCountdownModeFromDom(): DeletionCountdownMode {
		if (typeof document === 'undefined') return 'static';
		const attrValue = document.documentElement.getAttribute('data-deletion-countdown-mode');
		if (attrValue === 'off' || attrValue === 'live' || attrValue === 'static') return attrValue;
		return getStoredAccessibilitySettings().deletionCountdownMode;
	}

	$: {
		const nextBySocketId = new Map<string, User>();
		const nextByDbId = new Map<number, User>();
		const nextByUsername = new Map<string, User>();
		const nextByMentionValue = new Map<string, User>();
		for (const user of $users) {
			if (user.id) nextBySocketId.set(user.id, user);
			if (typeof user.dbUserId === 'number') nextByDbId.set(user.dbUserId, user);
			const usernameKey = user.username.trim().toLowerCase();
			if (usernameKey) {
				nextByUsername.set(usernameKey, user);
				nextByMentionValue.set(usernameKey, user);
			}
			const handleKey = user.handle?.trim().toLowerCase();
			if (handleKey) {
				nextByMentionValue.set(handleKey, user);
			}
		}
		userBySocketId = nextBySocketId;
		userByDbId = nextByDbId;
		userByUsername = nextByUsername;
		userByMentionValue = nextByMentionValue;
	}

	$: {
		const nextMessageById = new Map<string, Message>();
		for (const message of messages) {
			nextMessageById.set(message.id, message);
		}
		messageById = nextMessageById;
	}

	$: {
		const nextOwnIdentityIds = new Set<string>();
		if ($currentUser?.id) nextOwnIdentityIds.add($currentUser.id);
		if ($currentUser?.dbUserId) nextOwnIdentityIds.add(`user-${$currentUser.dbUserId}`);
		ownIdentityIds = nextOwnIdentityIds;
	}

	$: {
		$chatFilterStore;
		incomingFilterCache = new Map();
	}

	function getUserByUsername(username: string): User | undefined {
		const normalized = username.trim().toLowerCase();
		return userByUsername.get(normalized);
	}

	function getUserByIdentityId(userId: string | undefined): User | undefined {
		if (!userId) return undefined;
		if (userId.startsWith('user-')) {
			const dbUserId = Number(userId.substring(5));
			if (!Number.isNaN(dbUserId)) {
				const byDbId = userByDbId.get(dbUserId);
				if (byDbId) return byDbId;
			}
		}
		return userBySocketId.get(userId);
	}

	function getUserByMessageAuthor(message: Message): User | undefined {
		return getUserByIdentityId(message.userId) || getUserByUsername(message.user || '');
	}

	function resolveLocalNicknameForMessage(message: Message, author?: User): string {
		if (!$displayEnhancementSettingsStore.localNicknamesEnabled) return '';
		const resolvedUser = author || getUserByMessageAuthor(message);
		if (resolvedUser) {
			const key = getUserIdentityKey(resolvedUser);
			return key ? $localNicknamesStore[key] || '' : '';
		}
		const fallbackKey = (message.userId || '').trim();
		return fallbackKey ? $localNicknamesStore[fallbackKey] || '' : '';
	}

	function getMessageDisplayUsername(message: Message, author?: User): string {
		const fallback = (message.user || '').trim();
		const resolved = author || getUserByMessageAuthor(message);
		const baseName = $displayEnhancementSettingsStore.removeNicknamesEnabled
			? resolved?.username || fallback || get(_)('messages.unknown_user')
			: fallback || resolved?.username || get(_)('messages.unknown_user');
		const localNickname = resolveLocalNicknameForMessage(message, resolved);
		return localNickname || baseName;
	}

	$: roleLabelMap = (() => {
		const labels: Record<string, string> = { ...fallbackRoleLabels };
		for (const role of $roleDefinitions) {
			labels[role.roleName] = role.displayName;
		}
		return labels;
	})();

	function getUserTopRoleName(user: User | undefined): string {
		if (!user) return 'guest';
		if (user.highestRole) return user.highestRole;
		return user.dbUserId ? 'member' : 'guest';
	}

	function getRoleBadgeTone(roleName: string): 'owner' | 'admin' | 'mod' | 'default' {
		if (roleName === 'owner') return 'owner';
		if (roleName === 'admin') return 'admin';
		if (roleName === 'mod') return 'mod';
		return 'default';
	}

	function getTopRoleBadgeLabel(user: User | undefined): string | null {
		if (!user || !$displayEnhancementSettingsStore.topRoleEverywhereEnabled) return null;
		const roleName = getUserTopRoleName(user);
		return roleLabelMap[roleName] || roleName;
	}

	function getTopRoleBadgeTone(user: User | undefined): 'owner' | 'admin' | 'mod' | 'default' {
		return getRoleBadgeTone(getUserTopRoleName(user));
	}

	function shouldShowStaffTag(user: User | undefined): boolean {
		if (!user || !$displayEnhancementSettingsStore.staffTagEnabled) return false;
		const roleName = getUserTopRoleName(user);
		return roleName === 'owner' || roleName === 'admin' || roleName === 'mod';
	}

	function getUserByMentionValue(mentionToken: string): User | undefined {
		const normalized = mentionToken.trim().replace(/^@/, '').toLowerCase();
		if (!normalized || normalized === 'everyone' || normalized === 'here' || normalized === 'all') {
			return undefined;
		}
		return userByMentionValue.get(normalized);
	}

	function isOwnPopoutTarget(user: User): boolean {
		if (!$currentUser) return false;
		if ($currentUser.id && user.id === $currentUser.id) return true;
		if ($currentUser.dbUserId && user.dbUserId && user.dbUserId === $currentUser.dbUserId) return true;
		return false;
	}

	function openUserPopoutForUser(user: User, anchor: HTMLElement): void {
		popoutUser = user;
		popoutAnchorElement = anchor;
		popoutIsOwnProfile = isOwnPopoutTarget(user);
		showUserPopout = true;
	}

	function handleUsernameClick(event: MouseEvent, message: Message, resolvedUser?: User): void {
		const target = event.currentTarget as HTMLElement | null;
		if (!target || !$displayEnhancementSettingsStore.clickableMentionsEnabled) return;
		const user = resolvedUser || getUserByMessageAuthor(message);
		if (!user) return;
		openUserPopoutForUser(user, target);
	}

	async function handleMarkdownContentClick(event: MouseEvent): Promise<void> {
		const target = event.target as HTMLElement | null;
		if (!target) return;
		const placeTokenEl = target.closest('.mention-token-place');
		if (placeTokenEl instanceof HTMLElement) {
			const placeId = placeTokenEl.dataset.placeId || '';
			if (!placeId) return;
			const layerId = placeTokenEl.dataset.placeLayerId || '';
			const poiId = placeTokenEl.dataset.placePoiId || '';
			event.preventDefault();
			event.stopPropagation();
			await openPreferredMapSurface(placeId, { layerId: layerId || null, poiId: poiId || null });
			return;
		}
		if (!$displayEnhancementSettingsStore.clickableMentionsEnabled) return;
		const mentionTokenEl = target.closest('.mention-token');
		if (!(mentionTokenEl instanceof HTMLElement)) return;
		const mentionText = mentionTokenEl.textContent || '';
		const user = getUserByMentionValue(mentionText);
		if (!user) return;
		event.preventDefault();
		event.stopPropagation();
		openUserPopoutForUser(user, mentionTokenEl);
	}

	function canUseRevealAllSpoilers(): boolean {
		if (!$displayEnhancementSettingsStore.revealAllSpoilersEnabled) return false;
		const minRole = $displayEnhancementSettingsStore.revealAllSpoilersMinRole;
		const minPriority = REVEAL_ROLE_PRIORITY[minRole] ?? REVEAL_ROLE_PRIORITY.member;
		const currentRole = ($currentUser?.highestRole as RevealAllSpoilersMinRole) ||
			($currentUser?.dbUserId ? 'member' : 'guest');
		const currentPriority = REVEAL_ROLE_PRIORITY[currentRole] ?? REVEAL_ROLE_PRIORITY.guest;
		return currentPriority >= minPriority;
	}
	function getUserColor(user: User | undefined, username: string): string {
		const resolved = user || getUserByUsername(username);
		return resolveUserDisplayColor(resolved?.roleColor, resolved?.color);
	}

	function getUsernameStyle(user: User | undefined, username: string, themeState: any): string {
		let style = '';
		const resolvedUser = user || getUserByUsername(username);

		// Check if uniform font mode is enabled
		if (themeState.uniformFontEnabled) {
			// Use uniform font settings
			if (themeState.uniformFontFamily && themeState.uniformFontFamily !== 'inherit') {
				style += `font-family: ${themeState.uniformFontFamily};`;
			}
			if (themeState.uniformFontSize && themeState.uniformFontSize !== 'inherit') {
				style += `font-size: ${themeState.uniformFontSize};`;
			}
			if (themeState.uniformFontWeight) {
				style += `font-weight: ${themeState.uniformFontWeight};`;
			}
			if (themeState.uniformFontStyle) {
				style += `font-style: ${themeState.uniformFontStyle};`;
			}
		} else {
			// Use the user's custom font
			if (resolvedUser?.usernameFont) {
				if (resolvedUser.usernameFont.family && resolvedUser.usernameFont.family !== 'inherit') {
					style += `font-family: ${resolvedUser.usernameFont.family};`;
				}
				if (resolvedUser.usernameFont.size && resolvedUser.usernameFont.size !== 'inherit') {
					style += `font-size: ${resolvedUser.usernameFont.size};`;
				}
				if (resolvedUser.usernameFont.weight) {
					style += `font-weight: ${resolvedUser.usernameFont.weight};`;
				}
				if (resolvedUser.usernameFont.style) {
					style += `font-style: ${resolvedUser.usernameFont.style};`;
				}
			}
		}

		return style;
	}

	function handleContextMenu(event: MouseEvent, message: Message) {
		event.preventDefault();
		contextMenuMessage = message;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		contextMenuVisible = true;
	}
	function handleEdit() {
		if (!contextMenuMessage) return;
		editingMessageId = contextMenuMessage.id;
		editText = contextMenuMessage.text;
		contextMenuVisible = false;
	}
	function saveEdit(messageId: string) {
		if (editText.trim()) {
			editMessage($currentChannel, messageId, editText.trim());
		}
		editingMessageId = null;
		editText = '';
	}
	function cancelEdit() {
		editingMessageId = null;
		editText = '';
	}
	function handleDelete() {
		if (!contextMenuMessage) return;
		messageToDelete = contextMenuMessage;
		showDeleteConfirm = true;
		contextMenuVisible = false;
	}
	function confirmDeleteMessage() {
		if (messageToDelete) {
			deleteMessage($currentChannel, messageToDelete.id);
		}
		showDeleteConfirm = false;
	}
	function handlePin() {
		if (!contextMenuMessage) return;
		togglePinMessage($currentChannel, contextMenuMessage.id);
		contextMenuVisible = false;
	}
	function handleReply(message?: Message) {
		const targetMessage = message || contextMenuMessage;
		if (!targetMessage) return;
		onReply(targetMessage);
		contextMenuVisible = false;
	}

	function isPersonalPinnedMessage(messageId: string): boolean {
		return personalPinnedMessageIdSet.has(messageId);
	}

	function handleQuickMention(message?: Message): void {
		const targetMessage = message || contextMenuMessage;
		if (!targetMessage || !$displayEnhancementSettingsStore.quickMentionEnabled) return;
		onQuickMention(targetMessage);
		contextMenuVisible = false;
	}

	function handleTogglePersonalPin(message?: Message): void {
		const targetMessage = message || contextMenuMessage;
		if (!targetMessage || !$displayEnhancementSettingsStore.personalPinsEnabled) return;
		togglePersonalPin($currentChannel, targetMessage.id);
		contextMenuVisible = false;
	}

	function handleUtilityPinToggle(message: Message): void {
		if (!$displayEnhancementSettingsStore.messageUtilitiesEnabled) return;
		togglePinMessage($currentChannel, message.id);
	}

	function handleUtilityEdit(message: Message): void {
		if (!$displayEnhancementSettingsStore.messageUtilitiesEnabled) return;
		if (!isOwnMessage(message)) return;
		editingMessageId = message.id;
		editText = message.text;
	}

	function getAuthToken(): string | null {
		return getSessionAuthToken();
	}

	function getMessageAttachmentActionItems(message: Message): MessageAttachmentActionItem[] {
		const multi = (message.files || [])
			.filter((entry) => Boolean(entry?.fileUrl && entry?.fileName))
			.map((entry) => ({
				fileUrl: entry.fileUrl,
				fileName: entry.fileName,
				fileSize: typeof entry.fileSize === 'number' ? entry.fileSize : 0,
				attachmentEncryption: entry.attachmentEncryption
			}));
		if (multi.length > 0) {
			return multi;
		}
		if (!message.fileUrl || !message.fileName) {
			return [];
		}
		return [
			{
				fileUrl: message.fileUrl,
				fileName: message.fileName,
				fileSize: typeof message.fileSize === 'number' ? message.fileSize : 0,
				attachmentEncryption: message.attachmentEncryption
			}
		];
	}

	function countMessageAttachments(message: Message | null): number {
		if (!message) return 0;
		if (Array.isArray(message.files) && message.files.length > 0) {
			return message.files.filter((entry) => Boolean(entry?.fileUrl)).length;
		}
		return message.fileUrl ? 1 : 0;
	}

	function getDeleteConfirmMessage(message: Message | null): string {
		const attachmentCount = countMessageAttachments(message);
		if (attachmentCount > 0) {
			return get(_)('messages.confirm.delete_message_with_uploads', { values: { count: attachmentCount } });
		}
		return get(_)('messages.confirm.delete_message');
	}

	function selectAttachmentActionItems(items: MessageAttachmentActionItem[]): MessageAttachmentActionItem[] | null {
		if (items.length <= 1) return items;
		const choices = items
			.map((item, index) => `${index + 1}. ${item.fileName}`)
			.slice(0, 20)
			.join('\n');
		const raw = prompt(
			`Select file to use:\n${choices}${items.length > 20 ? '\n...more files not listed' : ''}\n\nEnter a number (1-${items.length}) or "all".`,
			'all'
		);
		if (raw === null) return null;
		const value = raw.trim().toLowerCase();
		if (!value || value === 'all' || value === '*') return items;
		const index = Number.parseInt(value, 10);
		if (!Number.isInteger(index) || index < 1 || index > items.length) {
			alert(`Invalid selection. Enter a number between 1 and ${items.length}, or "all".`);
			return null;
		}
		return [items[index - 1]];
	}

	async function resolveTargetAlbum(
		token: string,
		scopeType: MediaAlbumScopeType,
		scopeId: string
	): Promise<{ id: number; name: string } | null> {
		const albums = await listMediaAlbums(token, scopeType, scopeId, 200);
		if (albums.length === 0) {
			const name = prompt('No albums found in this channel. Enter a new album name:', 'General');
			if (!name || !name.trim()) return null;
			const created = await createMediaAlbum(token, {
				scopeType,
				scopeId,
				name: name.trim()
			});
			return { id: created.id, name: created.name };
		}

		const options = albums
			.map((album, index) => `${index + 1}. ${album.name} (${album.itemCount} items)`)
			.slice(0, 25)
			.join('\n');
		const raw = prompt(
			`Choose an album:\n${options}${albums.length > 25 ? '\n...more albums not listed' : ''}\n\nEnter a number, or type "new" to create one.`,
			'1'
		);
		if (raw === null) return null;
		const value = raw.trim().toLowerCase();
		if (value === 'new' || value === 'n') {
			const name = prompt('Enter a new album name:', 'General');
			if (!name || !name.trim()) return null;
			const created = await createMediaAlbum(token, {
				scopeType,
				scopeId,
				name: name.trim()
			});
			return { id: created.id, name: created.name };
		}

		const index = Number.parseInt(value, 10);
		if (!Number.isInteger(index) || index < 1 || index > albums.length) {
			throw new Error(`Invalid album selection. Enter a number between 1 and ${albums.length}.`);
		}
		const selected = albums[index - 1];
		return { id: selected.id, name: selected.name };
	}

	function getAlbumScopeFromCurrentChannel(): { scopeType: MediaAlbumScopeType; scopeId: string } | null {
		const activeChannel = $channels.find((channel) => channel.id === $currentChannel);
		if (!activeChannel?.id) return null;
		const scopeType: MediaAlbumScopeType =
			activeChannel.type === 'dm' || activeChannel.type === 'group' ? 'dm' : 'channel';
		return {
			scopeType,
			scopeId: activeChannel.id
		};
	}

	async function handleDownload() {
		if (!contextMenuMessage) return;
		try {
			const attachmentItems = getMessageAttachmentActionItems(contextMenuMessage);
			const selectedItems = selectAttachmentActionItems(attachmentItems);
			if (!selectedItems || selectedItems.length === 0) return;
			for (const item of selectedItems) {
				await downloadAttachment(item.fileUrl, item.fileName, item.attachmentEncryption);
			}
		} catch (error) {
			console.error('Download failed:', error);
		}
		contextMenuVisible = false;
	}

	async function handleAddToAlbum(): Promise<void> {
		if (!contextMenuMessage) return;

		const token = getAuthToken();
		if (!token) {
			alert('Login is required to add files to albums.');
			contextMenuVisible = false;
			return;
		}

		const attachmentItems = getMessageAttachmentActionItems(contextMenuMessage);
		if (attachmentItems.length === 0) {
			contextMenuVisible = false;
			return;
		}
		const selectedItems = selectAttachmentActionItems(attachmentItems);
		if (!selectedItems || selectedItems.length === 0) {
			contextMenuVisible = false;
			return;
		}

		const scope = getAlbumScopeFromCurrentChannel();
		if (!scope) {
			alert('Cannot determine active album scope.');
			contextMenuVisible = false;
			return;
		}

		try {
			const targetAlbum = await resolveTargetAlbum(token, scope.scopeType, scope.scopeId);
			if (!targetAlbum) return;

			let addedCount = 0;
			for (const item of selectedItems) {
				await addMediaAlbumItem(token, targetAlbum.id, {
					attachmentUrl: item.fileUrl,
					attachmentName: item.fileName,
					attachmentSize: item.fileSize,
					messageId: contextMenuMessage.id
				});
				addedCount += 1;
			}

			if (addedCount > 0) {
				alert(`Added ${addedCount} file${addedCount === 1 ? '' : 's'} to "${targetAlbum.name}".`);
			}
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to add file(s) to album.');
		} finally {
			contextMenuVisible = false;
		}
	}

	function getQuoteSourceText(message: Message): string {
		if (message.text?.trim()) return message.text.trim();
		if (message.type === 'gif' && message.gifUrl) return `[GIF] ${message.gifUrl}`;
		if (message.type === 'emoji' && message.emojiName) return `:${message.emojiName}:`;
		if (message.files?.length) {
			if (message.files.length === 1) return `[file] ${message.files[0].fileName}`;
			return `[files] ${message.files.map((entry) => entry.fileName).join(', ')}`;
		}
		if (message.fileName) return `[file] ${message.fileName}`;
		return '[message]';
	}

	function getAlbumAnnouncementMeta(message: Message): { name: string; kind: 'opened' | 'shared' } | null {
		const text = (message.text || '').trim();
		if (!text) return null;
		const openedMatch = text.match(/^Opened album "(.+?)"/i);
		if (openedMatch?.[1]) {
			return { name: openedMatch[1], kind: 'opened' };
		}
		const sharedMatch = text.match(/^Shared \d+ photos in album "(.+?)"/i);
		if (sharedMatch?.[1]) {
			return { name: sharedMatch[1], kind: 'shared' };
		}
		return null;
	}

	function normalizeAlbumName(value: string): string {
		return value.trim().toLowerCase();
	}

	function getRecentAlbumAnnouncementUploadCount(name: string): number {
		return recentAlbumAnnouncementUploadCounts.get(normalizeAlbumName(name)) || 0;
	}

	function recordAlbumAnnouncementUpload(name: string, count: number): void {
		const key = normalizeAlbumName(name);
		const next = new Map(recentAlbumAnnouncementUploadCounts);
		next.set(key, (next.get(key) || 0) + count);
		recentAlbumAnnouncementUploadCounts = next;
	}

	function getAlbumAnnouncementPreviewFiles(message: Message): FileAttachment[] {
		if (!Array.isArray(message.files)) return [];
		return message.files
			.filter((fileAttachment) => {
				if (!fileAttachment?.fileUrl || !fileAttachment?.fileName) return false;
				if (isEncryptedAttachment(fileAttachment)) return false;
				return isImage(fileAttachment.fileName) || isVideo(fileAttachment.fileName);
			})
			.slice(0, 4);
	}

	function openAlbumPanel(): void {
		layoutStore.showMediaTab();
	}

	function getAlbumAnnouncementStatusLabel(meta: AlbumAnnouncementMeta, itemCount = 0): string {
		if (albumAnnouncementUploadName === meta.name) return 'Uploading';
		const recentCount = getRecentAlbumAnnouncementUploadCount(meta.name);
		if (recentCount > 0) return `Added ${recentCount}`;
		if (itemCount > 0) return `${itemCount} items`;
		return 'Click to upload';
	}

	function getAlbumAnnouncementSupportText(meta: AlbumAnnouncementMeta, itemCount = 0): string {
		if (albumAnnouncementUploadName === meta.name) {
			return 'Uploading files into this shared album now.';
		}
		const recentCount = getRecentAlbumAnnouncementUploadCount(meta.name);
		if (itemCount > 0) {
			return recentCount > 0
				? 'Open Albums to browse the latest additions or add more files.'
				: 'Open Albums to browse this shared album or add more files.';
		}
		if (recentCount > 0) {
			return 'Upload finished. Open Albums to browse what was added or click again to add more.';
		}
		return 'Click anywhere on this row to add the first image, or open Albums to manage it.';
	}

	function handleAlbumAnnouncementActivate(meta: AlbumAnnouncementMeta, hasFiles: boolean): void {
		if (!hasFiles && albumAnnouncementUploadName === meta.name) return;
		if (hasFiles) {
			openAlbumPanel();
			return;
		}
		triggerAlbumAnnouncementUpload(meta);
	}

	function handleAlbumAnnouncementKeydown(event: KeyboardEvent, meta: AlbumAnnouncementMeta, hasFiles: boolean): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		handleAlbumAnnouncementActivate(meta, hasFiles);
	}

	function triggerAlbumAnnouncementUpload(meta: AlbumAnnouncementMeta): void {
		if (albumAnnouncementUploadName) return;
		pendingAlbumUploadMeta = meta;
		albumAnnouncementUploadInput?.click();
	}

	async function uploadAlbumAnnouncementFile(
		token: string,
		file: File
	): Promise<{ fileUrl: string; fileName: string; fileSize: number; mimeType: string | null }> {
		const formData = new FormData();
		formData.append('file', file, file.name);

		const response = await fetch(`${getServerUrl()}/api/upload`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`
			},
			body: formData
		});

		if (!response.ok) {
			let detail = '';
			try {
				const payload = await response.json();
				detail = payload?.error || '';
			} catch {
				detail = await response.text();
			}
			throw new Error(detail || `Upload failed (${response.status})`);
		}

		const payload = await response.json();
		const fileUrl = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
		if (!fileUrl) {
			throw new Error('Upload did not return a file URL.');
		}

		return {
			fileUrl,
			fileName: typeof payload?.fileName === 'string' ? payload.fileName : file.name,
			fileSize:
				typeof payload?.fileSize === 'number' && Number.isFinite(payload.fileSize)
					? payload.fileSize
					: file.size,
			mimeType: file.type || null
		};
	}

	async function uploadFilesToAlbumAnnouncement(meta: AlbumAnnouncementMeta, fileList: FileList | File[]): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			alert('Login is required to upload into shared albums.');
			return;
		}

		const scope = getAlbumScopeFromCurrentChannel();
		if (!scope) {
			alert('Cannot determine the active album scope.');
			return;
		}

		const files = Array.from(fileList).filter((file) => file.size > 0);
		if (files.length === 0) return;

		albumAnnouncementUploadName = meta.name;
		try {
			const albums = await listMediaAlbums(token, scope.scopeType, scope.scopeId, 200);
			let targetAlbum =
				albums.find((album) => normalizeAlbumName(album.name) === normalizeAlbumName(meta.name)) || null;
			if (!targetAlbum) {
				const shouldCreate = confirm(`"${meta.name}" no longer exists here. Recreate it and upload into it?`);
				if (!shouldCreate) return;
				targetAlbum = await createMediaAlbum(token, {
					scopeType: scope.scopeType,
					scopeId: scope.scopeId,
					name: meta.name
				});
			}

			let addedCount = 0;
			for (const file of files) {
				const uploaded = await uploadAlbumAnnouncementFile(token, file);
				await addMediaAlbumItem(token, targetAlbum.id, {
					attachmentUrl: uploaded.fileUrl,
					attachmentName: uploaded.fileName,
					attachmentSize: uploaded.fileSize,
					attachmentMime: uploaded.mimeType
				});
				addedCount += 1;
			}

			if (addedCount > 0) {
				recordAlbumAnnouncementUpload(meta.name, addedCount);
				alert(`Added ${addedCount} file${addedCount === 1 ? '' : 's'} to "${targetAlbum.name}".`);
			}
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to upload into the album.');
		} finally {
			albumAnnouncementUploadName = null;
		}
	}

	function handleAlbumAnnouncementUploadChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement | null;
		if (!input?.files?.length || !pendingAlbumUploadMeta) {
			if (input) input.value = '';
			pendingAlbumUploadMeta = null;
			return;
		}
		const targetMeta = pendingAlbumUploadMeta;
		pendingAlbumUploadMeta = null;
		const files = input.files;
		input.value = '';
		void uploadFilesToAlbumAnnouncement(targetMeta, files);
	}

	function openAlbumAnnouncementPreview(message: Message, fileAttachment: FileAttachment): void {
		const resolvedUrl = getFileUrl(fileAttachment.fileUrl);
		if (isVideo(fileAttachment.fileName)) {
			enlargeVideo(resolvedUrl);
			return;
		}
		const imageGallery = getAlbumAnnouncementPreviewFiles(message)
			.filter((entry) => isImage(entry.fileName))
			.map((entry) => getFileUrl(entry.fileUrl));
		enlargeImage(resolvedUrl, imageGallery.length > 0 ? imageGallery : [resolvedUrl]);
	}

	async function handleCopyQuote(): Promise<void> {
		if (!contextMenuMessage) return;

		const activeChannel = $channels.find((channel) => channel.id === $currentChannel);
		const quoteText = formatCustomQuote(
			{
				user: contextMenuMessage.user,
				text: getQuoteSourceText(contextMenuMessage),
				timestamp: contextMenuMessage.timestamp,
				channel: activeChannel?.name || $currentChannel,
				messageId: contextMenuMessage.id
			},
			$customQuoteSettingsStore
		);

		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(quoteText);
			} else {
				window.prompt('Copy quote:', quoteText);
			}
		} catch {
			window.prompt('Copy quote:', quoteText);
		} finally {
			contextMenuVisible = false;
		}
	}

	async function handleCopyMessageLink(): Promise<void> {
		if (!contextMenuMessage) return;
		const deepLink = `${window.location.origin}${window.location.pathname}#channel/${encodeURIComponent($currentChannel)}/message/${encodeURIComponent(contextMenuMessage.id)}`;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(deepLink);
			} else {
				window.prompt('Copy message link:', deepLink);
			}
		} catch {
			window.prompt('Copy message link:', deepLink);
		} finally {
			contextMenuVisible = false;
		}
	}
	let showForwardDialog = false;
	let forwardMessage: Message | null = null;
	const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000;
	function handleForward() {
		if (!contextMenuMessage) return;
		forwardMessage = contextMenuMessage;
		showForwardDialog = true;
		contextMenuVisible = false;
	}
	function isGroupedWithPrevious(index: number): boolean {
		if (index <= 0) return false;
		const current = messages[index];
		const previous = messages[index - 1];
		if (!current || !previous) return false;
		if (firstUnreadMessageId === current.id) return false;
		if (current.user !== previous.user) return false;
		if (current.replyTo || previous.replyTo) return false;
		const delta = current.timestamp - previous.timestamp;
		return delta >= 0 && delta <= MESSAGE_GROUP_WINDOW_MS;
	}

	function isGroupedWithNext(index: number): boolean {
		if (index < 0 || index >= messages.length - 1) return false;
		return isGroupedWithPrevious(index + 1);
	}
	function handleAddReaction() {
		if (!contextMenuMessage) return;
		// Open emoji picker at the context menu position
		recordQuickReactionTelemetry('picker_open');
		reactionPickerMessageId = contextMenuMessage.id;
		reactionPickerChannelId = $currentChannel;
		reactionPickerX = contextMenuX;
		reactionPickerY = contextMenuY;
		ensureEmojiPickerLoaded();
		showReactionPicker = true;
		contextMenuVisible = false;
	}

	function resolveTranslatorProviderUrl(model: string): string {
		if (model === 'libretranslate-public') return 'https://libretranslate.com/translate';
		return 'http://127.0.0.1:5000/translate';
	}

	function getTranslatorSettings(): TranslatorSettings {
		if (typeof window === 'undefined') {
			return {
				model: 'libretranslate-local',
				providerUrl: resolveTranslatorProviderUrl('libretranslate-local'),
				sourceLang: 'auto',
				targetLang: 'en',
				useProxy: true
			};
		}
		try {
			const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY);
			if (!raw) {
				return {
					model: 'libretranslate-local',
					providerUrl: resolveTranslatorProviderUrl('libretranslate-local'),
					sourceLang: 'auto',
					targetLang: 'en',
					useProxy: true
				};
			}
			const parsed = JSON.parse(raw);
			const model = typeof parsed?.model === 'string' && parsed.model.trim()
				? parsed.model.trim()
				: 'libretranslate-local';
			const resolvedProviderUrl = typeof parsed?.providerUrl === 'string' && parsed.providerUrl.trim()
				? parsed.providerUrl.trim()
				: resolveTranslatorProviderUrl(model);
			return {
				model,
				providerUrl: resolvedProviderUrl,
				sourceLang: 'auto',
				targetLang: typeof parsed?.targetLang === 'string' && parsed.targetLang.trim() ? parsed.targetLang.trim() : 'en',
				useProxy: parsed?.useProxy !== false
			};
		} catch {
			return {
				model: 'libretranslate-local',
				providerUrl: resolveTranslatorProviderUrl('libretranslate-local'),
				sourceLang: 'auto',
				targetLang: 'en',
				useProxy: true
			};
		}
	}

	async function requestTranslation(text: string, settings: TranslatorSettings): Promise<string> {
		if (settings.useProxy) {
			const response = await fetch(`${getServerUrl()}/api/plugins/runtime/translator-assist/translate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					providerUrl: settings.providerUrl,
					text,
					sourceLang: settings.sourceLang,
					targetLang: settings.targetLang
				})
			});
			if (!response.ok) {
				const detail = await response.text();
				throw new Error(`Proxy translate failed (${response.status}) ${detail.slice(0, 180)}`);
			}
			const data = await response.json();
			const translated = typeof data?.translatedText === 'string' ? data.translatedText.trim() : '';
			if (!translated) throw new Error('No translated text returned');
			return translated;
		}

		const response = await fetch(settings.providerUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				q: text,
				source: settings.sourceLang,
				target: settings.targetLang,
				format: 'text'
			})
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(`Translator failed (${response.status}) ${raw.slice(0, 180)}`);
		}
		try {
			const parsed = JSON.parse(raw);
			const translated =
				typeof parsed?.translatedText === 'string' ? parsed.translatedText :
				typeof parsed?.translation === 'string' ? parsed.translation :
				typeof parsed?.data?.translatedText === 'string' ? parsed.data.translatedText :
				'';
			if (translated.trim()) return translated.trim();
		} catch {
			// Non-JSON response may already be translated text.
		}
		if (raw.trim()) return raw.trim();
		throw new Error('No translated text returned');
	}

	async function handleTranslate() {
		if (!contextMenuMessage?.text?.trim()) return;
		const targetMessage = contextMenuMessage;
		const settings = getTranslatorSettings();
		if (!settings.providerUrl) {
			alert('Select a translator model in Settings > Add-ons > Translator Assist.');
			contextMenuVisible = false;
			return;
		}

		if (translatedMessages[targetMessage.id]) {
			const next = { ...translatedMessages };
			delete next[targetMessage.id];
			translatedMessages = next;
			contextMenuVisible = false;
			return;
		}

		translatedMessages = { ...translatedMessages, [targetMessage.id]: '...' };
		translatingMessageIds = new Set([...translatingMessageIds, targetMessage.id]);
		contextMenuVisible = false;
		try {
			const translated = await requestTranslation(targetMessage.text, settings);
			translatedMessages = { ...translatedMessages, [targetMessage.id]: translated };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Translation failed';
			translatedMessages = { ...translatedMessages, [targetMessage.id]: `(${message})` };
		} finally {
			const next = new Set(translatingMessageIds);
			next.delete(targetMessage.id);
			translatingMessageIds = next;
		}
	}

	function openReactionPicker(event: MouseEvent, messageId: string) {
		event.stopPropagation();
		recordQuickReactionTelemetry('picker_open');
		reactionPickerMessageId = messageId;
		reactionPickerChannelId = $currentChannel;
		reactionPickerX = event.clientX;
		reactionPickerY = event.clientY;
		ensureEmojiPickerLoaded();
		showReactionPicker = true;
	}
	function handleReactionSelect(event: CustomEvent<{ emoji: Emoji }>) {
		if (!reactionPickerMessageId || !reactionPickerChannelId) return;
		addReaction(reactionPickerChannelId, reactionPickerMessageId, event.detail.emoji.id);
		closeReactionPicker();
	}
	function getCurrentIdentityIds(): string[] {
		return Array.from(ownIdentityIds);
	}

	function isOwnMessage(message: Message): boolean {
		if (!$currentUser) return false;
		if (message.user === $currentUser.username) return true;
		return ownIdentityIds.has(message.userId);
	}

	function getCurrentReactionIdentityIds(): string[] {
		return getCurrentIdentityIds();
	}
	function hasCurrentUserReaction(userIds?: string[]): boolean {
		if (!userIds || userIds.length === 0) return false;
		const currentIds = getCurrentReactionIdentityIds();
		return currentIds.some(id => userIds.includes(id));
	}
	function getReactionUsername(userId: string): string {
		if (userId.startsWith('user-')) {
			const dbUserId = Number(userId.substring(5));
			if (!Number.isNaN(dbUserId)) {
				const userRecord = userByDbId.get(dbUserId);
				if (userRecord?.username) return userRecord.username;
			}
		}
		return userBySocketId.get(userId)?.username || get(_)('messages.unknown_user');
	}
	function getReactionTooltip(userIds: string[]): string {
		return userIds.map(getReactionUsername).filter(Boolean).join(', ');
	}
	function toggleReaction(messageId: string, emojiId: string) {
		const message = messages.find(m => m.id === messageId);
		if (!message || !message.reactions) {
			addReaction($currentChannel, messageId, emojiId);
			return;
		}
		const userReacted = hasCurrentUserReaction(message.reactions[emojiId]);
		if (userReacted) {
			removeReaction($currentChannel, messageId, emojiId);
		} else {
			addReaction($currentChannel, messageId, emojiId);
		}
	}
	$: if (showReactionPicker && reactionPickerChannelId && $currentChannel !== reactionPickerChannelId) {
		closeReactionPicker();
	}
	$: if (showUserPopout) {
		ensureUserPopoutLoaded();
	}
	function getEmojiById(emojiId: string): Emoji | undefined {
		return $emojis.find(e => e.id === emojiId);
	}

	const QUICK_REACTION_NAME_CANDIDATES: string[][] = [
		['thumbsup', 'thumbs_up', 'thumb-up', 'like', '+1'],
		['heart', 'red_heart', 'love'],
		['joy', 'face_with_tears_of_joy', 'laughing'],
		['fire'],
		['eyes']
	];
	const QUICK_REACTION_VISIBLE_LIMIT = 4;
	const QUICK_REACTION_EXISTING_LIMIT = 2;
	const QUICK_REACTION_ALIAS_SCAN_LIMIT = 320;
	let quickReactionEmojiById = new Map<string, Emoji>();
	let quickReactionFallbackPool: Emoji[] = [];
	let quickReactionCache = new Map<string, Emoji[]>();

	function normalizeEmojiLookupName(value: string | undefined): string {
		return (value || '').trim().toLowerCase().replace(/[^a-z0-9+]/g, '');
	}

	$: {
		const emojiCatalog = Array.isArray($emojis) ? $emojis : [];
		const nextEmojiById = new Map<string, Emoji>();
		for (const emoji of emojiCatalog) {
			nextEmojiById.set(emoji.id, emoji);
		}
		quickReactionEmojiById = nextEmojiById;

		if (!$quickReactionSettingsStore.enabled || emojiCatalog.length === 0) {
			quickReactionFallbackPool = [];
			quickReactionCache = new Map();
		} else {
			const aliasScanPool =
				emojiCatalog.length > QUICK_REACTION_ALIAS_SCAN_LIMIT
					? emojiCatalog.slice(0, QUICK_REACTION_ALIAS_SCAN_LIMIT)
					: emojiCatalog;
			const selected: Emoji[] = [];
			const seen = new Set<string>();
			const addEmoji = (emoji: Emoji | undefined) => {
				if (!emoji || seen.has(emoji.id)) return;
				seen.add(emoji.id);
				selected.push(emoji);
			};

			for (const emojiId of $quickReactionSettingsStore.customEmojiIds) {
				addEmoji(nextEmojiById.get(emojiId));
				if (selected.length >= QUICK_REACTION_VISIBLE_LIMIT) {
					break;
				}
			}

			for (const aliases of QUICK_REACTION_NAME_CANDIDATES) {
				const match = aliasScanPool.find((emoji) => {
					const normalizedName = normalizeEmojiLookupName(emoji.name);
					const normalizedDisplayName = normalizeEmojiLookupName(emoji.displayName);
					return aliases.some(
						(alias) => alias === normalizedName || alias === normalizedDisplayName
					);
				});
				addEmoji(match);
				if (selected.length >= QUICK_REACTION_VISIBLE_LIMIT) break;
			}

			if (selected.length < QUICK_REACTION_VISIBLE_LIMIT) {
				for (const emoji of aliasScanPool) {
					addEmoji(emoji);
					if (selected.length >= QUICK_REACTION_VISIBLE_LIMIT) break;
				}
			}

			quickReactionFallbackPool = selected.slice(0, QUICK_REACTION_VISIBLE_LIMIT);
			quickReactionCache = new Map();
		}
	}

	function getQuickReactionEmojis(message: Message): Emoji[] {
		if (!$quickReactionSettingsStore.enabled) {
			return [];
		}

		if (quickReactionEmojiById.size === 0) {
			return [];
		}

		const reactionSignature = Object.entries(message.reactions || {})
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([emojiId, userIds]) => `${emojiId}:${userIds.length}`)
			.join('|');
		const cacheKey = `${message.id}:${reactionSignature}`;
		const cached = quickReactionCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const selected: Emoji[] = [];
		const seen = new Set<string>();
		const addEmoji = (emoji: Emoji | undefined) => {
			if (!emoji || seen.has(emoji.id)) return;
			seen.add(emoji.id);
			selected.push(emoji);
		};

		if (message.reactions) {
			const topExisting = Object.entries(message.reactions)
				.sort((a, b) => b[1].length - a[1].length)
				.slice(0, QUICK_REACTION_EXISTING_LIMIT);
			for (const [emojiId] of topExisting) {
				addEmoji(quickReactionEmojiById.get(emojiId));
			}
		}

		for (const emoji of quickReactionFallbackPool) {
			addEmoji(emoji);
			if (selected.length >= QUICK_REACTION_VISIBLE_LIMIT) {
				break;
			}
		}

		const next = selected.slice(0, QUICK_REACTION_VISIBLE_LIMIT);
		quickReactionCache.set(cacheKey, next);
		return next;
	}

	function quickReactToMessage(messageId: string, emojiId: string): void {
		recordQuickReactionTelemetry('quick_strip_click');
		toggleReaction(messageId, emojiId);
	}

	function handleImageContextMenu(event: MouseEvent, message: Message) {
		event.preventDefault();
		contextMenuMessage = message;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		contextMenuVisible = true;
	}
	function formatFileSize(bytes?: number): string {
		if (!bytes) return '';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}
	function getFileUrl(fileUrl?: string): string {
		if (!fileUrl) return '';
		if (fileUrl.startsWith('data:')) {
			return fileUrl;
		}

		if (fileUrl.startsWith('http:') || fileUrl.startsWith('https:')) {
			try {
				const absoluteUrl = new URL(fileUrl);
				const isLocalUpload =
					(absoluteUrl.hostname === 'localhost' || absoluteUrl.hostname === '127.0.0.1') &&
					absoluteUrl.pathname.startsWith('/uploads/');

				if (isLocalUpload) {
					const normalizedPath = `${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
					if ($relayEnabled) {
						return getRelayFileUrl(normalizedPath);
					}
					return `${getServerUrl()}${normalizedPath}`;
				}
			} catch {
				// Fall through and return original URL if parsing fails.
			}
			return fileUrl;
		}

		// Use relay if enabled and available
		if ($relayEnabled) {
			return getRelayFileUrl(fileUrl);
		}
		// Otherwise, prepend the resolved backend server URL
		return `${getServerUrl()}${fileUrl}`;
	}

	function isEncryptedAttachment(attachment: { attachmentEncryption?: { scheme: 'dm-e2ee-v1'; iv: string } }): boolean {
		return attachment?.attachmentEncryption?.scheme === 'dm-e2ee-v1' && !!attachment?.attachmentEncryption?.iv;
	}

	async function downloadAttachment(
		fileUrl: string,
		fileName: string,
		attachmentEncryption?: { scheme: 'dm-e2ee-v1'; iv: string; mimeType?: string; originalSize?: number }
	): Promise<void> {
		const resolvedUrl = getFileUrl(fileUrl);
		const response = await fetch(resolvedUrl);
		if (!response.ok) throw new Error(`Failed to download attachment (${response.status})`);

		if (!attachmentEncryption || attachmentEncryption.scheme !== 'dm-e2ee-v1') {
			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = fileName;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			window.URL.revokeObjectURL(url);
			return;
		}

		const channel = $channels.find((ch) => ch.id === $currentChannel);
		const otherDbUserId = channel?.type === 'dm' ? channel.otherUser?.dbUserId : undefined;
		const authToken = getAuthToken();
		if (!otherDbUserId || !authToken || !isE2EAvailable()) {
			alert(get(_)('messages.errors.cannot_decrypt_session'));
			return;
		}

		const encryptedBuffer = await response.arrayBuffer();
		const decrypted = await decryptDMFileBuffer(
			encryptedBuffer,
			attachmentEncryption.iv,
			otherDbUserId,
			authToken
		);
		if (!decrypted) {
			alert(get(_)('messages.errors.decrypt_failed'));
			return;
		}

		const blob = new Blob([decrypted], {
			type: attachmentEncryption.mimeType || 'application/octet-stream'
		});
		const url = window.URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		window.URL.revokeObjectURL(url);
	}
	function getReplyToMessage(replyToId?: string): Message | undefined {
		if (!replyToId) return undefined;
		return messageById.get(replyToId);
	}

	function getFilteredIncomingMessage(message: Message): ChatFilterResult {
		const cacheKey = `${message.id}:${message.text || ''}`;
		const cached = incomingFilterCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const next = applyChatFilter(message.text || '', 'incoming', $chatFilterStore);
		incomingFilterCache.set(cacheKey, next);
		return next;
	}
	// Jump to referenced message
	let highlightedMessageId: string | null = null;
	function jumpToMessage(messageId: string) {
		const messageElement = document.getElementById(`message-${messageId}`);
		if (messageElement) {
			messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
			// Highlight the message briefly
			highlightedMessageId = messageId;
			setTimeout(() => {
				highlightedMessageId = null;
			}, 2000);
		}
	}
	// Extract URLs from message text
	function extractUrls(text: string): string[] {
		const urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
		const matches = text.match(urlRegex);
		return matches || [];
	}

	// TEMPORARY: Detect media URLs (images, videos, audio, 3D models)
	function getMediaType(url: string): 'image' | 'video' | 'audio' | 'model' | null {
		try {
			const urlObj = new URL(url);
			const pathname = urlObj.pathname.toLowerCase();

			// Image extensions
			if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(pathname)) {
				return 'image';
			}
			// Video extensions
			if (/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v)(\?|#|$)/i.test(pathname)) {
				return 'video';
			}
			// Audio extensions
			if (/\.(mp3|wav|ogg|m4a|flac|aac|wma)(\?|#|$)/i.test(pathname)) {
				return 'audio';
			}
			// 3D model extensions
			if (/\.(glb|gltf|obj|stl)(\?|#|$)/i.test(pathname)) {
				return 'model';
			}
		} catch (e) {
			// Invalid URL
		}
		return null;
	}

	function isMediaUrl(url: string): boolean {
		return getMediaType(url) !== null;
	}

	function isYouTubeUrl(url: string): boolean {
		try {
			const parsed = new URL(url);
			return (
				parsed.hostname.includes('youtube.com') ||
				parsed.hostname.includes('youtu.be')
			);
		} catch {
			return false;
		}
	}

	function isYouTubeQueueChannel(channelId: string): boolean {
		const channel = $channels.find((ch) => ch.id === channelId);
		return Boolean(channel?.watchQueueEnabled);
	}

	function getFileIcon(fileName?: string): string {
		if (!fileName) return '📎';
		const ext = fileName.toLowerCase().split('.').pop() || '';
		const iconMap: Record<string, string> = {
			// Images
			'jpg': '🖼️',
			'jpeg': '🖼️',
			'png': '🖼️',
			'gif': '🖼️',
			'bmp': '🖼️',
			'svg': '🖼️',
			'webp': '🖼️',
			// Videos
			'mp4': '🎬',
			'mov': '🎬',
			'avi': '🎬',
			'mkv': '🎬',
			'webm': '🎬',
			'flv': '🎬',
			// Audio
			'mp3': '🎵',
			'wav': '🎵',
			'ogg': '🎵',
			'flac': '🎵',
			// Documents
			'pdf': '📄',
			'doc': '📝',
			'docx': '📝',
			'txt': '📝',
			'rtf': '📝',
			// Spreadsheets
			'xls': '📊',
			'xlsx': '📊',
			'csv': '📊',
			// Presentations
			'ppt': '📽️',
			'pptx': '📽️',
			// Archives
			'zip': '📦',
			'rar': '📦',
			'7z': '📦',
			'tar': '📦',
			'gz': '📦',
			// Code
			'js': '💻',
			'ts': '💻',
			'py': '💻',
			'java': '💻',
			'cpp': '💻',
			'c': '💻',
			'cs': '💻',
			'html': '💻',
			'css': '💻',
			'json': '💻',
			// 3D/Design
			'blend': '🎨',
			'fbx': '🎨',
			'obj': '🎨',
			'stl': '🎨',
			'psd': '🎨',
			'ai': '🎨',
			'sketch': '🎨',
		};
		return iconMap[ext] || '📎';
	}

	function parseRoleGateText(text: string): { title: string; description: string } {
		const normalized = (text || '').trim();
		if (!normalized) return { title: get(_)('messages.role_gate.title'), description: '' };
		const [firstLine, ...rest] = normalized.split('\n');
		return {
			title: firstLine.trim() || get(_)('messages.role_gate.title'),
			description: rest.join('\n').trim()
		};
	}

	function isLocalDirectionsMessage(message: Message): boolean {
		return message.userId === 'local-directions' && message.localCard?.kind === 'directions';
	}

	function getDirectionsMeta(message: Message) {
		return message.localCard?.kind === 'directions' ? message.localCard : null;
	}

	function formatDirectionsExpiry(expiresAt?: number): string {
		if (!expiresAt) return 'Temporary';
		const remainingMs = Math.max(0, expiresAt - Date.now());
		const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
		return `Temporary | expires in ${remainingMinutes} min`;
	}

	function openDirectionsExternal(url?: string): void {
		if (!browser || !url) return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function isImage(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext);
	}
	function isVideo(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'm4v'].includes(ext);
	}
	function isAudio(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'].includes(ext);
	}
	function isModelFile(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['glb', 'gltf', 'obj', 'stl'].includes(ext);
	}
	function isBlendFile(fileName?: string): boolean {
		if (!fileName) return false;
		return fileName.toLowerCase().endsWith('.blend');
	}

	function isZipFile(fileName?: string): boolean {
		if (!fileName) return false;
		return fileName.toLowerCase().endsWith('.zip');
	}

	function openBlendImportSettings(sourcePath: string, fileName: string): void {
		blendImportSourcePath = sourcePath;
		blendImportFileName = fileName;
		ensureBlendImportSettingsModalLoaded();
		showBlendImportSettings = true;
	}

	async function queueBlendImport(event: CustomEvent<BlendImportSettingsPayload>): Promise<void> {
		if (blendImportSubmitting) return;
		blendImportSubmitting = true;
		try {
			const authToken = getAuthToken();
			const response = await fetch(`${getServerUrl()}/api/plugins/runtime/model-viewer/blend/jobs`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
				},
				credentials: 'include',
				body: JSON.stringify({
					channelId: $currentChannel,
					...event.detail
				})
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload?.success === false) {
				throw new Error(payload?.error || `Failed to queue import (${response.status})`);
			}
			alert(
				payload?.job?.id
					? get(_)('messages.blend.queued_with_id', { values: { id: payload.job.id } })
					: get(_)('messages.blend.queued')
			);
			showBlendImportSettings = false;
		} catch (error) {
			alert(error instanceof Error ? error.message : get(_)('messages.blend.queue_failed'));
		} finally {
			blendImportSubmitting = false;
		}
	}
	// Mobile long-press message actions
	let mobileActionsMessageId: string | null = null;

	onMount(() => {
		void loadPlaceRegistry();
		deletionCountdownMode = readDeletionCountdownModeFromDom();
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			deletionCountdownMode = readDeletionCountdownModeFromDom();
			if (deletionCountdownMode !== 'live') {
				nowMs = Date.now();
			}
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: ['data-deletion-countdown-mode']
		});

		const timer = window.setInterval(() => {
			if (deletionCountdownMode === 'live') {
				nowMs = Date.now();
			}
		}, 1000);
		return () => {
			clearBurstAnimationReset();
			observer.disconnect();
			window.clearInterval(timer);
		};
	});

	onDestroy(() => {
		clearBurstAnimationReset();
	});

	function handleMessageLongPress(event: TouchEvent, message: Message) {
		mobileActionsMessageId = message.id;
	}

	function dismissMobileActions() {
		mobileActionsMessageId = null;
	}

	let enlargedImage: string | null = null;
	let enlargedVideo: string | null = null;
	let currentImageGallery: string[] = [];
	let currentImageIndex: number = 0;
	let imageZoom = 1;
	let imageMenuOpen = false;
	let imageMeta: { name: string; width: number | null; height: number | null; sizeBytes: number | null } = {
		name: '',
		width: null,
		height: null,
		sizeBytes: null
	};

	function getFileNameFromUrl(url: string): string {
		try {
			const pathname = new URL(url, window.location.origin).pathname;
			const lastSegment = pathname.split('/').pop() || 'image';
			return decodeURIComponent(lastSegment);
		} catch {
			return 'image';
		}
	}

	function formatBytes(bytes: number | null): string {
		if (bytes === null || Number.isNaN(bytes)) return 'Unknown';
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		const mb = kb / 1024;
		if (mb < 1024) return `${mb.toFixed(1)} MB`;
		const gb = mb / 1024;
		return `${gb.toFixed(2)} GB`;
	}

	function resetImageOverlayState(url: string) {
		imageZoom = 1;
		imageMenuOpen = false;
		imageMeta = {
			name: getFileNameFromUrl(url),
			width: null,
			height: null,
			sizeBytes: null
		};
		void resolveImageSize(url);
	}

	async function resolveImageSize(url: string) {
		try {
			const response = await fetch(url);
			if (!response.ok) return;
			const blob = await response.blob();
			imageMeta = { ...imageMeta, sizeBytes: blob.size };
		} catch {
			// Ignore metadata failures for external/CORS-protected URLs.
		}
	}

	function setImageZoom(nextZoom: number) {
		imageZoom = Math.max(0.25, Math.min(5, nextZoom));
	}

	function zoomIn() {
		setImageZoom(imageZoom + 0.25);
	}

	function zoomOut() {
		setImageZoom(imageZoom - 0.25);
	}

	function resetZoom() {
		imageZoom = 1;
	}

	function toggleImageMenu() {
		imageMenuOpen = !imageMenuOpen;
	}

	function onEnlargedImageLoad(event: Event) {
		const imageEl = event.currentTarget as HTMLImageElement;
		imageMeta = {
			...imageMeta,
			width: imageEl.naturalWidth || null,
			height: imageEl.naturalHeight || null
		};
	}

	async function copyCurrentImageLink() {
		if (!enlargedImage || !navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(enlargedImage);
		} catch (error) {
			console.warn('Failed to copy image link:', error);
		}
		imageMenuOpen = false;
	}

	async function copyCurrentImage() {
		if (!enlargedImage || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
			await copyCurrentImageLink();
			return;
		}
		try {
			const response = await fetch(enlargedImage);
			if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);
			const blob = await response.blob();
			await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
		} catch (error) {
			console.warn('Failed to copy image, falling back to link copy:', error);
			await copyCurrentImageLink();
		}
		imageMenuOpen = false;
	}

	function openReverseImageSearch(): void {
		if (!enlargedImage) return;
		const provider = getReverseImageSearchProvider();
		const searchUrl = buildReverseImageSearchUrl(enlargedImage, provider);
		window.open(searchUrl, '_blank', 'noopener,noreferrer');
		imageMenuOpen = false;
	}

	async function forwardCurrentImage() {
		if (!enlargedImage) return;
		const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
		if (nav.share) {
			try {
				await nav.share({ url: enlargedImage, title: imageMeta.name });
				return;
			} catch {
				// Share dialog dismissed or unavailable for this payload.
			}
		}
		await copyCurrentImageLink();
	}

	function enlargeImage(imageUrl: string, gallery: string[] = []) {
		enlargedImage = imageUrl;
		currentImageGallery = gallery.length > 0 ? gallery : [imageUrl];
		currentImageIndex = currentImageGallery.indexOf(imageUrl);
		resetImageOverlayState(imageUrl);
	}
	function closeEnlargedImage() {
		enlargedImage = null;
		currentImageGallery = [];
		currentImageIndex = 0;
		imageMenuOpen = false;
	}
	function navigateImage(direction: 'prev' | 'next') {
		if (currentImageGallery.length === 0) return;
		if (direction === 'prev') {
			currentImageIndex = (currentImageIndex - 1 + currentImageGallery.length) % currentImageGallery.length;
		} else {
			currentImageIndex = (currentImageIndex + 1) % currentImageGallery.length;
		}
		enlargedImage = currentImageGallery[currentImageIndex];
		if (enlargedImage) resetImageOverlayState(enlargedImage);
	}
	function handleImageKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && contextMenuVisible) {
			e.preventDefault();
			contextMenuVisible = false;
			return;
		}
		if (!enlargedImage) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			navigateImage('prev');
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			navigateImage('next');
		} else if (e.key === 'Escape') {
			e.preventDefault();
			closeEnlargedImage();
		} else if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			zoomIn();
		} else if (e.key === '-') {
			e.preventDefault();
			zoomOut();
		} else if (e.key === '0') {
			e.preventDefault();
			resetZoom();
		}
	}
	function enlargeVideo(videoUrl: string) {
		enlargedVideo = videoUrl;
	}
	function closeEnlargedVideo() {
		enlargedVideo = null;
	}
	function toggleSpoiler(target: HTMLElement, event: MouseEvent): void {
		if (canUseRevealAllSpoilers() && (event.ctrlKey || event.metaKey)) {
			const shouldReveal = !target.classList.contains('revealed');
			const messageContainer = target.closest('.message');
			if (messageContainer) {
				const relatedSpoilers = messageContainer.querySelectorAll<HTMLElement>(
					'.spoiler[data-spoiler="true"]'
				);
				relatedSpoilers.forEach((item) => item.classList.toggle('revealed', shouldReveal));
			} else {
				target.classList.toggle('revealed', shouldReveal);
			}
			return;
		}

		target.classList.toggle('revealed');
	}

	function handleCapturedSpoilerClick(event: MouseEvent): void {
		const target = event.target as HTMLElement | null;
		if (!target) return;
		const spoiler = target.closest('.spoiler[data-spoiler="true"]');
		if (!(spoiler instanceof HTMLElement)) return;
		toggleSpoiler(spoiler, event);
		event.preventDefault();
		event.stopPropagation();
	}

	// Pagination state (client-side archives)
	let showLoadMore = false;
	let isLoadingOlder = false;
	let hasMoreMessages = false;
	let nextArchivePeriod: string | null = null;

	// Server-side history pagination state
	let hasMoreServerHistory = false;
	let isLoadingServerHistory = false;
	let visibleMessages: Message[] = [];
	let visibleMessageStart = 0;

	// Reactive statements to compute pagination state based on current channel
	$: {
		const currentChannelData = $channels.find(ch => ch.id === $currentChannel);
		showLoadMore = currentChannelData?.persistMessages === true;

		// Client-side archive pagination
		if (showLoadMore) {
			const available = $channelAvailableArchives[$currentChannel] || [];
			const loaded = $channelLoadedArchives[$currentChannel] || new Set();
			isLoadingOlder = $channelLoadingOlder[$currentChannel] || false;
			hasMoreMessages = available.length > loaded.size;
			nextArchivePeriod = available.find(a => !loaded.has(a)) || null;
		}

		// Server-side history pagination
		hasMoreServerHistory = $channelHasMoreHistory[$currentChannel] ?? false; // Hidden until server confirms
		isLoadingServerHistory = $channelHistoryLoading[$currentChannel] || false;
	}
	$: if (lastChannelForRenderWindow !== $currentChannel) {
		lastChannelForRenderWindow = $currentChannel;
		messageRenderLimit = MESSAGE_RENDER_BATCH;
		lastObservedMessageCount = messages.length;
		lastObservedLastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
		burstArrivalTimestamps = [];
		burstAnimationSuppressed = false;
		clearBurstAnimationReset();
	}
	$: {
		const latestMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
		if (
			lastObservedLastMessageId !== null &&
			latestMessageId !== null &&
			latestMessageId !== lastObservedLastMessageId &&
			messages.length >= lastObservedMessageCount
		) {
			recordMessageBurst(Math.max(1, Math.min(messages.length - lastObservedMessageCount, 12)));
		}
		lastObservedMessageCount = messages.length;
		lastObservedLastMessageId = latestMessageId;
	}
	$: {
		const boundedLimit = Math.min(Math.max(messageRenderLimit, MESSAGE_RENDER_BATCH), MESSAGE_RENDER_MAX);
		messageRenderLimit = boundedLimit;
		visibleMessageStart = Math.max(0, messages.length - boundedLimit);
		visibleMessages = messages.slice(visibleMessageStart);
	}

	async function handleLoadMore() {
		if (!$currentChannel) return;
		if (visibleMessageStart > 0) {
			messageRenderLimit = Math.min(MESSAGE_RENDER_MAX, messageRenderLimit + MESSAGE_RENDER_BATCH);
			return;
		}
		// Prefer server-side history loading
		if (hasMoreServerHistory && !isLoadingServerHistory) {
			loadOlderHistory($currentChannel);
		} else if (hasMoreMessages && !isLoadingOlder) {
			// Fallback to client-side archives
			await loadOlderMessages($currentChannel);
		}
	}

	// Scroll handler for infinite scroll
	function handleScroll(e: Event) {
		const target = e.target as HTMLElement;
		// Load more when scrolled near the top (within 100px)
		if (target.scrollTop < 100 && hasMoreServerHistory && !isLoadingServerHistory) {
			loadOlderHistory($currentChannel);
		}
	}
</script>

<!-- Window-level keyboard listener for image navigation -->
<svelte:window
	on:keydown={handleImageKeydown}
	on:click={dismissMobileActions}
	on:click|capture={handleCapturedSpoilerClick}
/>

<!-- Load More Messages Button -->
{#if visibleMessageStart > 0 || ((hasMoreServerHistory || hasMoreMessages) && messages.length >= 50)}
	<div class="load-more-container">
		<button class="load-more-btn" on:click={handleLoadMore} disabled={isLoadingServerHistory || isLoadingOlder}>
			{#if isLoadingServerHistory || isLoadingOlder}
				<span class="spinner"></span> {$_('messages.pagination.loading')}
			{:else if visibleMessageStart > 0}
				{$_('messages.pagination.show_older_loaded')}
			{:else}
				{$_('messages.pagination.load_older')}
			{/if}
		</button>
	</div>
{:else if messages.length > 0}
	<div class="load-more-container">
		<div class="no-more-messages">{$_('messages.pagination.beginning')}</div>
	</div>
{/if}

{#each visibleMessages as message, localIndex (message.id)}
	{@const index = visibleMessageStart + localIndex}
	{@const author = getUserByMessageAuthor(message)}
	{@const displayUsername = getMessageDisplayUsername(message, author)}
	{@const replyToMsg = getReplyToMessage(message.replyTo)}
	{@const groupedWithPrevious = isGroupedWithPrevious(index)}
	{@const groupedWithNext = isGroupedWithNext(index)}
	{@const ownMessage = isOwnMessage(message)}
	{@const deletionLabel = getMessageDeletionLabel(message)}
	{@const translatedText = translatedMessages[message.id]}
	{@const translationLoading = translatingMessageIds.has(message.id)}
		{@const filteredMessage = getFilteredIncomingMessage(message)}
	{@const hideByFilter = filteredMessage.hidden}
		{@const messageText = filteredMessage.text}
		{@const shouldAnimateMessage = !burstAnimationSuppressed && visibleMessages.length - localIndex <= ($animationPassStore.level === 'full' ? 48 : 24)}
		{@const quickReactionEmojis = getQuickReactionEmojis(message)}

	{#if !hideByFilter}
		<!-- New Messages Divider -->
		{#if firstUnreadMessageId === message.id}
			<div class="new-messages-divider">
				<span>{$_('messages.new_messages')}</span>
			</div>
		{/if}

		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			id="message-{message.id}"
			class="message {message.isPinned ? 'pinned' : ''} {isPersonalPinnedMessage(message.id) ? 'personal-pinned' : ''} {highlightedMessageId === message.id ? 'highlighted' : ''} {groupedWithPrevious ? 'continuation' : ''} {groupedWithNext ? 'has-continuation' : ''} {ownMessage ? 'own-message' : ''} {message.deliveryState === 'sending' ? 'is-sending' : ''} {message.deliveryState === 'failed' ? 'is-send-failed' : ''}"
			title={message.deliveryState === 'failed' ? (message.deliveryError || 'Message failed to send') : undefined}
			on:contextmenu={(e) => handleContextMenu(e, message)}
			use:longpress={{ onLongPress: (e) => handleMessageLongPress(e, message) }}
			transition:messageItemTransition={{
				...messageAnimation,
				animate: shouldAnimateMessage
			}}
		>
			<div class="message-actions" class:mobile-visible={mobileActionsMessageId === message.id}>
			{#if quickReactionEmojis.length > 0}
				<div class="quick-reactions-strip">
					{#each quickReactionEmojis as quickEmoji (quickEmoji.id)}
						<button
							class="quick-reaction-btn"
							title={`Quick react: ${quickEmoji.displayName || quickEmoji.name}`}
							on:click|stopPropagation={() => quickReactToMessage(message.id, quickEmoji.id)}
						>
							<img
								src={quickEmoji.url}
								alt={quickEmoji.displayName || quickEmoji.name}
								class="quick-reaction-emoji"
								loading="lazy"
								decoding="async"
							/>
						</button>
					{/each}
				</div>
			{/if}
			<button class="action-btn" title={$_('messages.add_reaction')} on:click={(e) => openReactionPicker(e, message.id)}>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
			</button>
			<button class="action-btn" title={$_('messages.actions.reply')} on:click={() => handleReply(message)}>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
			</button>
			{#if $displayEnhancementSettingsStore.messageUtilitiesEnabled}
				{#if $displayEnhancementSettingsStore.quickMentionEnabled && !ownMessage}
					<button class="action-btn utility-btn" title={$_('context_menu.quick_mention')} on:click={() => handleQuickMention(message)}>
						@
					</button>
				{/if}
				<button class="action-btn utility-btn" title={message.isPinned ? $_('context_menu.unpin_message') : $_('context_menu.pin_message')} on:click={() => handleUtilityPinToggle(message)}>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				</button>
				{#if ownMessage}
					<button class="action-btn utility-btn" title={$_('context_menu.edit_message')} on:click={() => handleUtilityEdit(message)}>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
					</button>
				{/if}
			{/if}
			<button class="action-btn" title={$_('messages.actions.more')} on:click={(e) => handleContextMenu(e, message)}>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
			</button>
		</div>

		<!-- Profile Picture -->
		{#if groupedWithPrevious}
			<div class="message-avatar message-avatar-spacer" aria-hidden="true"></div>
		{:else}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<div class="message-avatar">
					{#if author?.profilePicture}
						<img src={author.profilePicture} alt={displayUsername} class="avatar" loading="lazy" decoding="async" />
					{:else}
						<div class="avatar-placeholder" style="--avatar-color: {getUserColor(author, displayUsername)}">
							{displayUsername.charAt(0).toUpperCase()}
						</div>
					{/if}
				</div>
		{/if}
		<!-- Message Content -->
		<div class="message-body">
			{#if !groupedWithPrevious}
				<div class="message-header">
					<div class="header-left">
						{#if author}
							<!-- svelte-ignore a11y-click-events-have-key-events -->
							<!-- svelte-ignore a11y-no-static-element-interactions -->
							<span
								class="username"
								class:clickable-username={$displayEnhancementSettingsStore.clickableMentionsEnabled}
								style="color: {getUserColor(author, displayUsername)}; {getUsernameStyle(author, displayUsername, $themeStore)}"
								on:click={(event) => handleUsernameClick(event, message, author)}
							>
								{displayUsername}
							</span>
						{:else}
							<span class="username">{displayUsername}</span>
						{/if}
						{#if getTopRoleBadgeLabel(author)}
							<span class={`role-inline-badge tone-${getTopRoleBadgeTone(author)}`}>{getTopRoleBadgeLabel(author)}</span>
						{/if}
						{#if shouldShowStaffTag(author)}
							<span class="staff-inline-tag">Staff</span>
						{/if}
						<span class="timestamp" title={formatTimeTooltip(message.timestamp)}>
							{formatTime(message.timestamp)}
						</span>
						{#if deletionLabel}
							<span class="deletion-timer" title={$_('messages.deletion.scheduled_title')}>
								{deletionLabel}
							</span>
						{/if}
						{#if message.isPinned}
							<span class="pin-badge" title={$_('messages.pinned_title')}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg></span>
						{/if}
						{#if $displayEnhancementSettingsStore.personalPinsEnabled && isPersonalPinnedMessage(message.id)}
							<span class="local-pin-badge" title={$_('context_menu.pin_local_message')}>Local Pin</span>
						{/if}
						{#if message.isEdited}
							<span class="edited-badge" title={$_('messages.edited_title')}>({$_('messages.edited')})</span>
						{/if}
					</div>
				</div>
			{:else}
				<!-- Compact-mode inline header for continuation messages (hidden in cozy) -->
				<div class="message-header compact-only-header">
					<div class="header-left">
						<span class="timestamp" title={formatTimeTooltip(message.timestamp)}>
							{formatTime(message.timestamp)}
						</span>
						{#if author}
							<!-- svelte-ignore a11y-click-events-have-key-events -->
							<!-- svelte-ignore a11y-no-static-element-interactions -->
							<span
								class="username"
								class:clickable-username={$displayEnhancementSettingsStore.clickableMentionsEnabled}
								style="color: {getUserColor(author, displayUsername)}; {getUsernameStyle(author, displayUsername, $themeStore)}"
								on:click={(event) => handleUsernameClick(event, message, author)}
							>
								{displayUsername}
							</span>
						{:else}
							<span class="username">{displayUsername}</span>
						{/if}
						{#if getTopRoleBadgeLabel(author)}
							<span class={`role-inline-badge tone-${getTopRoleBadgeTone(author)}`}>{getTopRoleBadgeLabel(author)}</span>
						{/if}
						{#if shouldShowStaffTag(author)}
							<span class="staff-inline-tag">Staff</span>
						{/if}
					</div>
				</div>
			{/if}
			{#if groupedWithPrevious && deletionLabel}
				<div class="grouped-deletion-meta">
					<span class="deletion-timer" title={$_('messages.deletion.scheduled_title')}>
						{deletionLabel}
					</span>
				</div>
			{/if}
			{#if ownMessage && message.persistenceState}
				<div class="message-persistence-row">
					<span
						class="message-persistence-badge"
						class:is-failed={message.persistenceState === 'failed'}
						class:is-retrying={message.persistenceState === 'retrying'}
						title={message.persistenceError || ''}
					>
						{message.persistenceState === 'retrying'
							? $_('messages.persistence.retrying')
							: $_('messages.persistence.failed')}
					</span>
					{#if message.persistenceState === 'failed'}
						<button
							class="message-persistence-retry"
							type="button"
							on:click={() => retryMessagePersistence($currentChannel, message.id)}
						>
							{$_('messages.persistence.retry')}
						</button>
					{/if}
				</div>
			{/if}

			<!-- Reply Preview -->
			{#if replyToMsg}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<div
					class="reply-preview"
					role="button"
					tabindex="0"
					on:click={() => jumpToMessage(replyToMsg.id)}
					on:keydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							jumpToMessage(replyToMsg.id);
						}
					}}
				>
					<div class="reply-line"></div>
						<div class="reply-content">
							<span class="reply-username">
								{getMessageDisplayUsername(replyToMsg)}
							</span>
							<span class="reply-text">
							{#if replyToMsg.text}
								{replyToMsg.text.substring(0, 100)}{replyToMsg.text.length > 100 ? '...' : ''}
							{:else if replyToMsg.type === 'gif'}
								GIF
							{:else if replyToMsg.type === 'emoji'}
								:{replyToMsg.emojiName || 'sticker'}:
							{:else if replyToMsg.fileUrl}
								{replyToMsg.fileName || $_('messages.file')}
							{:else}
								{$_('messages.message')}
							{/if}
						</span>
					</div>
				</div>
			{/if}

			<!-- Message Content or Edit Mode -->
			{#if editingMessageId === message.id}
				<div class="edit-mode">
					<textarea
						bind:value={editText}
						class="edit-textarea"
						rows="3"
						on:keydown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								saveEdit(message.id);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								cancelEdit();
							}
						}}
					></textarea>
					<div class="edit-actions">
						<button class="edit-cancel" on:click={cancelEdit}>{$_('common.cancel')}</button>
						<button class="edit-save" on:click={() => saveEdit(message.id)}>{$_('common.save')}</button>
					</div>
				</div>
			{:else}
				{@const albumAnnouncement = getAlbumAnnouncementMeta(message)}
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
											openMapPanel(directions.placeId, {
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
											openFullMapTab(directions.placeId, {
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
											openPreferredMapSurface(directions.placeId, {
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
											on:click={() => openDirectionsExternal(directions.externalUrl)}
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
							on:click={() => handleAlbumAnnouncementActivate(albumAnnouncement, false)}
							on:keydown={(event) => handleAlbumAnnouncementKeydown(event, albumAnnouncement, false)}
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
									on:click|stopPropagation={() => triggerAlbumAnnouncementUpload(albumAnnouncement)}
								>
									{albumAnnouncementUploadName === albumAnnouncement.name ? 'Uploading...' : 'Add Media'}
								</button>
								<button type="button" class="album-message-btn primary" on:click|stopPropagation={openAlbumPanel}>
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
								<img src={message.gifUrl} alt="GIF" class="gif {message.isSpoiler ? 'spoiler' : ''}" data-spoiler={message.isSpoiler ? 'true' : 'false'} loading="lazy" decoding="async" />
								{#if messageText}
									<!-- svelte-ignore a11y-click-events-have-key-events -->
									<div
										class="markdown-content gif-caption {gifCaptionStyleClass}"
										on:click={handleMarkdownContentClick}
									>
								{@html parseMessage(messageText, message.entities || [])}
							</div>
								{/if}
							</div>
						{:else if message.type === 'emoji' && message.emojiUrl}
						<img src={message.emojiUrl} alt={message.emojiName || 'emoji'} class="emoji-large {message.isSpoiler ? 'spoiler' : ''}" data-spoiler={message.isSpoiler ? 'true' : 'false'} loading="lazy" decoding="async" />
					{:else if message.type === 'file' && (message.fileUrl || message.files)}
						{#if albumAnnouncement && message.files}
							{@const albumPreviewFiles = getAlbumAnnouncementPreviewFiles(message)}
							<div
								class="album-message-card album-message-card--actionable"
								role="button"
								tabindex="0"
								on:click={() => handleAlbumAnnouncementActivate(albumAnnouncement, true)}
								on:keydown={(event) => handleAlbumAnnouncementKeydown(event, albumAnnouncement, true)}
							>
								<div class="album-message-main">
									<div class="album-message-head">
										<div class="album-message-copy">
											<div class="album-message-kicker">Shared album</div>
											<div class="album-message-title">{albumAnnouncement.name}</div>
										</div>
										<span class="album-message-count">{getAlbumAnnouncementStatusLabel(albumAnnouncement, message.files.length)}</span>
									</div>
									{#if albumPreviewFiles.length > 0}
										<div class="album-message-grid">
											{#each albumPreviewFiles as fileAttachment}
												<button
													type="button"
													class="album-message-tile"
													on:click|stopPropagation={() => openAlbumAnnouncementPreview(message, fileAttachment)}
													title={fileAttachment.fileName}
												>
													{#if isVideo(fileAttachment.fileName)}
														<video muted playsinline preload="metadata">
															<source src={getFileUrl(fileAttachment.fileUrl)} />
														</video>
													{:else}
														<img
															src={getFileUrl(fileAttachment.fileUrl)}
															alt={fileAttachment.fileName}
															loading="lazy"
															decoding="async"
														/>
													{/if}
												</button>
											{/each}
										</div>
									{:else}
										<div class="album-message-empty">
											{getAlbumAnnouncementSupportText(albumAnnouncement, message.files.length)}
										</div>
									{/if}
									{#if getRecentAlbumAnnouncementUploadCount(albumAnnouncement.name) > 0}
										<div class="album-message-note">
											Added {getRecentAlbumAnnouncementUploadCount(albumAnnouncement.name)} file{getRecentAlbumAnnouncementUploadCount(albumAnnouncement.name) === 1 ? '' : 's'} from this device recently.
										</div>
									{/if}
								</div>
								<div class="album-message-actions">
									<button
										type="button"
										class="album-message-btn"
										disabled={albumAnnouncementUploadName === albumAnnouncement.name}
										on:click|stopPropagation={() => triggerAlbumAnnouncementUpload(albumAnnouncement)}
									>
										{albumAnnouncementUploadName === albumAnnouncement.name ? 'Uploading...' : 'Add Media'}
									</button>
									<button type="button" class="album-message-btn primary" on:click|stopPropagation={openAlbumPanel}>
										Open Album
									</button>
									{#if albumPreviewFiles.length > 0}
										<button
											type="button"
											class="album-message-btn"
											on:click|stopPropagation={() => openAlbumAnnouncementPreview(message, albumPreviewFiles[0])}
										>
											Preview
										</button>
									{/if}
								</div>
							</div>
						{:else if message.files && message.files.length > 1}
							<!-- Multiple files gallery -->
							<div class="files-gallery" class:has-more={message.files.length > 4}>
								{#each message.files.slice(0, 4) as fileAttachment, index}
									{#if isImage(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
										<!-- svelte-ignore a11y-click-events-have-key-events -->
										<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
										<div class="gallery-file-item" class:last-item={index === 3 && message.files.length > 4}>
											<img
												src={getFileUrl(fileAttachment.fileUrl)}
												alt={fileAttachment.fileName}
												class="gallery-file-image {message.isSpoiler ? 'spoiler' : ''}"
												data-spoiler={message.isSpoiler ? 'true' : 'false'}
												on:click={(e) => {
													if (e.button === 0) {
														const imageGallery = message.files
															.filter(f => isImage(f.fileName))
															.map(f => getFileUrl(f.fileUrl));
														enlargeImage(getFileUrl(fileAttachment.fileUrl), imageGallery);
													}
												}}
												title={$_('messages.media.click_enlarge')}
											/>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else if isVideo(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
										<!-- svelte-ignore a11y-media-has-caption -->
										<!-- svelte-ignore a11y-click-events-have-key-events -->
										<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
										<div class="gallery-file-item" class:last-item={index === 3 && message.files.length > 4}>
											<video
												class="gallery-file-video {message.isSpoiler ? 'spoiler' : ''}"
												data-spoiler={message.isSpoiler ? 'true' : 'false'}
												on:click={(e) => e.button === 0 && enlargeVideo(getFileUrl(fileAttachment.fileUrl))}
												title={$_('messages.media.click_enlarge')}
											>
												<source src={getFileUrl(fileAttachment.fileUrl)} />
											</video>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else if isAudio(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
										<!-- svelte-ignore a11y-media-has-caption -->
										<div class="gallery-file-item audio-item" class:last-item={index === 3 && message.files.length > 4}>
											<audio
												controls
												class="gallery-file-audio"
											>
												<source src={getFileUrl(fileAttachment.fileUrl)} type="audio/{fileAttachment.fileName?.split('.').pop()}" />
												{$_('messages.media.audio_not_supported')}
											</audio>
											<div class="audio-file-name">{fileAttachment.fileName}</div>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else if isModelFile(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
										<div class="gallery-file-item model-item" class:last-item={index === 3 && message.files.length > 4}>
											<ModelViewer3D src={getFileUrl(fileAttachment.fileUrl)} fileName={fileAttachment.fileName || $_('messages.media.model_fallback_name')} height={220} />
											<button
												class="open-viewport-btn"
												on:click={() => openModelInDedicatedTab(getFileUrl(fileAttachment.fileUrl), fileAttachment.fileName || $_('messages.media.model_fallback_name'))}
											>
												{$_('messages.media.open_3d_tab')}
											</button>
											<a href={getFileUrl(fileAttachment.fileUrl)} target="_blank" rel="noopener noreferrer" download={fileAttachment.fileName} class="image-download-link">
												<span class="file-icon">{getFileIcon(fileAttachment.fileName)}</span>
												{fileAttachment.fileName}
												<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
											</a>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else if isBlendFile(fileAttachment.fileName)}
										<div class="gallery-file-item blend-item" class:last-item={index === 3 && message.files.length > 4}>
											<div class="gallery-file-icon-large">{getFileIcon(fileAttachment.fileName)}</div>
											<div class="gallery-file-overlay">
												<span class="file-name-truncate">{fileAttachment.fileName}</span>
												<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
											</div>
											<div class="blend-actions">
												<button class="blend-import-btn" on:click={() => openBlendImportSettings(fileAttachment.fileUrl, fileAttachment.fileName)}>
													{$_('messages.blend.import_settings')}
												</button>
											</div>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else}
										<a
											href={getFileUrl(fileAttachment.fileUrl)}
											target="_blank"
											rel="noopener noreferrer"
											download={fileAttachment.fileName}
											class="gallery-file-item file-link"
											on:click|preventDefault={() => downloadAttachment(fileAttachment.fileUrl, fileAttachment.fileName, fileAttachment.attachmentEncryption)}
										>
											<div class="gallery-file-icon-large">{getFileIcon(fileAttachment.fileName)}</div>
											<div class="gallery-file-overlay">
												<span class="file-name-truncate">{fileAttachment.fileName}</span>
												<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
												{#if isEncryptedAttachment(fileAttachment)}
													<span class="file-size-small">(encrypted)</span>
												{/if}
											</div>
										</a>
									{/if}
								{/each}
							</div>
							{@const zipFiles = message.files.filter((fileAttachment) => isZipFile(fileAttachment.fileName))}
							{#if zipFiles.length > 0}
								<div class="multi-zip-previews">
									{#each zipFiles as zipFile}
										<ZipPreviewPanel
											fileUrl={getFileUrl(zipFile.fileUrl)}
											fileName={zipFile.fileName || 'archive.zip'}
											fileSize={zipFile.fileSize}
											encrypted={isEncryptedAttachment(zipFile)}
										/>
									{/each}
								</div>
							{/if}
						{:else if message.fileUrl}
							{#if isModelFile(message.fileName) && !isEncryptedAttachment(message)}
							<div class="model-container">
								<ModelViewer3D src={getFileUrl(message.fileUrl)} fileName={message.fileName || $_('messages.media.model_fallback_name')} />
								<button
									class="open-viewport-btn"
									on:click={() => message.fileUrl && openModelInDedicatedTab(getFileUrl(message.fileUrl), message.fileName || $_('messages.media.model_fallback_name'))}
								>
									{$_('messages.media.open_3d_tab')}
								</button>
								<a href={getFileUrl(message.fileUrl)} target="_blank" rel="noopener noreferrer" download={message.fileName} class="image-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
							{:else if isImage(message.fileName) && !isEncryptedAttachment(message)}
							<!-- Display image inline -->
							<div class="image-container">
								<!-- svelte-ignore a11y-click-events-have-key-events -->
								<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
								<img
									src={getFileUrl(message.fileUrl)}
									alt={message.fileName}
									class="inline-image {message.isSpoiler ? 'spoiler' : ''}"
									data-spoiler={message.isSpoiler ? 'true' : 'false'}
									on:click={(e) => e.button === 0 && message.fileUrl && enlargeImage(getFileUrl(message.fileUrl))}
									on:contextmenu={(e) => handleImageContextMenu(e, message)}
									title={$_('messages.media.click_enlarge_with_options')}
								/>
								<a href={getFileUrl(message.fileUrl)} target="_blank" rel="noopener noreferrer" download={message.fileName} class="image-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
						{:else if isVideo(message.fileName) && !isEncryptedAttachment(message)}
							<!-- Display video with player -->
							<div class="video-container">
								<!-- svelte-ignore a11y-media-has-caption -->
								<!-- svelte-ignore a11y-click-events-have-key-events -->
								<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
								<video
									controls
									class="inline-video {message.isSpoiler ? 'spoiler' : ''}"
									data-spoiler={message.isSpoiler ? 'true' : 'false'}
									on:click={(e) => {
										if (e.button === 0 && message.fileUrl) {
											enlargeVideo(getFileUrl(message.fileUrl));
										}
									}}
									on:contextmenu={(e) => handleImageContextMenu(e, message)}
									title={$_('messages.media.click_enlarge_with_options')}
								>
									<source src={getFileUrl(message.fileUrl)} type="video/{message.fileName?.split('.').pop()}" />
									{$_('messages.viewer.video_not_supported')}
								</video>
								<a href={getFileUrl(message.fileUrl)} target="_blank" rel="noopener noreferrer" download={message.fileName} class="video-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
						{:else if isAudio(message.fileName) && !isEncryptedAttachment(message)}
							<!-- Display audio with player -->
							<div class="audio-container">
								<!-- svelte-ignore a11y-media-has-caption -->
								<audio
									controls
									class="inline-audio"
								>
									<source src={getFileUrl(message.fileUrl)} type="audio/{message.fileName?.split('.').pop()}" />
									{$_('messages.media.audio_not_supported')}
								</audio>
								<div class="audio-file-info">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</div>
							</div>
						{:else if isBlendFile(message.fileName) && !isEncryptedAttachment(message)}
							<div class="blend-file-card">
								<div class="blend-file-head">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									<div class="file-info">
										<span class="file-name">{message.fileName}</span>
										<span class="file-size">{formatFileSize(message.fileSize)}</span>
									</div>
								</div>
								<div class="blend-file-actions">
									<button class="blend-import-btn" on:click={() => message.fileUrl && message.fileName && openBlendImportSettings(message.fileUrl, message.fileName)}>
										{$_('messages.blend.import_settings')}
									</button>
									<button class="blend-download-btn" on:click={() => message.fileUrl && message.fileName && downloadAttachment(message.fileUrl, message.fileName, message.attachmentEncryption)}>
										{$_('messages.blend.download')}
									</button>
								</div>
							</div>
						{:else}
							<!-- Display other files as download link -->
							<a
								href={getFileUrl(message.fileUrl)}
								target="_blank"
								rel="noopener noreferrer"
								download={message.fileName}
								class="file-attachment"
								on:click|preventDefault={() => message.fileUrl && message.fileName && downloadAttachment(message.fileUrl, message.fileName, message.attachmentEncryption)}
							>
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								<div class="file-info">
									<span class="file-name">{message.fileName}</span>
									<span class="file-size">{formatFileSize(message.fileSize)}{message.attachmentEncryption ? ` (${$_('messages.encrypted')})` : ''}</span>
								</div>
							</a>
							{#if isZipFile(message.fileName)}
								<ZipPreviewPanel
									fileUrl={getFileUrl(message.fileUrl)}
									fileName={message.fileName || 'archive.zip'}
									fileSize={message.fileSize}
									encrypted={isEncryptedAttachment(message)}
								/>
							{/if}
						{/if}
						{/if}
						{#if !albumAnnouncement && messageText && (message.files ? messageText !== `Shared ${message.files.length} files` : messageText !== `Shared: ${message.fileName}`)}
							<!-- svelte-ignore a11y-click-events-have-key-events -->
							<div class="markdown-content" on:click={handleMarkdownContentClick}>
								{@html parseMessage(messageText, message.entities || [])}
							</div>
						{/if}
					{:else}
						<!-- svelte-ignore a11y-click-events-have-key-events -->
						<div class="markdown-content" on:click={handleMarkdownContentClick}>
							{@html parseMessage(messageText, message.entities || [])}
						</div>
					{/if}
					{#if translatedText}
						<div class="translated-content" class:loading={translationLoading}>
							<span class="translated-label">{$_('messages.translated_label')}</span>
							<div class="translated-text">{translatedText}</div>
						</div>
					{/if}

					<!-- TEMPORARY: Media URLs and Link Previews -->
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
								{#if isYouTubeQueueChannel($currentChannel) && urlIndex === 0}
									<div class="youtube-queue-section">
										<YouTubeWatchEmbed url={url} channelId={$currentChannel} />
									</div>
								{/if}
							{:else if $displayEnhancementSettingsStore.spotifyControlsEnabled && isSpotifyUrl(url)}
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
								<audio
									controls
									class="embedded-media embedded-audio"
								>
									<source src={url} />
									{$_('messages.media.audio_not_supported')}
								</audio>
							{:else if mediaType === 'model'}
								<div class="embedded-model-container">
									<ModelViewer3D src={url} fileName={url.split('/').pop() || $_('messages.media.model_fallback_name')} height={280} />
									<button
										class="open-viewport-btn"
										on:click={() => openModelInDedicatedTab(url, url.split('/').pop() || $_('messages.media.model_fallback_name'))}
									>
										{$_('messages.media.open_3d_tab')}
									</button>
								</div>
							{:else}
								<!-- Regular link preview for non-media URLs -->
								{#if LinkPreviewComponent}
									<svelte:component this={LinkPreviewComponent} {url} />
								{:else}
									{@const _linkPreviewRequested = (ensureLinkPreviewLoaded(), true)}
									<a href={url} target="_blank" rel="noopener noreferrer" class="plain-link-fallback">{url}</a>
								{/if}
							{/if}
							{/if}
						{/each}
					{/if}
				</div>
			{/if}

			{#if message.reactions && Object.keys(message.reactions).length > 0}
				<div class="reactions">
					{#each Object.entries(message.reactions) as [emojiId, userIds]}
						{@const emoji = getEmojiById(emojiId)}
						{#if emoji && userIds.length > 0}
							{@const userReacted = hasCurrentUserReaction(userIds)}
							<button
								class="reaction-btn"
								class:user-reacted={userReacted}
								on:click={() => toggleReaction(message.id, emojiId)}
								title={getReactionTooltip(userIds)}
							>
								<img src={emoji.url} alt={emoji.name} class="reaction-emoji" loading="lazy" decoding="async" />
								<span class="reaction-count">{userIds.length}</span>
							</button>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>
	{/if}
{/each}

<input
	bind:this={albumAnnouncementUploadInput}
	type="file"
	accept="image/*,video/*,audio/*,.zip,.pdf,.txt,.md"
	multiple
	class="album-announcement-upload-input"
	on:change={handleAlbumAnnouncementUploadChange}
/>

{#if UserPopoutComponent}
	<svelte:component
		this={UserPopoutComponent}
		bind:isOpen={showUserPopout}
		bind:user={popoutUser}
		anchorElement={popoutAnchorElement}
		isOwnProfile={popoutIsOwnProfile}
		on:close={() => showUserPopout = false}
		on:openFullProfile={(event) => {
			if (event.detail?.isOwnProfile) {
				dispatch('openSettings');
			}
		}}
	/>
{/if}

{#if showReactionPicker}
	{#if EmojiPickerComponent}
		<svelte:component
			this={EmojiPickerComponent}
			on:select={handleReactionSelect}
			on:close={closeReactionPicker}
		/>
	{:else}
		<div class="emoji-picker-loading">{$_('emoji_picker.loading')}</div>
	{/if}
{/if}

	{#if contextMenuMessage}
	<MessageContextMenu
		message={contextMenuMessage}
		canManageOwnMessage={isOwnMessage(contextMenuMessage)}
		bind:visible={contextMenuVisible}
		x={contextMenuX}
		y={contextMenuY}
		onEdit={handleEdit}
		onDelete={handleDelete}
		onPin={handlePin}
		onReply={handleReply}
		onQuickMention={handleQuickMention}
		onTogglePersonalPin={handleTogglePersonalPin}
		onDownload={handleDownload}
		onAddToAlbum={handleAddToAlbum}
		onCopyQuote={handleCopyQuote}
		onCopyMessageLink={handleCopyMessageLink}
		onForward={handleForward}
		onAddReaction={handleAddReaction}
		onTranslate={handleTranslate}
		quickMentionEnabled={$displayEnhancementSettingsStore.quickMentionEnabled}
		personalPinsEnabled={$displayEnhancementSettingsStore.personalPinsEnabled}
		isPersonalPinned={isPersonalPinnedMessage(contextMenuMessage.id)}
	/>
{/if}

<ForwardDialog bind:visible={showForwardDialog} bind:message={forwardMessage} />

<ConfirmDialog
	isOpen={showDeleteConfirm}
	title={$_('messages.confirm.delete_title')}
	message={getDeleteConfirmMessage(messageToDelete)}
	confirmText={$_('messages.confirm.delete_confirm')}
	variant="danger"
	onConfirm={confirmDeleteMessage}
	onCancel={() => showDeleteConfirm = false}
/>

{#if BlendImportSettingsModalComponent}
	<svelte:component
		this={BlendImportSettingsModalComponent}
		isOpen={showBlendImportSettings}
		sourcePath={blendImportSourcePath}
		fileName={blendImportFileName}
		isSubmitting={blendImportSubmitting}
		on:close={() => {
			if (!blendImportSubmitting) showBlendImportSettings = false;
		}}
		on:submit={queueBlendImport}
	/>
{/if}

{#if enlargedImage}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="image-modal"
		role="button"
		tabindex="0"
		on:click={closeEnlargedImage}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeEnlargedImage();
			}
		}}
	>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<img
			src={enlargedImage}
			alt={$_('messages.viewer.enlarged_alt')}
			class="enlarged-image"
			on:click|stopPropagation
			on:load={onEnlargedImageLoad}
			style={`transform: scale(${imageZoom});`}
		/>

		<!-- Navigation arrows (only show if multiple images) -->
		{#if currentImageGallery.length > 1}
			<button class="nav-arrow nav-prev" on:click|stopPropagation={() => navigateImage('prev')} title={$_('messages.viewer.previous')}>
				&lt;
			</button>
			<button class="nav-arrow nav-next" on:click|stopPropagation={() => navigateImage('next')} title={$_('messages.viewer.next')}>
				&gt;
			</button>
			<div class="image-counter">
				{currentImageIndex + 1} / {currentImageGallery.length}
			</div>
		{/if}

		<div class="lightbox-toolbar-wrap" on:click|stopPropagation>
			<div class="lightbox-toolbar">
				<a
					href={enlargedImage}
					target="_blank"
					rel="noopener noreferrer"
					class="toolbar-btn"
					title={$_('messages.viewer.open_new_tab')}
					aria-label={$_('messages.viewer.open_new_tab')}
				>
					<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M14 3h7v7" />
						<path d="M10 14 21 3" />
						<path d="M21 14v7h-7" />
						<path d="M3 10V3h7" />
						<path d="M3 21h7v-7" />
					</svg>
				</a>
				<button class="toolbar-btn" on:click={forwardCurrentImage} title={$_('messages.viewer.forward_share')} aria-label={$_('messages.viewer.forward_share')}>
					<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M5 12h14" />
						<path d="m13 5 7 7-7 7" />
					</svg>
				</button>
				<button class="toolbar-btn" on:click={zoomOut} title={$_('messages.viewer.zoom_out')} aria-label={$_('messages.viewer.zoom_out')}>
					-
				</button>
				<button class="toolbar-btn zoom-level" on:click={resetZoom} title={$_('messages.viewer.reset_zoom')} aria-label={$_('messages.viewer.reset_zoom')}>
					{Math.round(imageZoom * 100)}%
				</button>
				<button class="toolbar-btn" on:click={zoomIn} title={$_('messages.viewer.zoom_in')} aria-label={$_('messages.viewer.zoom_in')}>
					+
				</button>
				<div class="toolbar-more-wrap">
					<button class="toolbar-btn" on:click={toggleImageMenu} title={$_('messages.viewer.more')} aria-label={$_('messages.viewer.more_actions')}>
						...
					</button>
					{#if imageMenuOpen}
						<div class="toolbar-menu" role="menu">
							<button class="toolbar-menu-item" on:click={copyCurrentImageLink}>{$_('messages.viewer.copy_image_link')}</button>
							<button class="toolbar-menu-item" on:click={copyCurrentImage}>{$_('messages.viewer.copy_image')}</button>
							<button class="toolbar-menu-item" on:click={openReverseImageSearch}>{$_('messages.viewer.reverse_search')}</button>
							<div class="toolbar-menu-item details-hover-row">
								{$_('messages.viewer.image_details')}
								<div class="image-details-popout" role="note">
									<div><strong>{$_('messages.viewer.details_name')}:</strong> {imageMeta.name}</div>
									<div><strong>{$_('messages.viewer.details_dimensions')}:</strong> {imageMeta.width ?? '?'} x {imageMeta.height ?? '?'}</div>
									<div><strong>{$_('messages.viewer.details_size')}:</strong> {formatBytes(imageMeta.sizeBytes)}</div>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
			<button class="close-modal" on:click={closeEnlargedImage} aria-label={$_('messages.viewer.close')}>X</button>
		</div>
	</div>
{/if}

{#if enlargedVideo}
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
			<source src={enlargedVideo} />
			{$_('messages.viewer.video_not_supported')}
		</video>
		<button class="close-modal" on:click={closeEnlargedVideo}>X</button>
		<a href={enlargedVideo} target="_blank" rel="noopener noreferrer" class="open-new-tab">
			{$_('messages.viewer.open_new_tab')}
		</a>
	</div>
{/if}

