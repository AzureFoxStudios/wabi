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
 * Compile one message component for the server and import it. `$lib/i18n` becomes an identity
 * translator, the shared Icon component is compiled next to it, and relative TypeScript helpers
 * resolve from this folder.
 */
async function loadComponent(file: string): Promise<Record<string, any>> {
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
		return await import(pathToFileURL(path).href);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Server-render one message component (see loadComponent). */
async function renderComponent(file: string, props: Record<string, unknown>): Promise<string> {
	const { default: component } = await loadComponent(file);
	return render(component, { props }).body;
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
		const buttons = html.match(/<button\b[^>]*>/g) ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) expect(button).toMatch(/aria-label="[^"]+"/);
	});

	test('MessageUtilities keys sit in their own group between Forward and More', async () => {
		const html = await renderActions(pool.slice(0, 1), {
			displayEnhancementSettingsStore: { messageUtilitiesEnabled: true, quickMentionEnabled: true }
		});
		const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
		expect(labels).toEqual([
			'Quick react: openmoji_1F44D', 'messages.add_reaction', 'messages.actions.reply', 'context_menu.forward',
			'context_menu.quick_mention', 'context_menu.pin_message', 'messages.actions.more'
		]);
		expect(html.match(/w-tool__sep/g)?.length).toBe(3);
	});

	test('the pin key names its action once: Pin or Unpin, with no pressed state on top', async () => {
		const utilities = { displayEnhancementSettingsStore: { messageUtilitiesEnabled: true, quickMentionEnabled: false } };
		const unpinned = await renderActions([], utilities);
		const pinned = await renderActions([], { ...utilities, message: { id: 'message-1', isPinned: true } });
		expect(unpinned).toContain('aria-label="context_menu.pin_message"');
		expect(pinned).toContain('aria-label="context_menu.unpin_message"');
		expect(unpinned + pinned).not.toContain('aria-pressed');
	});

	test('the More key is marked, so a reduced toolbar can keep it alone', async () => {
		const html = await renderActions(pool);
		expect(html).toMatch(/class="action-btn message-actions__more w-ibtn"[^>]*aria-label="messages.actions.more"/);
	});
});

