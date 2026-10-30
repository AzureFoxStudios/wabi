<script lang="ts">
	import { profileDecorationsVisible } from '$lib/profileAppearance';
	import ProfileDecoration from '$lib/components/ProfileDecoration.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import { safeNameStyle, nameStylesVisible } from '$lib/addons/nameStyles';
	import type { Message, User, Emoji, FileAttachment, Channel } from '$lib/socket';
	import { _, currentLocale } from '$lib/i18n';
	import type { ChatFilterResult } from '$lib/chatEnhancements';
	import type { AnimationPassPreset } from '$lib/animationPass';
	import { formatTimestampForDisplay, isRenderableMessage } from '$lib/displayEnhancements';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { longpress } from '$lib/actions/longpress';
	import MessageItemActions from './message/MessageItemActions.svelte';
	import MessageReplyPreview from './message/MessageReplyPreview.svelte';
	import MessageReactions from './message/MessageReactions.svelte';
	import { messageItemTransition } from './message/messageItemAnimation';
	import MessageHeader from './message/MessageHeader.svelte';
	import MessageEditForm from './message/MessageEditForm.svelte';
	import MessagePersistenceRow from './message/MessagePersistenceRow.svelte';
	import MessageDeliveryRow from './message/MessageDeliveryRow.svelte';
	import MessageContent from './message/MessageContent.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';
	import Icon from '$lib/components/ui/Icon.svelte';

	export let message: Message;
	export let messageDomId = '';
	export let author: User | undefined;
	export let displayUsername: string;
	export let replyToMsg: Message | undefined;
	export let groupedWithPrevious: boolean;
	export let groupedWithNext: boolean;
	export let ownMessage: boolean;
	export let deletionLabel: string | null;
	/** Remaining share of retention life (1 -> 0); null when the room does not expire messages. */
	export let retentionLife: number | null = null;
	export let translatedText: string | undefined;
	export let translationLoading: boolean;
	export let filteredMessage: ChatFilterResult;
	export let shouldAnimateMessage: boolean;
	export let quickReactionEmojis: Emoji[];
	export let isPersonalPinned: boolean;
	export let messageAnimation: { enabled: boolean; preset: AnimationPassPreset; duration: number; distance: number };
	export let gifCaptionStyleClass: string;
	export let currentChannel: string;
	export let themeStore: any;
	export let displayEnhancementSettingsStore: any;
	export let roleDefinitions: any[];
	export let channels: Channel[];
	export let currentUser: User | undefined;
	export let users: User[];
	export let emojis: Emoji[];
	export let editingMessageId: string | null;
	export let editText: string;
	export let mobileActionsMessageId: string | null;
	export let albumAnnouncementUploadName: string | null;
	export let highlightedMessageId: string | null;
	export let messageText: string;
	export let deletionModeEnabled = false;
	export let canDeleteInDeletionMode = false;
	export let deletionModeDeleting = false;

	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
	export let onForward: (message: Message) => void = () => {};

	export let onContextMenu: (event: MouseEvent, message: Message) => void;
	export let onLongPress: (event: TouchEvent, message: Message) => void;
	export let onOpenReactionPicker: (event: MouseEvent, messageId: string) => void;
	export let onQuickReact: (messageId: string, emojiId: string) => void;
	export let onToggleReaction: (messageId: string, emojiId: string) => void;
	export let onJumpToMessage: (messageId: string) => void;
	export let onSaveEdit: (messageId: string, text: string) => void;
	export let onCancelEdit: () => void;
	export let onEnlargeImage: (url: string, gallery?: string[]) => void;
	export let onEnlargeVideo: (url: string) => void;
	export let onImageContextMenu: (event: MouseEvent, message: Message) => void;
	export let onDownloadAttachment: (fileUrl: string, fileName: string, encryption?: any) => void;
	export let onOpenBlendImportSettings: (sourcePath: string, fileName: string) => void;
	export let onOpenModelInDedicatedTab: (src: string, fileName: string) => void;
	export let onOpenMapPanel: (placeId: string, options: any) => void;
	export let onOpenFullMapTab: (placeId: string, options: any) => void;
	export let onOpenPreferredMapSurface: (placeId: string, options: any) => void;
	export let onOpenDirectionsExternal: (url?: string) => void;
	export let onTriggerAlbumUpload: (meta: any) => void;
	export let onHandleAlbumActivate: (meta: any, hasFiles: boolean) => void;
	export let onOpenAlbumPanel: () => void;
	export let onOpenAlbumPreview: (message: Message, fileAttachment: FileAttachment) => void;
	export let onHandleUtilityPinToggle: (message: Message) => void;
	export let onHandleUtilityEdit: (message: Message) => void;
	export let onHandleMarkdownContentClick: (event: MouseEvent) => void;
	export let onDeletionModeDelete: (message: Message) => void | Promise<void> = () => {};
	export let onHandleUsernameClick: (event: MouseEvent, message: Message, resolvedUser?: User) => void;
	export let onHandleUsernameContextMenu: (event: MouseEvent, message: Message, resolvedUser?: User) => void = () => {};
	export let onHandleAlbumAnnouncementKeydown: (event: KeyboardEvent, meta: any, hasFiles: boolean) => void;

	export let LinkPreviewComponent: any;
	export let ensureLinkPreviewLoaded: () => void;

	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};


	$: roleLabelMap = (() => {
		const labels: Record<string, string> = { ...fallbackRoleLabels };
		for (const role of roleDefinitions) {
			labels[role.roleName] = role.displayName;
		}
		return labels;
	})();

	function formatTime(timestamp: number): string {
		return formatTimestampForDisplay(timestamp, displayEnhancementSettingsStore.timestampDisplayMode);
	}

	function formatTimeTooltip(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	/** The time gutter shows the clock only, in the reader's locale (the day rule carries the date). */
	function formatGutterTime(timestamp: number, locale: string | null | undefined): string {
		const date = new Date(timestamp);
		if (!Number.isFinite(date.getTime())) return '';
		try {
			return date.toLocaleTimeString(locale || undefined, { hour: 'numeric', minute: '2-digit' });
		} catch {
			return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		}
	}

	function getUserColor(user: User | undefined, username: string): string {
		return resolveUserDisplayColor(user?.roleColor, user?.color);
	}

	// The name's color is ProfileName's identity ink (--ink); the wrapper only carries the font
	// settings, so nothing else in it inherits the raw chosen color.
	function getUsernameStyle(user: User | undefined, username: string, themeState: any): string {
		let style = '';
		const resolvedUser = user;

		if (themeState.uniformFontEnabled) {
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
			if (resolvedUser?.usernameFont) {
				style += safeNameStyle(resolvedUser.usernameFont, $nameStylesVisible);
			}
		}

		return style;
	}

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
		if (!user || !displayEnhancementSettingsStore.topRoleEverywhereEnabled) return null;
		const roleName = getUserTopRoleName(user);
		return roleLabelMap[roleName] || roleName;
	}

	function getTopRoleBadgeTone(user: User | undefined): 'owner' | 'admin' | 'mod' | 'default' {
		return getRoleBadgeTone(getUserTopRoleName(user));
	}

	function shouldShowStaffTag(user: User | undefined): boolean {
		if (!user || !displayEnhancementSettingsStore.staffTagEnabled) return false;
		const roleName = getUserTopRoleName(user);
		return roleName === 'owner' || roleName === 'admin' || roleName === 'mod';
	}

