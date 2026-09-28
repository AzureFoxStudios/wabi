import { describe, expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get } from 'svelte/store';
import { clearServerEmotes, emojis, mergeServerEmotes } from '../../emoji-store';

async function renderActions(quickReactionEmojis: unknown[]): Promise<string> {
	const source = readFileSync(new URL('./MessageItemActions.svelte', import.meta.url), 'utf8')
		.replace("import { _ } from '$lib/i18n';", "const _ = { subscribe(run) { run((key) => key); return () => {}; } };");
	const compiled = compile(source, { generate: 'server', filename: 'MessageItemActions.svelte' }).js.code
		.replace(/from ['"](svelte[^'"]*)['"]/g, (_match, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
	const directory = mkdtempSync(join(tmpdir(), 'wabi-message-actions-'));
	try {
		const path = join(directory, 'MessageItemActions.mjs');
		writeFileSync(path, compiled);
		const { default: component } = await import(pathToFileURL(path).href);
		const noop = () => {};
		return render(component, { props: {
			message: { id: 'message-1' }, ownMessage: false, quickReactionEmojis,
			mobileActionsMessageId: null, displayEnhancementSettingsStore: { messageUtilitiesEnabled: false },
			onReply: noop, onQuickMention: noop, onForward: noop, onContextMenu: noop,
			onOpenReactionPicker: noop, onQuickReact: noop, onHandleUtilityPinToggle: noop, onHandleUtilityEdit: noop
		} }).body;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe('quick reaction visibility', () => {
	test('disabled empty options hide the entire shortcut strip while retaining normal actions', async () => {
		const html = await renderActions([]);
		expect(html).not.toContain('quick-reactions-strip');
		expect(html).not.toContain('quick-reaction-btn');
		expect(html).toContain('messages.add_reaction');
		expect(html).toContain('messages.actions.reply');
	});

	test('enabled options render the configured emoji shortcut', async () => {
		const html = await renderActions([{ id: 'emo_wave', name: 'wave', url: '/uploads/wave.gif' }]);
		expect(html).toContain('quick-reactions-strip');
		expect(html).toContain('Quick react: wave');
		expect(html).toContain('/uploads/wave.gif');
	});

	test('server emoji render with the selected Authority URL after a server switch', async () => {
		const emote = { emote_id: 'emo_wave', name: 'wave', image_url: '/uploads/wave.gif', created_at_micros: 1, created_by_user_id: 1 };
		try {
			mergeServerEmotes([emote], 'https://first.example');
			mergeServerEmotes([emote], 'https://second.example');
			const html = await renderActions(get(emojis).filter((emoji) => emoji.isCustom));
			expect(html).toContain('src="https://second.example/uploads/wave.gif"');
			expect(html).not.toContain('first.example');
			expect(html).not.toContain('src="/uploads/');
		} finally {
			clearServerEmotes();
		}
	});
});
