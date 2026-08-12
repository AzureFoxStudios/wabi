<script lang="ts">
	import type { Message, User, Emoji, FileAttachment, Channel } from '$lib/socket';
	import { retryMessagePersistence } from '$lib/socket';
	import { _ } from '$lib/i18n';
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
	import MessageContent from './message/MessageContent.svelte';

	export let message: Message;
	export let author: User | undefined;
	export let displayUsername: string;
	export let replyToMsg: Message | undefined;
	export let groupedWithPrevious: boolean;
	export let groupedWithNext: boolean;
	export let ownMessage: boolean;
	export let deletionLabel: string | null;
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

	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
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
	export let onHandleUsernameClick: (event: MouseEvent, message: Message, resolvedUser?: User) => void;
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

	function getUserColor(user: User | undefined, username: string): string {
		return resolveUserDisplayColor(user?.roleColor, user?.color);
	}

	function getUsernameStyle(user: User | undefined, username: string, themeState: any): string {
		let style = `color: ${getUserColor(user, username)};`;
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
		id="message-{message.id}"
		class="message {message.isPinned ? 'pinned' : ''} {isPersonalPinned ? 'personal-pinned' : ''} {highlightedMessageId === message.id ? 'highlighted' : ''} {groupedWithPrevious ? 'continuation' : ''} {groupedWithNext ? 'has-continuation' : ''} {ownMessage ? 'own-message' : ''} {message.deliveryState === 'sending' ? 'is-sending' : ''} {message.deliveryState === 'failed' ? 'is-send-failed' : ''}"
		title={message.deliveryState === 'failed' ? (message.deliveryError || 'Message failed to send') : undefined}
		on:contextmenu={(e) => onContextMenu(e, message)}
		use:longpress={{ onLongPress: (e) => onLongPress(e, message) }}
		transition:messageItemTransition={{
			...messageAnimation,
			animate: shouldAnimateMessage
		}}
	>
		<MessageItemActions
			{message}
			{ownMessage}
			{quickReactionEmojis}
			{mobileActionsMessageId}
			{displayEnhancementSettingsStore}
			{onReply}
			{onQuickMention}
			{onContextMenu}
			{onOpenReactionPicker}
			{onQuickReact}
			{onHandleUtilityPinToggle}
			{onHandleUtilityEdit}
		/>

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
		{#if message.isPinned || isPersonalPinned}
			<div
				class="pin-indicator"
				class:personal={isPersonalPinned && !message.isPinned}
				title={message.isPinned ? $_('messages.pinned_title') : $_('context_menu.pin_local_message')}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				<span>{message.isPinned ? $_('messages.pinned_title') : $_('context_menu.pin_local_message')}</span>
			</div>
		{/if}
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
			{getUserColor}
			{getUsernameStyle}
			{getTopRoleBadgeLabel}
			{getTopRoleBadgeTone}
			{shouldShowStaffTag}
			{formatTime}
			{formatTimeTooltip}
		/>
		{#if ownMessage && message.persistenceState}
			<MessagePersistenceRow
				persistenceState={message.persistenceState}
				persistenceError={message.persistenceError}
				{currentChannel}
				messageId={message.id}
				onRetry={retryMessagePersistence}
			/>
		{/if}

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
		{/if}

		<MessageReactions {message} {currentUser} {users} {emojis} {onToggleReaction} />
	</div>
</div>
{/if}

<style>
	/* Discord-like cozy force (groupStart 17px, thin line pad) */
	:global(html[data-message-density='cozy'] .message),
	:global(html:not([data-message-density]) .message) {
		display: flex !important;
		align-items: flex-start !important;
		gap: 16px !important;
		padding: 2px 16px !important;
		margin: 0 !important;
		border-radius: 0 !important;
	}
	:global(html[data-message-density='cozy'] .message + .message:not(.continuation)),
	:global(html:not([data-message-density]) .message + .message:not(.continuation)) {
		margin-top: 1.0625rem !important;
	}
	:global(html[data-message-density='cozy'] .message.continuation),
	:global(html:not([data-message-density]) .message.continuation) {
		padding-top: 2px !important;
		padding-bottom: 2px !important;
		margin-top: 0 !important;
	}
	:global(html[data-message-density='cozy'] .message.has-continuation),
	:global(html:not([data-message-density]) .message.has-continuation) {
		padding-bottom: 2px !important;
	}
	:global(html[data-message-density='cozy'] .message.continuation .message-header),
	:global(html[data-message-density='cozy'] .compact-only-header),
	:global(html:not([data-message-density]) .message.continuation .message-header),
	:global(html:not([data-message-density]) .compact-only-header) {
		display: none !important;
	}
	:global(html[data-message-density='cozy'] .message-avatar),
	:global(html[data-message-density='cozy'] .message-avatar-spacer),
	:global(html:not([data-message-density]) .message-avatar),
	:global(html:not([data-message-density]) .message-avatar-spacer) {
		width: 40px !important;
		min-width: 40px !important;
		flex-shrink: 0 !important;
	}
	:global(html[data-message-density='cozy'] .message .avatar),
	:global(html[data-message-density='cozy'] .message .avatar-placeholder),
	:global(html:not([data-message-density]) .message .avatar),
	:global(html:not([data-message-density]) .message .avatar-placeholder) {
		width: 40px !important;
		height: 40px !important;
	}
	:global(html[data-message-density='cozy'] .message .username),
	:global(html:not([data-message-density]) .message .username) {
		font-size: 1rem !important; /* 16px Discord-ish */
		font-weight: 500 !important;
		line-height: 1.375 !important;
	}
	:global(html[data-message-density='cozy'] .message .timestamp),
	:global(html:not([data-message-density]) .message .timestamp) {
		font-size: 0.75rem !important; /* 12px */
		line-height: 1.375 !important;
	}
	:global(html[data-message-density='cozy'] .message .message-content),
	:global(html[data-message-density='cozy'] .message .markdown-content),
	:global(html:not([data-message-density]) .message .message-content),
	:global(html:not([data-message-density]) .message .markdown-content) {
		font-size: 1rem !important;
		line-height: 1.375 !important;
	}
	:global(.message .markdown-content p) {
		margin: 0 !important;
		line-height: 1.375 !important;
	}
	:global(.message .markdown-content p + p) {
		margin-top: 0.25em !important;
	}
	:global(.messages-pane) {
		gap: 0 !important;
	}
	:global(.no-more-messages) {
		padding: 8px 12px 4px !important;
		font-size: 13px !important;
	}
</style>