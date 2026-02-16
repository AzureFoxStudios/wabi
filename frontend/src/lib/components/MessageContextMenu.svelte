<script lang="ts">
	import type { Message } from '$lib/socket';
	import { currentUser } from '$lib/socket';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';

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
				label: 'Reply',
				leading: '💬',
				onSelect: onReply
			}
		];

		if (onAddReaction) {
			list.push({
				id: 'react',
				label: 'Add Reaction',
				leading: '🙂',
				onSelect: onAddReaction
			});
		}

		if (hasFile && onDownload) {
			list.push({
				id: 'download',
				label: 'Download',
				leading: '⬇',
				onSelect: onDownload
			});
		}

		if (onForward) {
			list.push({
				id: 'forward',
				label: 'Forward',
				leading: '↪',
				onSelect: onForward
			});
		}

		if (isOwnMessage) {
			list.push({
				id: 'edit',
				label: 'Edit Message',
				leading: '✎',
				onSelect: onEdit
			});
		}

		list.push({
			id: 'pin',
			label: message.isPinned ? 'Unpin Message' : 'Pin Message',
			leading: '📌',
			onSelect: onPin
		});

		list.push({
			id: 'copy',
			label: 'Copy Text',
			leading: '📋',
			disabled: !canCopyText,
			onSelect: copyText
		});

		if (isOwnMessage) {
			list.push({ id: 'danger-divider', type: 'separator' });
			list.push({
				id: 'delete',
				label: 'Delete Message',
				leading: '🗑',
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
	ariaLabel="Message actions"
	on:close={closeMenu}
/>
