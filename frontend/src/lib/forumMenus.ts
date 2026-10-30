/**
 * The forum's ⋯ menus (thread, list row, reply) on the one kit menu (ui/Menu.svelte): the same
 * share actions ObjectShareMenu offers, with the owner/moderator actions after a separator and
 * always last (§7.4: danger rows last).
 */
import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
import type { ObjectRefRecord } from './objectRefRegistry';
import { openShareModal } from './shareStore';
import { buildShareLink, buildShareRefText, copyToClipboard } from './shareToChannel';

function copy(text: string): void {
	void copyToClipboard(text).catch((error) => console.warn('[forum] copy failed', error));
}

export function forumShareItems(record: ObjectRefRecord, extra: MenuEntry[] = []): MenuEntry[] {
	const items: MenuEntry[] = [
		{ id: 'share', label: 'Share to channel…', icon: 'share', onSelect: () => openShareModal(record) },
		{ id: 'copy-link', label: 'Copy link', icon: 'link', onSelect: () => copy(buildShareLink(record)) },
		{ id: 'copy-ref', label: 'Copy reference', icon: 'copy', onSelect: () => copy(buildShareRefText(record)) }
	];
	if (extra.length === 0) return items;
	return [...items, { id: 'owner-actions', type: 'separator' }, ...extra];
}
