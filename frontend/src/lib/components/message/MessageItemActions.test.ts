import { describe, expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get } from 'svelte/store';
import { clearServerEmotes, emojis, mergeServerEmotes } from '../../emoji-store';

const I18N_IMPORT = "import { _ } from '$lib/i18n';";
const I18N_STUB = 'const _ = { subscribe(run) { run((key) => key); return () => {}; } };';
const ICON_IMPORT = "import Icon from '$lib/components/ui/Icon.svelte';";

function serverModule(source: string, filename: string): string {
	return compile(source, { generate: 'server', filename }).js.code
		.replace(/from ['"](svelte[^'"]*)['"]/g, (_match, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
}

/**
 * Server-render one message component. `$lib/i18n` becomes an identity translator, the shared Icon
 * component is compiled next to it, and relative TypeScript helpers resolve from this folder.
 */
async function renderComponent(file: string, props: Record<string, unknown>): Promise<string> {
	const directory = mkdtempSync(join(tmpdir(), 'wabi-message-component-'));
	try {
		const icon = readFileSync(new URL('../ui/Icon.svelte', import.meta.url), 'utf8');
		writeFileSync(
			join(directory, 'Icon.mjs'),
			serverModule(icon, 'Icon.svelte').replace(/from ['"]\.\/icons['"]/, `from ${JSON.stringify(new URL('../ui/icons.ts', import.meta.url).href)}`)
		);
		const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
			.replace(I18N_IMPORT, I18N_STUB)
			.replace(ICON_IMPORT, "import Icon from './Icon.mjs';");
		const compiled = serverModule(source, file).replace(
			/from ['"]\.\/([a-zA-Z]+)['"]/g,
			(match, name) => (name === 'Icon' ? match : `from ${JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href)}`)
		);
		const path = join(directory, `${file}.mjs`);
		writeFileSync(path, compiled);
		const { default: component } = await import(pathToFileURL(path).href);
		return render(component, { props }).body;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const noop = () => {};

function renderActions(quickReactionEmojis: unknown[], overrides: Record<string, unknown> = {}): Promise<string> {
	return renderComponent('MessageItemActions.svelte', {
		message: { id: 'message-1' }, ownMessage: false, quickReactionEmojis,
		mobileActionsMessageId: null, displayEnhancementSettingsStore: { messageUtilitiesEnabled: false },
		onReply: noop, onQuickMention: noop, onForward: noop, onContextMenu: noop,
		onOpenReactionPicker: noop, onQuickReact: noop, onHandleUtilityPinToggle: noop, onHandleUtilityEdit: noop,
		...overrides
	});
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

describe('hover toolbar (spec §7.15)', () => {
	const pool = ['1F44D', '2764', '1F602', '1F525'].map((id) => ({ id, name: `openmoji_${id}`, url: `/openmoji/png/${id}.png` }));

	test('it is the shadowless kit tool with at most three quick reactions', async () => {
		const html = await renderActions(pool);
		expect(html).toContain('message-actions w-tool');
		expect(html.match(/class="quick-reaction-btn/g)?.length).toBe(3);
		expect(html).not.toContain('/openmoji/png/1F525.png');
	});

	test('order: quick reactions | add reaction, reply, forward | more', async () => {
		const html = await renderActions(pool.slice(0, 1));
		const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
		expect(labels).toEqual(['Quick react: openmoji_1F44D', 'messages.add_reaction', 'messages.actions.reply', 'context_menu.forward', 'messages.actions.more']);
		expect(html.match(/w-tool__sep/g)?.length).toBe(2);
	});

	test('every key is a labelled icon button; the quick mention is a drawn @, never a text glyph', async () => {
		const html = await renderActions([], {
			displayEnhancementSettingsStore: { messageUtilitiesEnabled: true, quickMentionEnabled: true }
		});
		expect(html).toContain('data-icon="at"');
		expect(html).not.toMatch(/>\s*@\s*</);
		expect(html).toContain('aria-label="context_menu.quick_mention"');
		expect(html).toContain('aria-pressed="false"');
		const buttons = html.match(/<button\b[^>]*>/g) ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) expect(button).toMatch(/aria-label="[^"]+"/);
	});
});

describe('reactions (spec §7.9)', () => {
	const users = [{ id: 'user-1', dbUserId: 1, username: 'Theo' }];
	const renderReactions = (reactions: Record<string, string[]>, emojiList: unknown[] = []) =>
		renderComponent('MessageReactions.svelte', {
			message: { id: 'm1', reactions },
			currentUser: users[0],
			users,
			emojis: emojiList,
			onToggleReaction: noop
		});

	test('an emoji the client does not know still renders: as itself, or as its :shortcode:', async () => {
		const html = await renderReactions({ '🌿': ['user-1', 'user-2', 'user-3'], party_parrot: ['user-2'], '1F44D': ['user-1'] });
		expect(html.match(/class="w-react reaction-btn/g)?.length).toBe(3);
		expect(html).toContain('🌿');
		expect(html).toContain(':party_parrot:');
		expect(html).toContain('👍');
		expect(html).toContain('>3<');
	});

	test('your reaction is pressed; a known emoji keeps its image', async () => {
		const html = await renderReactions({ '1F33F': ['user-1'] }, [{ id: '1F33F', name: 'openmoji_1F33F', displayName: 'herb', url: '/openmoji/png/1F33F.png' }]);
		expect(html).toContain('aria-pressed="true"');
		expect(html).toContain('src="/openmoji/png/1F33F.png"');
		expect(html).toContain('herb');
	});

	test('a reaction with no one left is not drawn', async () => {
		const html = await renderReactions({ '🌿': [] });
		expect(html).not.toContain('w-react');
	});
});
