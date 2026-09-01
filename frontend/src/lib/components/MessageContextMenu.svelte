<script lang="ts">
	import type { Message } from '$lib/socket';
	import { currentUser } from '$lib/socket';
	import { get } from 'svelte/store';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
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
	export let onPromoteToLore: (() => void) | undefined = undefined;
	export let onCopyMessageLink: (() => void) | undefined = undefined;
	export let onCopyQuote: (() => void) | undefined = undefined;
	export let onForward: (() => void) | undefined = undefined;
	export let onAddReaction: (() => void) | undefined = undefined;
	export let onTranslate: (() => void) | undefined = undefined;
	export let onQuickMention: (() => void) | undefined = undefined;
	export let onTogglePersonalPin: (() => void) | undefined = undefined;
	export let quickMentionEnabled = true;
	export let personalPinsEnabled = true;
	export let isPersonalPinned = false;
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
	$: hasFile = message.type === 'file' && (Boolean(message.fileUrl) || (message.files?.length ?? 0) > 0);
	$: canCopyText = !!message.text?.trim();

	function closeMenu() {
		visible = false;
	}

	async function copyText() {
		if (!message.text) return;
		try {
			await navigator.clipboard.writeText(message.text);
		} catch (error) {
			console.error('Failed to copy message text:', error);
		}
	}

	$: items = buildItems();

	function buildItems(): ContextMenuItem[] {
		const list: ContextMenuItem[] = [
			{
				id: 'reply',
				label: get(_)('context_menu.reply'),
				icon: 'message-circle',
				onSelect: onReply
			}
		];

		if (quickMentionEnabled && onQuickMention && !isOwnMessageByIdentity) {
			list.push({
				id: 'quick-mention',
				label: get(_)('context_menu.quick_mention'),
				icon: 'message-circle',
				onSelect: onQuickMention
			});
		}

		if (onAddReaction) {
			list.push({
				id: 'react',
				label: get(_)('context_menu.add_reaction'),
				icon: 'smile',
				onSelect: onAddReaction
			});
		}

		if (onTranslate && canCopyText) {
			list.push({
				id: 'translate',
				label: get(_)('context_menu.translate'),
				icon: 'languages',
				onSelect: onTranslate
			});
		}

		if (hasFile && onDownload) {
			list.push({
				id: 'download',
				label: get(_)('context_menu.download'),
				icon: 'download',
				onSelect: onDownload
			});
		}

		if (hasFile && onAddToAlbum) {
			list.push({
				id: 'add-to-album',
				label: get(_)('context_menu.add_to_album'),
				icon: 'archive',
				onSelect: onAddToAlbum
			});
		}

		if (hasFile && onPromoteToLore) {
			list.push({
				id: 'promote-to-lore',
				label: 'Promote to Lore…',
				icon: 'archive',
				onSelect: onPromoteToLore
			});
		}

		if (onForward) {
			list.push({
				id: 'forward',
				label: get(_)('context_menu.forward'),
				icon: 'forward',
				onSelect: onForward
			});
		}

		if (onCopyQuote) {
			list.push({
				id: 'copy-quote',
				label: get(_)('context_menu.copy_quote'),
				icon: 'copy',
				onSelect: onCopyQuote
			});
		}

		if (onCopyMessageLink) {
			list.push({
				id: 'copy-link',
				label: get(_)('context_menu.copy_message_link'),
				icon: 'copy',
				onSelect: onCopyMessageLink
			});
		}

		if (canEditMessage) {
			list.push({
				id: 'edit',
				label: get(_)('context_menu.edit_message'),
				icon: 'edit',
				onSelect: onEdit
			});
		}

		list.push({
			id: 'pin',
			label: message.isPinned ? get(_)('context_menu.unpin_message') : get(_)('context_menu.pin_message'),
			icon: 'pin',
			onSelect: onPin
		});

		if (personalPinsEnabled && onTogglePersonalPin) {
			list.push({
				id: 'personal-pin',
				label: isPersonalPinned ? get(_)('context_menu.unpin_local_message') : get(_)('context_menu.pin_local_message'),
				icon: 'pin',
				onSelect: onTogglePersonalPin
			});
		}

		list.push({
			id: 'copy',
			label: get(_)('context_menu.copy_text'),
			icon: 'copy',
			disabled: !canCopyText,
			onSelect: copyText
		});

		list.push({ id: 'danger-divider', type: 'separator' });
		list.push({
			id: 'delete',
			label: canDeleteResolved ? get(_)('context_menu.delete_message_uploads') : get(_)('context_menu.delete_message'),
			hint: canDeleteResolved
				? get(_)('context_menu.delete_message_uploads_hint')
				: get(_)('context_menu.delete_message_unavailable_hint'),
			icon: 'trash-2',
			danger: true,
			disabled: !canDeleteResolved,
			onSelect: onDelete
		});

		return list;
	}
</script>

<ContextMenu
	open={visible}
	{x}
	{y}
	{items}
	ariaLabel={$_('context_menu.aria_label')}
	on:close={closeMenu}
/>
