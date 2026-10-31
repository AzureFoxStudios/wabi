import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildMessageMenu, type MessageMenuInput } from './messageContextMenuItems';

const words: Record<string, string> = {
	'context_menu.reply': 'Reply',
	'context_menu.add_reaction': 'Add reaction',
	'context_menu.quick_mention': 'Quick mention',
	'context_menu.translate': 'Translate',
	'context_menu.forward': 'Forward',
	'context_menu.copy_text': 'Copy text',
	'context_menu.copy_quote': 'Copy quote',
	'context_menu.copy_message_link': 'Copy message link',
	'context_menu.download': 'Download',
	'context_menu.add_to_album': 'Add to album',
	'context_menu.edit_message': 'Edit message',
	'context_menu.pin_message': 'Pin message',
	'context_menu.unpin_message': 'Unpin message',
	'context_menu.pin_local_message': 'Pin on this device',
	'context_menu.unpin_local_message': 'Unpin on this device',
	'context_menu.delete_message': 'Delete message',
	'context_menu.delete_message_uploads': 'Delete message and uploads…',
	'context_menu.delete_message_uploads_hint': 'Also deletes the attached files',
	'context_menu.delete_message_unavailable_hint': 'Only your own messages can be deleted'
};
const noop = () => {};

function input(patch: Partial<MessageMenuInput> = {}): MessageMenuInput {
	return {
		t: (key) => words[key] ?? key,
		isOwn: false,
		canEdit: false,
		canDelete: true,
		hasFile: false,
		canCopyText: true,
		isPinned: false,
		isPersonalPinned: false,
		translatorEnabled: true,
		quickMentionEnabled: true,
		personalPinsEnabled: true,
		onReply: noop,
		onAddReaction: noop,
		onQuickMention: noop,
		onTranslate: noop,
		onForward: noop,
		onCopyText: noop,
		onCopyQuote: noop,
		onCopyMessageLink: noop,
		onDownload: noop,
		onAddToAlbum: noop,
		onPromoteToLore: noop,
		onEdit: noop,
		onPin: noop,
		onTogglePersonalPin: noop,
		onReport: noop,
		onDelete: noop,
		...patch
	};
}

/** Row ids per hairline group, the shape the menu draws. */
function groups(entries: ReturnType<typeof buildMessageMenu>): string[][] {
	const out: string[][] = [[]];
	for (const entry of entries) {
		if (entry.type === 'separator') out.push([]);
		else out[out.length - 1].push(entry.id);
	}
	return out;
}

describe('message menu (§8.9)', () => {
	test('groups read respond · share · edit · moderate, with delete last', () => {
		const menu = buildMessageMenu(input({ canEdit: true }));
		expect(groups(menu)).toEqual([
			['reply', 'react', 'quick-mention', 'translate'],
			['forward', 'copy', 'copy-quote', 'copy-link'],
			['edit', 'pin', 'personal-pin'],
			['report', 'delete']
		]);
		expect(menu.at(-1)?.id).toBe('delete');
		expect(menu.at(-1)?.danger).toBe(true);
	});

	test('every row has its own glyph and moderation wears the seal', () => {
		const menu = buildMessageMenu(input({ canEdit: true, hasFile: true }));
		const icons = menu.filter((entry) => entry.type !== 'separator').map((entry) => entry.icon);
		expect(new Set(icons).size).toBe(icons.length);
		const byId = Object.fromEntries(menu.map((entry) => [entry.id, entry]));
		expect(byId.reply.icon).toBe('reply');
		expect(byId['copy-quote'].icon).toBe('quote');
		expect(byId['copy-link'].icon).toBe('link');
		expect(byId.report.icon).toBe('flag');
		expect(byId.report.seal).toBe(true);
		expect(byId.translate.icon).toBe('globe');
		expect(byId.react.icon).toBe('smilePlus');
	});

	test('labels are sentence case and never shouted', () => {
		const menu = buildMessageMenu(input({ canEdit: true, hasFile: true }));
		for (const entry of menu) {
			if (!entry.label) continue;
			expect(entry.label).not.toMatch(/[A-Z]{3,}/);
			expect(entry.label.slice(1)).not.toMatch(/\b[A-Z][a-z]+ [A-Z][a-z]+/);
		}
	});

	test('delete names the uploads and carries the hint only when files are attached', () => {
		const plain = buildMessageMenu(input()).at(-1)!;
		expect(plain.label).toBe('Delete message');
		expect(plain.hint).toBeUndefined();
		const withFiles = buildMessageMenu(input({ hasFile: true })).at(-1)!;
		expect(withFiles.label).toBe('Delete message and uploads…');
		expect(withFiles.hint).toBe('Also deletes the attached files');
		const unavailable = buildMessageMenu(input({ canDelete: false, hasFile: true })).at(-1)!;
		expect(unavailable.label).toBe('Delete message');
		expect(unavailable.disabled).toBe(true);
		expect(unavailable.onSelect).toBeUndefined();
	});

	test('own messages drop quick mention and report; file rows need a file', () => {
		const ids = buildMessageMenu(input({ isOwn: true })).map((entry) => entry.id);
		expect(ids).not.toContain('quick-mention');
		expect(ids).not.toContain('report');
		expect(ids).not.toContain('download');
		expect(ids).not.toContain('report-divider');
		const fileIds = buildMessageMenu(input({ hasFile: true })).map((entry) => entry.id);
		expect(fileIds).toEqual(expect.arrayContaining(['download', 'add-to-album', 'promote-to-lore']));
	});

	test('no empty groups or doubled separators when optional rows are absent', () => {
		const menu = buildMessageMenu(
			input({ onAddReaction: undefined, onQuickMention: undefined, onTranslate: undefined, onForward: undefined, onReport: undefined, personalPinsEnabled: false })
		);
		expect(groups(menu).every((group) => group.length > 0)).toBe(true);
		expect(groups(menu)).toEqual([['reply'], ['copy', 'copy-quote', 'copy-link'], ['pin', 'delete']]);
	});

	test('the component builds its rows through this helper', () => {
		const source = readFileSync(new URL('./MessageContextMenu.svelte', import.meta.url), 'utf8');
		expect(source).toContain('buildMessageMenu(');
		expect(source).not.toContain("'message-circle'");
	});
});
