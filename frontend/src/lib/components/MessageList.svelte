<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher } from 'svelte';
	import { get } from 'svelte/store';
	import { browser } from '$app/environment';
	import type { Message, User, Emoji, Channel, FileAttachment } from '$lib/socket';
	import { users, currentUser, currentChannel, editMessage, deleteMessage, togglePinMessage, addReaction, removeReaction, emojis, channels, loadOlderMessages, channelAvailableArchives, channelLoadedArchives, channelLoadingOlder, loadOlderHistory, channelHistoryLoading, channelHasMoreHistory, roleDefinitions, retryMessagePersistence } from '$lib/socket';
	import { themeStore } from '$lib/theme/themeStore';
	import MessageItem from './MessageItem.svelte';
	import MessageListOverlays from './message/MessageListOverlays.svelte';
	import {
		countMessageAttachments,
		getMessageAttachmentActionItems,
		selectAttachmentActionItems,
		type MessageAttachmentActionItem
	} from './message/messageAttachmentActions';
	import {
		extractUrls,
		getFileIcon,
		getMediaType,
		isAudio,
		isBlendFile,
		isImage,
		isMediaUrl,
		isModelFile,
		isVideo,
		isYouTubeUrl,
		isZipFile
	} from './message/messageMediaUtils';
	import {
		getTranslatorSettings,
		requestTranslation,
		type TranslatorSettings
	} from './message/messageTranslator';
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
		import { MODEL_VIEWPORT_ADDON_ID, openModelViewport } from '$lib/modelViewportTab';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { layoutStore } from '$lib/layoutStore';
	import { _ } from '$lib/i18n';
	import { addMediaAlbumItem, createMediaAlbum, listMediaAlbums, type MediaAlbumScopeType } from '$lib/api';
	import { messageRetentionToMs, DEFAULT_CHANNEL_RETENTION } from '../../../../shared/messageRetention.js';
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
	import { navigateToRef, type NavRef } from '$lib/navigateToRef';
	import { openFullMapTab, openMapPanel, openPreferredMapSurface } from '$lib/mapWorkspace';
	import { openMediaAlbumsSurface } from '$lib/mediaAlbumsWorkspace';
	export let messages: Message[];
	export let onReply: (message: Message) => void = () => {};
	export let onQuickMention: (message: Message) => void = () => {};
	export let firstUnreadMessageId: string | null = null;
	const dispatch = createEventDispatcher();
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
	// Emoji reaction picker (wired via openReactionPicker / addReaction)
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
		const t = Number(timestamp);
		if (!Number.isFinite(t) || Number.isNaN(new Date(t).getTime())) return '—';
		return formatTimestampForDisplay(
			t,
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
		// null = keep forever (opt-in); unset/undefined = default 24h ephemeral
		const d = channel?.autoDeleteAfter;
		if (d === null) return null;
		return messageRetentionToMs(d ?? DEFAULT_CHANNEL_RETENTION);
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
		const refTokenEl = target.closest('[data-ref-kind]');
		if (refTokenEl instanceof HTMLElement) {
			const refKind = refTokenEl.dataset.refKind;
			const refId = refTokenEl.dataset.refId;
			if (refKind && refId) {
				let navRef: NavRef;
				switch (refKind) {
					case 'user':
						navRef = { kind: 'user', userId: refId };
						break;
					case 'channel':
						navRef = { kind: 'channel', channelId: refId };
						break;
					case 'forum_post':
						navRef = { kind: 'forum_post', postId: refId };
						break;
					case 'wiki_page':
						navRef = { kind: 'wiki_page', pageId: refId };
						break;
					case 'gallery_work':
						navRef = { kind: 'gallery_work', workId: refId };
						break;
					default:
						return;
				}
				event.preventDefault();
				event.stopPropagation();
				await navigateToRef(navRef);
				return;
			}
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
		event.stopPropagation();
		// Prefer real coords; fallback for keyboard/actions that lack them
		const x = typeof event.clientX === 'number' && event.clientX > 0
			? event.clientX
			: Math.round(window.innerWidth / 2);
		const y = typeof event.clientY === 'number' && event.clientY > 0
			? event.clientY
			: Math.round(window.innerHeight / 3);
		contextMenuMessage = message;
		contextMenuX = x;
		contextMenuY = y;
		// Defer open so the same right-click event cannot instantly close the menu
		// via overlay/window handlers mid-dispatch.
		requestAnimationFrame(() => {
			contextMenuVisible = true;
		});
	}
	function handleEdit() {
		if (!contextMenuMessage) return;
		editingMessageId = contextMenuMessage.id;
		editText = contextMenuMessage.text;
		contextMenuVisible = false;
	}
	function saveEdit(messageId: string, text?: string) {
		const next = (text ?? editText).trim();
		if (next) {
			editMessage($currentChannel, messageId, next);
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

	function getDeleteConfirmMessage(message: Message | null): string {
		const attachmentCount = countMessageAttachments(message);
		if (attachmentCount > 0) {
			return get(_)('messages.confirm.delete_message_with_uploads', { values: { count: attachmentCount } });
		}
		return get(_)('messages.confirm.delete_message');
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
		openMediaAlbumsSurface();
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
		handleContextMenu(event, message);
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
		if (!otherDbUserId || !authToken || !false) {
			alert(get(_)('messages.errors.cannot_decrypt_session'));
			return;
		}

		const encryptedBuffer = await response.arrayBuffer();
		const decrypted = await null;
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
	function isYouTubeQueueChannel(channelId: string): boolean {
		const channel = $channels.find((ch) => ch.id === channelId);
		return Boolean(channel?.watchQueueEnabled);
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

	function enlargeImage(imageUrl: string, gallery: string[] = []) {
		enlargedImage = imageUrl;
		currentImageGallery = gallery.length > 0 ? gallery : [imageUrl];
	}
	function closeEnlargedImage() {
		enlargedImage = null;
		currentImageGallery = [];
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

<!-- Window-level keyboard listener for image navigation handled by ImageLightbox -->
<svelte:window
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

{#each visibleMessages as message, localIndex (message.id ?? message.clientNonce ?? `__missing_${localIndex}`)}
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

		<MessageItem
			{message}
			{author}
			{displayUsername}
			replyToMsg={replyToMsg}
			{groupedWithPrevious}
			{groupedWithNext}
			{ownMessage}
			{deletionLabel}
			{translatedText}
			{translationLoading}
			{filteredMessage}
			{shouldAnimateMessage}
			{quickReactionEmojis}
			isPersonalPinned={isPersonalPinnedMessage(message.id)}
			{messageAnimation}
			{gifCaptionStyleClass}
			deletionCountdownMode={deletionCountdownMode}
			currentChannel={$currentChannel}
			themeStore={$themeStore}
			displayEnhancementSettingsStore={$displayEnhancementSettingsStore}
			chatFilterStore={$chatFilterStore}
			quickReactionSettingsStore={$quickReactionSettingsStore}
			roleDefinitions={$roleDefinitions}
			channels={$channels}
			currentUser={$currentUser}
			users={$users as any[]}
			emojis={$emojis}
			personalPinnedMessageIdSet={personalPinnedMessageIdSet}
			editingMessageId={editingMessageId}
			editText={editText}
			mobileActionsMessageId={mobileActionsMessageId}
			{nowMs}
			albumAnnouncementUploadName={albumAnnouncementUploadName}
			highlightedMessageId={highlightedMessageId}
			messageText={messageText}
			LinkPreviewComponent={LinkPreviewComponent}
			ensureLinkPreviewLoaded={ensureLinkPreviewLoaded}
			onReply={handleReply}
			onQuickMention={handleQuickMention}
			onContextMenu={handleContextMenu}
			onLongPress={handleMessageLongPress}
			onOpenReactionPicker={openReactionPicker}
			onQuickReact={quickReactToMessage}
			onToggleReaction={toggleReaction}
			onJumpToMessage={jumpToMessage}
			onSaveEdit={saveEdit}
			onCancelEdit={cancelEdit}
			onEnlargeImage={enlargeImage}
			onEnlargeVideo={enlargeVideo}
			onImageContextMenu={handleImageContextMenu}
			onDownloadAttachment={downloadAttachment}
			onOpenBlendImportSettings={openBlendImportSettings}
			onOpenModelInDedicatedTab={openModelInDedicatedTab}
			onOpenMapPanel={openMapPanel}
			onOpenFullMapTab={openFullMapTab}
			onOpenPreferredMapSurface={openPreferredMapSurface}
			onOpenDirectionsExternal={openDirectionsExternal}
			onTriggerAlbumUpload={triggerAlbumAnnouncementUpload}
			onHandleAlbumActivate={handleAlbumAnnouncementActivate}
			onOpenAlbumPanel={openAlbumPanel}
			onOpenAlbumPreview={openAlbumAnnouncementPreview}
			onAlbumUploadChange={handleAlbumAnnouncementUploadChange}
			onTogglePersonalPin={handleTogglePersonalPin}
			onHandleUtilityPinToggle={handleUtilityPinToggle}
			onHandleUtilityEdit={handleUtilityEdit}
			onHandleMarkdownContentClick={handleMarkdownContentClick}
			onToggleSpoiler={toggleSpoiler}
			onCapturedSpoilerClick={handleCapturedSpoilerClick}
			onHandleUsernameClick={handleUsernameClick}
			onHandleAlbumAnnouncementKeydown={handleAlbumAnnouncementKeydown}
		/>
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

<MessageListOverlays
	bind:showUserPopout
	bind:popoutUser
	{popoutAnchorElement}
	bind:popoutIsOwnProfile
	bind:showReactionPicker
	bind:contextMenuVisible
	bind:showForwardDialog
	bind:forwardMessage
	bind:showDeleteConfirm
	bind:showBlendImportSettings
	bind:enlargedImage
	bind:enlargedVideo
	{UserPopoutComponent}
	{EmojiPickerComponent}
	{BlendImportSettingsModalComponent}
	{contextMenuMessage}
	{contextMenuX}
	{contextMenuY}
	{messageToDelete}
	{blendImportSourcePath}
	{blendImportFileName}
	{blendImportSubmitting}
	{currentImageGallery}
	quickMentionEnabled={$displayEnhancementSettingsStore.quickMentionEnabled}
	personalPinsEnabled={$displayEnhancementSettingsStore.personalPinsEnabled}
	{isOwnMessage}
	{isPersonalPinnedMessage}
	{getDeleteConfirmMessage}
	handleOpenFullProfile={(event) => {
		if (event.detail?.isOwnProfile) {
			dispatch('openSettings');
		}
	}}
	{handleReactionSelect}
	{closeReactionPicker}
	{handleEdit}
	{handleDelete}
	{handlePin}
	{handleReply}
	{handleQuickMention}
	{handleTogglePersonalPin}
	{handleDownload}
	{handleAddToAlbum}
	{handleCopyQuote}
	{handleCopyMessageLink}
	{handleForward}
	{handleAddReaction}
	{handleTranslate}
	{confirmDeleteMessage}
	{queueBlendImport}
	{closeEnlargedImage}
	{closeEnlargedVideo}
/>
