import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { privacyStateFor, privacyWords, resolvePrivacySubject } from '../../privacy/privacyState';
import { get } from 'svelte/store';
import {
	composerChannelType,
	composerColophons,
	composerFieldLabel,
	composerPrivacyInput,
	composerReadsRoomStatus,
	composerRetention,
	composerRoomFact,
	holdComposerColophon
} from './composerPrivacy';

// Contract: design spec §7.20 (composer and colophon), §8.10 (DMs), §9.2 (privacy words) and
// critiques chat#2, chat#7, chat#8, chat#9, beta-sweep#9, mobile#9, foundation#18.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Remove every match, repeating until none remain (one pattern per call). */
function stripAll(text: string, pattern: RegExp): string {
	let previous;
	do {
		previous = text;
		text = text.replace(pattern, '');
	} while (text !== previous);
	return text;
}

/** Code without comments, so a comment can never satisfy or break an assertion. */
function code(source: string): string {
	let out = stripAll(source, /<!--[\s\S]*?-->/g);
	out = stripAll(out, /\/\*[\s\S]*?\*\//g);
	out = stripAll(out, /^\s*\/\/.*$/gm);
	return out;
}

const composer = code(read('./ChatComposer.svelte'));
const chat = code(read('../Chat.svelte'));
const messageStore = code(read('../../messageStore.ts'));
const e2ee = code(read('../../e2ee.ts'));

/** What the colophon would say for these composer facts. */
function colophonState(options: Parameters<typeof composerPrivacyInput>[0]) {
	return privacyStateFor(composerPrivacyInput(options));
}

describe('the room kind the colophon words', () => {
	test('the host wins, then the channel store, then "dm" for a DM host; never "text" by default', () => {
		expect(composerChannelType('group', 'dm', false)).toBe('group');
		expect(composerChannelType(null, 'text', false)).toBeNull();
		expect(composerChannelType(undefined, 'forum', false)).toBe('forum');
		expect(composerChannelType(undefined, undefined, true)).toBe('dm');
		expect(composerChannelType(undefined, undefined, false)).toBeNull();
	});

	test('an unknown kind never reads as a community channel: it is Checking', () => {
		expect(colophonState({ channelType: null, hostGaveStatus: false })).toBe('checking');
	});
});

describe('the colophon never claims encryption that is not happening', () => {
	test('community channels are Server-readable whatever a flag or status says', () => {
		for (const channelType of ['text', 'public', 'announcement', 'forum', 'wiki']) {
			expect(colophonState({ channelType, encryptSend: true, hostGaveStatus: true, hostStatus: { enabled: true } })).toBe('server-readable');
			expect(colophonState({ channelType, hostGaveStatus: false, ownStatus: { enabled: true } })).toBe('server-readable');
		}
	});

	test('a DM opened in the channel stream reads its own room status, and is Checking until it arrives', () => {
		expect(composerReadsRoomStatus('dm', false)).toBe(true);
		expect(composerReadsRoomStatus('group', false)).toBe(true);
		expect(composerReadsRoomStatus('text', false)).toBe(false);
		expect(composerReadsRoomStatus('dm', true)).toBe(false);
		expect(colophonState({ channelType: 'dm', hostGaveStatus: false, ownStatus: null })).toBe('checking');
		expect(colophonState({ channelType: 'dm', hostGaveStatus: false, ownStatus: { enabled: false, pendingDefault: true } })).toBe('encryption-pending');
		expect(colophonState({ channelType: 'dm', hostGaveStatus: false, ownStatus: { enabled: true } })).toBe('experimental-encryption');
		expect(colophonState({ channelType: 'group', hostGaveStatus: false, ownStatus: { enabled: false, pendingDefault: false, serverReadableSelected: false } })).toBe('server-readable');
		expect(colophonState({ channelType: 'dm', hostGaveStatus: false, ownStatus: { enabled: false, serverReadableSelected: true, serverReadableAllowedByMe: false } })).toBe('server-readable');
		expect(colophonState({ channelType: 'dm', hostGaveStatus: false, ownStatus: { enabled: false, serverReadableSelected: true, serverReadableAllowedByMe: true } })).toBe('server-readable-by-choice');
	});

	test('the room status outranks a stale encryptSend flag in both directions', () => {
		// A host that still says "encrypt" while the room is pending: pending, never encrypted.
		expect(colophonState({ channelType: 'dm', encryptSend: true, hostGaveStatus: true, hostStatus: { enabled: false, pendingDefault: true } })).toBe('encryption-pending');
		expect(colophonState({ channelType: 'dm', encryptSend: true, hostGaveStatus: true, hostStatus: { enabled: false, serverReadableSelected: false, pendingDefault: false } })).toBe('server-readable');
		// An encrypted room always encrypts on send; a default `false` flag is not a choice.
		expect(colophonState({ channelType: 'group', encryptSend: false, hostGaveStatus: true, hostStatus: { enabled: true } })).toBe('experimental-encryption');
	});

	test('a host status that is still loading (null) is Checking: the composer does not guess from its own read', () => {
		expect(colophonState({ channelType: 'dm', hostGaveStatus: true, hostStatus: null, ownStatus: { enabled: true } })).toBe('checking');
	});

	test('a DM is worded as a conversation, a channel as a channel', () => {
		const dm = resolvePrivacySubject({ input: composerPrivacyInput({ channelType: 'dm', hostGaveStatus: false, ownStatus: { enabled: false, pendingDefault: false, serverReadableSelected: false } }) });
		expect(privacyWords(dm.state, { conversation: dm.conversation }).sentence).toBe('The server operator can read messages in this conversation.');
		const channel = resolvePrivacySubject({ input: composerPrivacyInput({ channelType: 'text', hostGaveStatus: false }) });
		expect(privacyWords(channel.state, { conversation: channel.conversation }).sentence).toBe('The server operator can read messages in this channel.');
		expect(privacyWords(channel.state, { surface: 'phone', conversation: channel.conversation }).sentence).toBe('The operator can read this channel.');
	});

	test('the send path never reads the composer flag: encryption is decided from the server room status per send', () => {
		// ChatComposer: `encryptSend` is declared, defaulted and handed to the colophon only.
		const uses = composer.split('\n').filter((line) => /\bencryptSend\b/.test(line)).map((line) => line.trim());
		expect(uses).toEqual([
			'encryptSend?: boolean;',
			'encryptSend = false,',
			'const privacyInput = $derived(composerPrivacyInput({ channelType: roomType, encryptSend, hostStatus: e2eeStatus, ownStatus, hostGaveStatus }));'
		]);
		for (const call of ['sendChatMessage(draftChannel', 'orchestrateUpload(']) {
			for (const line of composer.split('\n').filter((l) => l.includes(call))) expect(line).not.toMatch(/encrypt|e2ee|ownStatus|privacyInput/i);
		}
		// The channel stream passes no flag of its own (the composer reads DM status itself).
		expect(chat).not.toMatch(/\bencryptSend\b|\be2eeStatus\b/);
		expect(chat).toContain('channelType={currentChannelData?.type ?? null}');
		// messageStore.sendMessage asks the room, every time, and stops instead of sending plaintext
		// into a pending room (encryptMessageForChannel throws) — no options flag can skip it.
		const send = messageStore.slice(messageStore.indexOf('export async function sendMessage('), messageStore.indexOf('const clientMessageId = createClientMessageId(channelId);'));
		expect(send).toContain('if (await shouldAttemptE2eeForChannel(channelId)) {');
		expect(send).toContain('const encrypted = await encryptMessageForChannel(channelId, trimmed, type, options);');
		expect(send).toContain("return { ok: false, reason: 'queue_failed' };");
		expect(send).not.toMatch(/encryptSend|options\.encrypt/);
		const encryptAt = e2ee.indexOf('export async function encryptMessageForChannel(');
		const encrypt = e2ee.slice(encryptAt, e2ee.indexOf('const identity = await ensureE2eeDeviceRegistered();', encryptAt));
		expect(encrypt).toContain('let status = await getE2eeRoomStatus(channelId);');
		expect(encrypt).toContain('if (status.pendingDefault) throw');
	});

	test('the composer reads DM status display-only: no enable, rekey or server-readable choice from here', () => {
		expect(composer).toContain("import { cachedE2eeStatus, refreshE2eeStatus } from '$lib/dm/dmE2eeState';");
		expect(composer).not.toMatch(/prepareNewConversationEncryption|turnOnE2ee|rekeyE2ee|chooseServerReadable|enableE2eeRoom|allowServerReadableRoom/);
		expect(composer).toContain('if (!id || !composerReadsRoomStatus(roomType, hostGaveStatus)) {');
	});
});

describe('retention: its own chip, from the masthead summary for this channel only', () => {
	test('a host value wins; a summary for another channel is never shown', () => {
		expect(composerRetention('24h', { channelId: 'general', retention: 'live' }, 'general')).toBe('24h');
		expect(composerRetention(undefined, { channelId: 'general', retention: 'live' }, 'general')).toBe('live');
		expect(composerRetention(undefined, { channelId: 'introductions', retention: 'live' }, 'general')).toBeNull();
		expect(composerRetention(undefined, null, 'general')).toBeNull();
		expect(composerRetention(undefined, { channelId: 'general', retention: null }, 'general')).toBeNull();
		expect(composerRetention(null, { channelId: 'general', retention: 'live' }, 'general')).toBeNull();
	});

	test('each mounted colophon holds its channel once, so the masthead chip steps aside only while one is shown', () => {
		const first = holdComposerColophon('general');
		const second = holdComposerColophon('general');
		expect(get(composerColophons).general).toBe(2);
		first();
		first();
		expect(get(composerColophons).general).toBe(1);
		second();
		expect(get(composerColophons).general).toBeUndefined();
	});

	test('retention is never folded into the privacy state', () => {
		for (const retention of ['live', '24h', 'forever']) {
			expect(privacyStateFor({ channelType: 'text', policy: { retention } })).toBe('server-readable');
		}
	});
});

describe('the field names its room (chat#9)', () => {
	const t = (key: string, options?: { values?: Record<string, string> }) => {
		const templates: Record<string, string> = {
			'chat.compose.placeholder': 'Write a message',
			'chat.compose.placeholder_channel': 'Message #{channel}',
			'chat.compose.placeholder_dm': 'Message {name}'
		};
		return (templates[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => options?.values?.[name] ?? '');
	};

	test('"Message #general", "Message Theo Park"; no keyboard manual, no "..."', () => {
		expect(composerFieldLabel(t, { name: 'general', conversation: false })).toBe('Message #general');
		expect(composerFieldLabel(t, { name: '#general', conversation: false })).toBe('Message #general');
		expect(composerFieldLabel(t, { name: 'Theo Park', conversation: true })).toBe('Message Theo Park');
		expect(composerFieldLabel(t, { name: null, conversation: false })).toBe('Write a message');
	});

	test('the popover Room fact: "#general · Common Ground", or the conversation name', () => {
		expect(composerRoomFact({ name: 'general', conversation: false, community: 'Common Ground' })).toBe('#general · Common Ground');
		expect(composerRoomFact({ name: 'general', conversation: false })).toBe('#general');
		expect(composerRoomFact({ name: 'Theo Park', conversation: true, community: 'Common Ground' })).toBe('Theo Park');
		expect(composerRoomFact({ name: '', conversation: false })).toBeNull();
	});
});

describe('ChatComposer markup (§7.20)', () => {
	test('the colophon is the PrivacyBadge, with the newline hint after it; no privacy copy of its own', () => {
		expect(composer).toContain('<PrivacyBadge variant="colophon" input={privacyInput} room={roomFact} retention={keptSource} />');
		expect(composer).toContain("{$_('chat.compose.newline_hint')}");
		expect(composer).toContain('const newlineHintShown = $derived(isTextareaFocused && messageInput.length === 0);');
		for (const retired of ['End-to-end encrypted', 'Encrypted · experimental', "'Server-readable'", 'composer-e2ee', '◇', '◆', '🔒', '⚠']) {
			expect(composer).not.toContain(retired);
		}
	});

	test('the textarea is named by its room and the keys are registry icons (no "+" glyph)', () => {
		expect(composer).toContain('placeholder={fieldLabel} aria-label={fieldLabel}');
		expect(composer).not.toContain("'Message...'");
		expect(composer).not.toContain('<span aria-hidden="true">+</span>');
		expect(composer).not.toMatch(/<svg\b/);
		for (const name of ['clip', 'smile', 'send']) expect(composer).toContain(`<Icon name="${name}" />`);
	});

	test('send is a quiet hairline key while empty (aria-disabled, still focusable) and ink with text', () => {
		const send = composer.slice(composer.indexOf('class="w-ibtn composer__send"'), composer.indexOf('<Icon name="send" />'));
		expect(send).toContain('class:composer__send--ready={sendReady}');
		expect(send).toContain('aria-disabled={!sendReady}');
		expect(send).not.toMatch(/(?<![-\w])disabled=\{/);
	});

	test('the field is the toast anchor, and nothing uses the retired legacy classes', () => {
		expect(composer).toContain('<div class="composer__field" data-toast-anchor>');
		for (const legacy of ['input-wrapper', 'input-container', 'input-icon-button', 'send-button', 'media-menu', 'add-button']) {
			expect(composer).not.toContain(legacy);
		}
	});
});

describe('composer CSS (roles only, no override layers)', () => {
	const skin = read('../../../styles/surfaces/composer.css');
	const legacy = read('../../../styles/surfaces/chat-legacy.css');
	const retired = read('../../../styles/components/chat-composer.css');
	const upload = read('../../../styles/components/chat-upload.css');
	const compression = read('../../../styles/components/chat-compression.css');
	const rulesOf = (css: string) => stripAll(css, /\/\*[\s\S]*?\*\//g);

	test('no !important, no raw colors, no legacy tokens', () => {
		for (const css of [skin, upload, compression]) {
			const body = rulesOf(css);
			expect(body).not.toContain('!important');
			expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])(?:white|black)(?![-\w])/i);
			expect(body).not.toMatch(/var\(--(surface|text|accent-primary|accent-secondary|border|color|shadow)-|var\(--accent-rgb|var\(--radius-full/);
			expect(body).not.toMatch(/transition:\s*all/);
		}
	});

	test('the field: 48px on --w-lift, a line-strong edge, radius-lg, --w-shadow-1; focus is accent + ring', () => {
		const body = rulesOf(skin);
		const field = body.slice(body.indexOf('.composer .composer__field {'), body.indexOf('}', body.indexOf('.composer .composer__field {')));
		for (const decl of ['min-height: 48px;', 'border: var(--w-bw) solid var(--w-line-strong);', 'border-radius: var(--radius-lg);', 'background: var(--w-lift);', 'box-shadow: var(--w-shadow-1);']) {
			expect(field).toContain(decl);
		}
		expect(body).toContain('box-shadow: var(--w-ring), var(--w-shadow-1);');
		// Avatar column → page edge, from the stream's own metrics (D20).
		expect(body).toContain('--composer-lead: calc(var(--w-gutter) - 8px + 52px * var(--w-fs) + 14px);');
		expect(body).toContain('--composer-page: calc(36px + 14px + var(--w-measure));');
		expect(body).toContain('min-height: var(--w-foot);');
	});

	test('the hint gives way to the badge and is never cut mid-word', () => {
		const body = rulesOf(skin);
		expect(body).toContain('.composer .composer__colophon > .privacy-badge {\n\tflex: 0 0 auto;\n\tmax-width: 100%;\n}');
		const hint = body.slice(body.indexOf('.composer .composer__hint {'), body.indexOf('}', body.indexOf('.composer .composer__hint {')));
		for (const decl of ['flex: 0 1 auto;', 'min-width: 0;', 'overflow: hidden;', 'flex-wrap: wrap;', 'visibility: hidden;']) expect(hint).toContain(decl);
		expect(body).not.toMatch(/composer__colophon[^{]*\{[^}]*height:\s*\d/);
	});

	test('the held !important composer chrome is retired and the legacy composer sheet is empty', () => {
		const legacyRules = rulesOf(legacy);
		expect(legacyRules).not.toContain('.input-wrapper .input-container');
		expect(legacyRules).not.toMatch(/\.composer\b/);
		expect(rulesOf(retired).trim()).toBe('');
	});
});
