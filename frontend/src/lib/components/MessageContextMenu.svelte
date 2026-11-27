<script lang="ts">
	import type { Message } from '$lib/socket';
	import { currentUser } from '$lib/socket';
	import { get } from 'svelte/store';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { getTranslatorSettings } from '$lib/components/message/messageTranslator';
	import { buildMessageMenu } from './messageContextMenuItems';
	import { keepReasonFor, type KeepReason } from '$lib/privacy/contentEgress';
	import { privateMediaToGallery } from '$lib/privacy/privateMediaToGallery';
	import { galleryAttachmentItems } from '$lib/galleryFromMessage';
	import { getMessageAttachmentActionItems } from './message/messageAttachmentActions';
	import { _ } from '$lib/i18n';

	export let message: Message;
	export let x = 0;
	export let y = 0;
	export let visible = false;
	export let onEdit: () => void;
	export let onDelete: () => void;
	export let onPin: () => void;
	export let onReply: () => void;
	export let onDownload: (() => void) | undefined = undefined;
	export let onAddToAlbum: (() => void) | undefined = undefined;
	export let onAddToGallery: (() => void) | undefined = undefined;
	/** Every member of this conversation agreed to server-readable albums. */
	export let albumsAgreed = false;
	export let onPromoteToLore: (() => void) | undefined = undefined;
	export let onRoleReactions: (() => void) | undefined = undefined;
	export let onCopyMessageLink: (() => void) | undefined = undefined;
	export let onCopyQuote: (() => void) | undefined = undefined;
	export let onForward: (() => void) | undefined = undefined;
	export let onAddReaction: (() => void) | undefined = undefined;
	export let onTranslate: (() => void) | undefined = undefined;
	export let onQuickMention: (() => void) | undefined = undefined;
	export let onTogglePersonalPin: (() => void) | undefined = undefined;
	export let onReport: (() => void) | undefined = undefined;
	export let quickMentionEnabled = true;
	export let personalPinsEnabled = true;
	export let isPersonalPinned = false;
	/** The room's (or caller's) reason to keep content on the device; the message's own flag is added here. */
	export let roomKeepReason: KeepReason | null = null;
	export let canManageOwnMessage: boolean | null = null;
	export let canDeleteMessage: boolean | null = null;

	function getCurrentIdentityIds(): string[] {
		if (!$currentUser) return [];
		const ids: string[] = [];
		if ($currentUser.id) ids.push($currentUser.id);
		if ($currentUser.dbUserId) ids.push(`user-${$currentUser.dbUserId}`);
		return ids;
	}

	$: isOwnMessageByIdentity = (() => {
		if (!$currentUser) return false;
		if (message.user === $currentUser.username) return true;
		return getCurrentIdentityIds().includes(message.userId);
	})();
	$: canEditMessage = canManageOwnMessage ?? isOwnMessageByIdentity;
	$: canDeleteResolved = canDeleteMessage ?? canEditMessage;
	$: hasGalleryMedia = galleryAttachmentItems(getMessageAttachmentActionItems(message)).length > 0;
	$: hasFile = message.type === 'file' && (Boolean(message.fileUrl) || (message.files?.length ?? 0) > 0);
	$: canCopyText = !!message.text?.trim();

	function closeMenu() { visible = false; }

	async function copyText() {
		if (!message.text) return;
		try { await navigator.clipboard.writeText(message.text); }
		catch (error) { console.error('Failed to copy message text:', error); }
	}

	// `visible` is intentionally an explicit dependency. Translator settings live
	// in localStorage, so reopening the menu must rebuild actions after an Add-ons
	// settings change without requiring a page reload.
	$: items = buildItems(visible, message, roomKeepReason, hasGalleryMedia, $privateMediaToGallery, albumsAgreed);

	function buildItems(_menuVisible: boolean, _message: Message, _room: KeepReason | null, galleryMedia: boolean, galleryAllowed: boolean, albumsOpen: boolean): MenuEntry[] {
		return buildMessageMenu({
			t: get(_),
			isOwn: isOwnMessageByIdentity,
			canEdit: canEditMessage,
			canDelete: canDeleteResolved,
			hasFile,
			canCopyText,
			isPinned: !!message.isPinned,
			isPersonalPinned,
			keepReason: keepReasonFor(message, roomKeepReason),
			translatorEnabled: getTranslatorSettings().mode !== 'off',
			quickMentionEnabled,
			personalPinsEnabled,
			onReply,
			onAddReaction,
			onQuickMention,
			onTranslate,
			onForward,
			onCopyText: copyText,
			onCopyQuote,
			onCopyMessageLink,
			onDownload,
			onAddToAlbum,
			albumsAgreed: albumsOpen,
			onAddToGallery: galleryMedia ? onAddToGallery : undefined,
			privateMediaToGallery: galleryAllowed,
			onPromoteToLore,
			onRoleReactions,
			onEdit,
			onPin,
			onTogglePersonalPin,
			onReport,
			onDelete
		});
	}
</script>

<ContextMenu open={visible} {x} {y} {items} ariaLabel={$_('context_menu.aria_label')} on:close={closeMenu} />
