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
	export let onForward: (() => void) | undefined = undefined;
	export let onAddReaction: (() => void) | undefined = undefined;

	$: isOwnMessage = message.userId === $currentUser?.id;
	$: hasFile = message.type === 'file' && message.fileUrl;
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

		if (onAddReaction) {
			list.push({
				id: 'react',
				label: get(_)('context_menu.add_reaction'),
				icon: 'smile',
				onSelect: onAddReaction
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

		if (onForward) {
			list.push({
				id: 'forward',
				label: get(_)('context_menu.forward'),
				icon: 'forward',
				onSelect: onForward
			});
		}

		if (isOwnMessage) {
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

		list.push({
			id: 'copy',
			label: get(_)('context_menu.copy_text'),
			icon: 'copy',
			disabled: !canCopyText,
			onSelect: copyText
		});

		if (isOwnMessage) {
			list.push({ id: 'danger-divider', type: 'separator' });
			list.push({
				id: 'delete',
				label: get(_)('context_menu.delete_message'),
				icon: 'trash-2',
				danger: true,
				onSelect: onDelete
			});
		}

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