</script>

{#if !filteredMessage.hidden && isRenderableMessage(message)}
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		id={messageDomId || `message-${message.id}`}
		data-message-id={message.id}
		class="message {message.isPinned ? 'pinned' : ''} {isPersonalPinned ? 'personal-pinned' : ''} {highlightedMessageId === message.id ? 'highlighted' : ''} {groupedWithPrevious ? 'continuation' : ''} {groupedWithNext ? 'has-continuation' : ''} {ownMessage ? 'own-message' : ''} {deletionModeEnabled ? 'deletion-mode-active' : ''} {message.deliveryState === 'sending' ? 'is-sending' : ''} {message.deliveryState === 'failed' ? 'is-send-failed' : ''}"
		title={ownMessage && message.deliveryState === 'failed' ? (message.deliveryError || 'Delivery not confirmed. Check this conversation before sending again.') : undefined}
		on:contextmenu={(e) => onContextMenu(e, message)}
		use:longpress={{ onLongPress: (e) => onLongPress(e, message) }}
		transition:messageItemTransition={{
			...messageAnimation,
			animate: shouldAnimateMessage
		}}
	>
		{#if deletionModeEnabled && canDeleteInDeletionMode}
			<button
				type="button"
				class="deletion-mode-delete-btn w-btn w-btn--danger w-btn--sm"
				disabled={deletionModeDeleting}
				title="Delete this message"
				aria-label="Delete this message"
				on:click|preventDefault|stopPropagation={() => onDeletionModeDelete(message)}
			>
				<Icon name="trash" size={14} />
				<span>{deletionModeDeleting ? 'Deleting…' : 'Delete'}</span>
			</button>
		{/if}
		<MessageItemActions
			{message}
			{ownMessage}
			{quickReactionEmojis}
			{mobileActionsMessageId}
			{displayEnhancementSettingsStore}
			{onReply}
			{onQuickMention}
			{onForward}
			{onContextMenu}
			{onOpenReactionPicker}
			{onQuickReact}
			{onHandleUtilityPinToggle}
			{onHandleUtilityEdit}
		/>

	<!-- Time gutter + retention wick (laid out by styles/stream.css; the phone row shows the time in the header) -->
	<time class="msg-time" datetime={new Date(message.timestamp).toISOString()} title={formatTimeTooltip(message.timestamp)}>{formatGutterTime(message.timestamp, $currentLocale)}</time>
	{#if retentionLife !== null}
		<span class="msg-wick" class:soon={retentionLife < 0.15} style="--life: {retentionLife.toFixed(3)}" aria-hidden="true"></span>
	{/if}
	{#if message.isPinned || isPersonalPinned}
		<span class="msg-pin" title={message.isPinned ? $_('messages.pinned_title') : $_('messages.pinned_on_device')}>
			<Icon name="pin" size={12} label={message.isPinned ? $_('messages.pinned_title') : $_('messages.pinned_on_device')} />
		</span>
	{/if}

	<!-- Avatar stamp: identity disc + initial; a profile picture replaces it -->
	{#if groupedWithPrevious}
		<div class="message-avatar message-avatar-spacer" aria-hidden="true"></div>
	{:else}
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div
				class="message-avatar"
				role="button"
				tabindex="0"
				aria-label={displayUsername}
				on:click={(e) => onHandleUsernameClick(e, message, author)}
				on:contextmenu={(e) => onHandleUsernameContextMenu(e, message, author)}
				on:keydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onHandleUsernameClick(e as unknown as MouseEvent, message, author);
					}
				}}
			>
				{#if author?.profilePicture}
					<ProfileMedia src={mediaUrl(author.profilePicture)} alt={displayUsername} class="avatar" />
				{:else}
					<div class="avatar-placeholder" style={$inkFor(getUserColor(author, displayUsername))} aria-hidden="true">
						{Array.from(displayUsername.trim())[0]?.toUpperCase() ?? '?'}
					</div>
				{/if}
				{#if author?.overlayUrl && $profileDecorationsVisible}
					<ProfileDecoration user={author} class="avatar-overlay-badge" />
				{/if}
			</div>
	{/if}
	<!-- Message Content -->
	<div class="message-body">
		<MessageHeader
			{author}
			{displayUsername}
			{message}
			{deletionLabel}
			{isPersonalPinned}
			{groupedWithPrevious}
			{displayEnhancementSettingsStore}
			{themeStore}
			onUsernameClick={onHandleUsernameClick}
			onUsernameContextMenu={onHandleUsernameContextMenu}
			{getUserColor}
			{getUsernameStyle}
			{getTopRoleBadgeLabel}
			{getTopRoleBadgeTone}
			{shouldShowStaffTag}
			{formatTime}
			{formatTimeTooltip}
		/>
		<!-- Reply Preview -->
		{#if replyToMsg}
			<MessageReplyPreview {replyToMsg} {onJumpToMessage} />
		{/if}

		<!-- Message Content or Edit Mode -->
		{#if editingMessageId === message.id}
			<MessageEditForm
				{editText}
				onSave={(text) => onSaveEdit(message.id, text)}
				onCancel={onCancelEdit}
			/>
		{:else}
			<MessageContent
				{message}
				{messageText}
				{albumAnnouncementUploadName}
				{translatedText}
				{translationLoading}
				{gifCaptionStyleClass}
				{displayEnhancementSettingsStore}
				{currentChannel}
				{channels}
				{onOpenMapPanel}
				{onOpenFullMapTab}
				{onOpenPreferredMapSurface}
				{onOpenDirectionsExternal}
				{onHandleAlbumActivate}
				{onTriggerAlbumUpload}
				{onOpenAlbumPanel}
				{onOpenAlbumPreview}
				{onEnlargeImage}
				{onEnlargeVideo}
				{onImageContextMenu}
				{onDownloadAttachment}
				{onOpenBlendImportSettings}
				{onOpenModelInDedicatedTab}
					{onHandleMarkdownContentClick}
					{LinkPreviewComponent}
					{ensureLinkPreviewLoaded}
					{onHandleAlbumAnnouncementKeydown}
				/>
			{#if message.isEdited}
				<span class="edited-mark" title={$_('messages.edited_title')}>({$_('messages.edited')})</span>
			{/if}
		{/if}

		<MessageDeliveryRow
			{ownMessage}
			deliveryState={message.deliveryState}
			deliveryError={message.deliveryError}
		/>
		{#if ownMessage && !message.deliveryState && message.persistenceState}
			<MessagePersistenceRow
				persistenceState={message.persistenceState}
				persistenceError={message.persistenceError}
			/>
		{/if}
		<MessageReactions {message} {currentUser} {users} {emojis} {onToggleReaction} />
	</div>
</div>
{/if}

<style>
	/* Row layout, states and the stamp live in styles/stream.css; this block holds only the
	   deletion-mode affordance, which exists only on this component. */
	:global(.messages-pane .message.deletion-mode-active) {
		cursor: crosshair;
	}

	:global(.messages-pane .message.deletion-mode-active:hover::before) {
		background: color-mix(in srgb, var(--w-danger) 8%, transparent);
		box-shadow: inset 0 0 0 var(--w-bw) color-mix(in srgb, var(--w-danger) 35%, transparent);
	}

	/* Kit danger button (w-btn--danger), parked on the row's right edge until the row is hovered. */
	.deletion-mode-delete-btn {
		position: absolute;
		right: 0;
		top: 50%;
		z-index: 4;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		transition:
			opacity var(--w-dur-1) var(--w-ease),
			background-color var(--w-dur-1) var(--w-ease),
			color var(--w-dur-1) var(--w-ease);
	}

	/* an opaque face over the text it sits on; the kit's hover fill takes over */
	.deletion-mode-delete-btn:not(:hover) {
		background: var(--w-bg);
	}

	:global(.message.deletion-mode-active:hover) .deletion-mode-delete-btn,
	.deletion-mode-delete-btn:focus-visible {
		opacity: 1;
		pointer-events: auto;
	}

	.deletion-mode-delete-btn:disabled {
		opacity: 0.8;
		cursor: progress;
	}
</style>