describe('hover toolbar placement: it never covers message text (spec §7.15, §8.3)', () => {
	type Rect = { left: number; top: number; right: number; bottom: number };
	const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
	// A 716px page row at x 300, its first line at y 500; the toolbar is 232 x 34 at home
	// (page edge, top -18).
	const row = rect(300, 500, 1016, 548);
	const edge = rect(784, 482, 1016, 516);
	const longFirstLine = rect(416, 503, 1000, 521);
	const shortLineAbove = rect(416, 479, 700, 497);
	const longLineAbove = rect(416, 479, 1000, 497);
	let choose: (input: Record<string, unknown>) => { place: string; compact: boolean; x: number; y: number };

	const place = async (overrides: Record<string, unknown>) => {
		choose ??= (await loadComponent('MessageItemActions.svelte')).chooseHoverToolPlace;
		return choose({
			row, edge, compactWidth: 34, textStart: 416, bounds: rect(280, 100, 1300, 880),
			obstacles: [], allowCompact: true, ...overrides
		});
	};

	test('a group start keeps its home on the page edge: the name line leaves room', async () => {
		const nameLine = rect(416, 500, 560, 520);
		expect(await place({ obstacles: [nameLine] })).toMatchObject({ place: 'edge', compact: false });
	});

	test('a continuation whose first line runs under home moves into the right margin', async () => {
		const result = await place({ obstacles: [longFirstLine, shortLineAbove] });
		expect(result).toEqual({ place: 'margin', compact: false, x: 716 + 12, y: -5 });
	});

	test('without margin room it sits just above the row when the line above is short', async () => {
		const result = await place({ bounds: rect(280, 100, 1120, 880), obstacles: [longFirstLine, shortLineAbove] });
		expect(result).toEqual({ place: 'above', compact: false, x: 484, y: -38 });
	});

	test('boxed in by text, it keeps only More: in the margin, else in the empty avatar column', async () => {
		const boxedIn = [longFirstLine, longLineAbove];
		expect(await place({ bounds: rect(280, 100, 1120, 880), obstacles: boxedIn })).toEqual({ place: 'margin', compact: true, x: 728, y: -5 });
		expect(await place({ bounds: rect(280, 100, 1040, 880), obstacles: boxedIn })).toEqual({ place: 'gutter', compact: true, x: 76, y: -5 });
	});

	test('own messages on the right: home is the text column start, and the margin still works', async () => {
		const mirroredHome = rect(416, 482, 648, 516);
		const ownLine = rect(420, 503, 1016, 521);
		const result = await place({ edge: mirroredHome, obstacles: [ownLine] });
		expect(result).toMatchObject({ place: 'margin', compact: false });
	});

	test('an avatar in the column blocks the reduced spot too; nothing clear falls back to home', async () => {
		const avatar = rect(366, 500, 402, 536);
		const result = await place({ bounds: rect(280, 100, 1040, 880), obstacles: [longFirstLine, longLineAbove, avatar] });
		expect(result).toMatchObject({ place: 'edge', compact: false });
	});

	test('focus on a toolbar key never reduces the toolbar', async () => {
		const result = await place({ bounds: rect(280, 100, 1040, 880), obstacles: [longFirstLine, longLineAbove], allowCompact: false });
		expect(result).toMatchObject({ place: 'edge', compact: false });
	});

	test('a spot the scroller would clip does not count', async () => {
		const result = await place({ bounds: rect(280, 490, 1300, 880), obstacles: [longFirstLine] });
		expect(result).toMatchObject({ place: 'margin', compact: false, y: -5 });
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

describe('stream stylesheet the rows rely on (spec §7.17, §7.18, §8.12)', () => {
	let css = readFileSync(new URL('../../../styles/stream.css', import.meta.url), 'utf8');
	// Strip comments by looping one pattern until the text stops changing.
	for (let previous = ''; previous !== css; ) {
		previous = css;
		css = css.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//, '');
	}
	const block = (selector: string): string => {
		const start = css.indexOf(`${selector} {`);
		expect(start).toBeGreaterThanOrEqual(0);
		return css.slice(start, css.indexOf('}', start));
	};

	test('the pane grows with its rows, so the floating day rule stays sticky through history', () => {
		expect(block('.messages-pane')).toContain('flex-shrink: 0;');
	});

	test('group spacing outranks the legacy phone rule `.message + .message:not(.continuation)`', () => {
		expect(block('.messages-pane .message:not(.continuation)')).toContain('margin-top: 18px;');
		expect(css).toMatch(/@container stream \(max-width: 559\.98px\)[\s\S]*\.messages-pane \.message:not\(\.continuation\) \{\s*margin-top: 22px;/);
	});

	test('the header time is full ink at every width and a dated stamp is never hidden', () => {
		const stamp = block('.messages-pane .message .message-header .timestamp');
		expect(stamp).toContain('opacity: 1;');
		expect(stamp).toContain('margin: 0;');
		expect(block('.messages-pane .message .message-header .timestamp:not(.timestamp--full)')).toContain('display: none;');
	});

	test('MessageList output keeps the row grammar where the host has no pane (glance preview)', () => {
		expect(block('.ml-stream:not(.messages-pane)')).toContain('display: contents;');
		expect(css).toContain(':has(> .ml-stream.messages-pane) {\n\tcontainer: stream / inline-size;');
	});

	test('compact density moves the text column, so the day and NEW rules end with the text', () => {
		expect(block("\t:root[data-message-density='compact'] .messages-pane")).toContain('--stream-text-x: calc(var(--stream-lead) + 120px * var(--w-fs) + var(--stream-gap));');
	});
});
