/**
 * The message menu's rows (design contract §7.4, §8.9), kept out of MessageContextMenu.svelte so
 * the grouping and the delete wording can be tested without a DOM.
 *
 * One group per kind of action, separated by hairlines: respond · share · edit · moderate (seal
 * glyph) · delete last. Every row has its own registry glyph (reply, quote, link, flag, globe and
 * smilePlus are distinct meanings, §6). The delete row names the uploads, with its hint, only when
 * the message actually has files attached.
 */
import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';

type Action = (() => void) | undefined;

export interface MessageMenuInput {
	/** The locale formatter (`get(_)`). */
	t: (key: string) => string;
	isOwn: boolean;
	canEdit: boolean;
	canDelete: boolean;
	hasFile: boolean;
	canCopyText: boolean;
	isPinned: boolean;
	isPersonalPinned: boolean;
	translatorEnabled: boolean;
	quickMentionEnabled: boolean;
	personalPinsEnabled: boolean;
	onReply: Action;
	onAddReaction?: Action;
	onQuickMention?: Action;
	onTranslate?: Action;
	onForward?: Action;
	onCopyText: Action;
	onCopyQuote?: Action;
	onCopyMessageLink?: Action;
	onDownload?: Action;
	onAddToAlbum?: Action;
	onPromoteToLore?: Action;
	onEdit: Action;
	onPin: Action;
	onTogglePersonalPin?: Action;
	onReport?: Action;
	onDelete: Action;
}

export function buildMessageMenu(input: MessageMenuInput): MenuEntry[] {
	const { t } = input;

	const respond: MenuEntry[] = [{ id: 'reply', label: t('context_menu.reply'), icon: 'reply', onSelect: input.onReply }];
	if (input.onAddReaction) respond.push({ id: 'react', label: t('context_menu.add_reaction'), icon: 'smilePlus', onSelect: input.onAddReaction });
	if (input.quickMentionEnabled && input.onQuickMention && !input.isOwn) {
		respond.push({ id: 'quick-mention', label: t('context_menu.quick_mention'), icon: 'at', onSelect: input.onQuickMention });
	}
	if (input.translatorEnabled && input.onTranslate && input.canCopyText) {
		respond.push({ id: 'translate', label: t('context_menu.translate'), icon: 'globe', onSelect: input.onTranslate });
	}

	const share: MenuEntry[] = [];
	if (input.onForward) share.push({ id: 'forward', label: t('context_menu.forward'), icon: 'forward', onSelect: input.onForward });
	share.push({ id: 'copy', label: t('context_menu.copy_text'), icon: 'copy', disabled: !input.canCopyText, onSelect: input.onCopyText });
	if (input.onCopyQuote) share.push({ id: 'copy-quote', label: t('context_menu.copy_quote'), icon: 'quote', onSelect: input.onCopyQuote });
	if (input.onCopyMessageLink) share.push({ id: 'copy-link', label: t('context_menu.copy_message_link'), icon: 'link', onSelect: input.onCopyMessageLink });
	if (input.hasFile && input.onDownload) share.push({ id: 'download', label: t('context_menu.download'), icon: 'download', onSelect: input.onDownload });
	if (input.hasFile && input.onAddToAlbum) share.push({ id: 'add-to-album', label: t('context_menu.add_to_album'), icon: 'image', onSelect: input.onAddToAlbum });
	if (input.hasFile && input.onPromoteToLore) {
		share.push({ id: 'promote-to-lore', label: 'Promote to Lore…', icon: 'box', keepCase: true, onSelect: input.onPromoteToLore });
	}

	const edit: MenuEntry[] = [];
	if (input.canEdit) edit.push({ id: 'edit', label: t('context_menu.edit_message'), icon: 'pencil', onSelect: input.onEdit });
	edit.push({
		id: 'pin',
		label: input.isPinned ? t('context_menu.unpin_message') : t('context_menu.pin_message'),
		icon: 'pin',
		onSelect: input.onPin
	});
	if (input.personalPinsEnabled && input.onTogglePersonalPin) {
		edit.push({
			id: 'personal-pin',
			label: input.isPersonalPinned ? t('context_menu.unpin_local_message') : t('context_menu.pin_local_message'),
			icon: 'star',
			onSelect: input.onTogglePersonalPin
		});
	}

	const moderate: MenuEntry[] = [];
	if (input.onReport && !input.isOwn) moderate.push({ id: 'report', label: 'Report message', icon: 'flag', seal: true, onSelect: input.onReport });

	const list: MenuEntry[] = [];
	[respond, share, edit, moderate].forEach((group, index) => {
		if (!group.length) return;
		if (list.length) list.push({ id: `group-${index}`, type: 'separator' });
		list.push(...group);
	});
	list.push(deleteEntry(input));
	return list;
}

/** "Delete message", or "Delete message and uploads…" with its hint only when files are attached. */
function deleteEntry(input: MessageMenuInput): MenuEntry {
	const { t } = input;
	if (!input.canDelete) {
		return {
			id: 'delete',
			label: t('context_menu.delete_message'),
			hint: t('context_menu.delete_message_unavailable_hint'),
			icon: 'trash',
			danger: true,
			disabled: true
		};
	}
	if (input.hasFile) {
		return {
			id: 'delete',
			label: t('context_menu.delete_message_uploads'),
			hint: t('context_menu.delete_message_uploads_hint'),
			icon: 'trash',
			danger: true,
			onSelect: input.onDelete
		};
	}
	return { id: 'delete', label: t('context_menu.delete_message'), icon: 'trash', danger: true, onSelect: input.onDelete };
}
