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
const pane = code(read('./ChatMessagesPane.svelte'));
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

	test('a DM in the desktop channel stream leaves retention to the masthead seal chip (said once)', () => {
		const summary = { channelId: 'dm-1', retention: '24h' };
		expect(composerRetention(undefined, summary, 'dm-1', { mastheadSaysIt: true })).toBeNull();
		expect(composerRetention(undefined, summary, 'dm-1', { mastheadSaysIt: false })).toBe('24h');
		// A host's own value is its statement and always shows.
		expect(composerRetention('live', summary, 'dm-1', { mastheadSaysIt: true })).toBe('live');
		// The masthead shows the DM seal chip with retention only on desktop (ChatHeader `!phone`),
		// and only for the stage's own conversation (no host-given status).
		expect(composer).toContain('const mastheadSaysRetention = $derived(inConversation && !hostGaveStatus && !$isMobile);');
		expect(composer).toContain('composerRetention(retention, $stagePrivacySummary, effectiveChannel, { mastheadSaysIt: mastheadSaysRetention })');
		const header = code(read('./ChatHeader.svelte'));
		const dmSeal = header.slice(header.indexOf('{#if !phone}\n\t\t\t<PrivacyBadge\n\t\t\t\tvariant="popover-trigger"'));
		expect(dmSeal.slice(0, 400)).toContain('showRetention');
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

	test('a DM in the stream keeps its status fresh through the watcher (poll, socket, focus, after a send)', () => {
		expect(composer).toContain("import { watchComposerRoomStatus, type RoomStatusSocket, type RoomStatusWatch } from './composerRoomStatus';");
		const effect = composer.slice(composer.indexOf('if (!id || !composerReadsRoomStatus(roomType, hostGaveStatus)) {'), composer.indexOf('function recheckRoomPrivacy(): void {'));
		for (const part of ['watchComposerRoomStatus<E2eeRoomStatus>({', 'refresh: refreshE2eeStatus,', 'cached: cachedE2eeStatus,', 'socket: () => getSocket()', 'focusTarget:', 'watch.dispose();']) {
			expect(effect).toContain(part);
		}
		// No one-shot socket capture left behind.
		expect(composer).not.toMatch(/const sock = getSocket\(\)/);
		// The field asks before the member writes; every send path asks after it hands off.
		expect(composer).toContain('onfocus={() => { isTextareaFocused = true; composerVisible = true; recheckRoomPrivacy(); }}');
		expect(composer.match(/finally \{ transaction\.finish\(\); recheckRoomPrivacy\(\); \}/g)?.length).toBe(3);
	});

	test('upload progress announces its words once; the percentage is a progressbar value, not live', () => {
		const progress = composer.slice(composer.indexOf('<div class="composer__progress">'), composer.indexOf('<input type="file"'));
		expect(progress).not.toContain('aria-live');
		expect(progress).toContain('<span role="status">{uploadStatusLabel');
		expect(progress).toContain('<span class="composer__progress-count" aria-hidden="true">{uploadProgress}%</span>');
		expect(progress).toContain('role="progressbar"');
		expect(progress).toContain('aria-valuenow={uploadProgress}');
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

	test('the emoji container is an anchor, not a frame: the panel sizes it and is never clipped (r1 blocker)', () => {
		const body = rulesOf(skin);
		const block = (selector: string) => {
			const at = body.indexOf(`${selector} {`);
			expect(at).toBeGreaterThan(-1);
			return body.slice(at, body.indexOf('}', at));
		};
		const container = block('.composer .emoji-picker-container');
		for (const frame of ['overflow', 'max-height', 'border', 'background', 'box-shadow']) expect(container).not.toContain(frame);
		expect(container).toContain('right: 0;');
		// The panel sits in its anchor's flow on every width (EmojiPicker's own absolute/fixed
		// positioning would collapse the anchor, or cover the field on phones).
		const panel = block('.composer .emoji-picker-container > .emoji-picker');
		for (const decl of ['position: relative;', 'inset: auto;', 'width: min(480px, calc(100vw - 24px));']) expect(panel).toContain(decl);
		expect(body).toContain('.composer .emoji-picker-container > :is(.emoji-picker, .emoji-picker-loading),');
		// No rule frames or clips the container anywhere else.
		expect(body).not.toMatch(/emoji-picker-container\s*(,|\{)[^}]*(overflow|\bborder\s*:|max-height|box-shadow)/);
	});

	test('one line keeps the field at 48px for any edge width, and the band at 80px up to 125% text', () => {
		const body = rulesOf(skin);
		expect(body).toContain('--composer-line-box: 34px;');
		expect(body).toContain('min-height: var(--composer-line-box);');
		expect(body).toContain('padding: max(0px, calc((var(--composer-line-box) - 24px * var(--w-fs)) / 2)) 8px max(0px, calc((var(--composer-line-box) - 24px * var(--w-fs)) / 2)) 0;');
		expect(body).toContain('padding: 0 0 max(0px, calc(30px - 24px * var(--w-fs)));');
		// The field's vertical padding gives back what a thicker edge takes: the 34px keys and
		// the 34px line keep the field at 48 (desktop) and the 38px keys at 44 (phone).
		expect(body).toContain('padding: calc(7px - var(--w-bw)) 6px calc(7px - var(--w-bw)) var(--composer-inset);');
		expect(body).toContain('padding: calc(3px - var(--w-bw)) 2px calc(3px - var(--w-bw)) 14px;');
		for (const bw of [1, 2]) {
			expect(34 + 2 * (7 - bw) + 2 * bw).toBe(48);
			expect(38 + 2 * (3 - bw) + 2 * bw).toBe(44);
		}
		// One line at up to ~140% text still fits the 34px line box.
		for (const fs of [1, 1.25, 1.4]) expect(24 * fs + 2 * Math.max(0, (34 - 24 * fs) / 2)).toBeLessThanOrEqual(34);
		// Band: 48 field + 2 gap + 24*fs colophon + max(0, 30 - 24*fs) = 80 while fs <= 1.25.
		for (const fs of [1, 1.1, 1.25]) expect(48 + 2 + 24 * fs + Math.max(0, 30 - 24 * fs)).toBeCloseTo(80);
		// The textarea keeps the kit's pill scrollbar (scrollbar-width switches Chromium to native bars).
		expect(body.slice(body.indexOf('.composer .composer__input {'), body.indexOf('}', body.indexOf('.composer .composer__input {')))).not.toContain('scrollbar-width');
	});

	test('keys reach 44px under a coarse pointer at every drawn size (34, 36, 38)', () => {
		const body = rulesOf(skin);
		const coarse = body.slice(body.indexOf('@media (pointer: coarse) {'));
		expect(coarse).toContain('inset: -5px;');
		for (const drawn of [34, 36, 38]) expect(drawn + 2 * 5).toBeGreaterThanOrEqual(44);
	});

	test('the upload card rules are scoped to the card, never GalleryChannel (.gallery-header, .gallery-grid)', () => {
		const body = rulesOf(upload);
		const selectors = body.split('{').slice(0, -1).map((chunk) => chunk.split('}').pop()!.trim()).filter((sel) => sel && !sel.startsWith('@') && !/^(from|to)$/.test(sel));
		for (const selector of selectors) {
			for (const part of selector.split(',').map((p) => p.trim())) {
				if (/^\.drag-(overlay|overlay-content|icon|text)$/.test(part)) continue;
				expect(part.startsWith('.file-gallery ')).toBe(true);
			}
		}
	});

	test('the held !important composer chrome is retired and the legacy composer sheet is empty', () => {
		const legacyRules = rulesOf(legacy);
		expect(legacyRules).not.toContain('.input-wrapper .input-container');
		expect(legacyRules).not.toMatch(/\.composer\b/);
		expect(rulesOf(retired).trim()).toBe('');
	});
});

describe('ChatMessagesPane: real states, one announcement each', () => {
	test('a channel still fetching its history shows skeleton rows, not "No messages yet"', () => {
		expect(pane).toContain('$: historyLoading = Boolean(currentChannel && $channelHistoryLoading[currentChannel]);');
		const loading = pane.indexOf('{#if roomEmpty && historyLoading}');
		const empty = pane.indexOf('{:else if roomEmpty}');
		expect(loading).toBeGreaterThan(-1);
		expect(empty).toBeGreaterThan(loading);
		expect(pane.slice(loading, empty)).toContain('<Skeleton variant="message"');
	});

	test('the empty room has one primary action', () => {
		expect(pane).toContain('<button class="w-btn w-btn--primary w-btn--sm" type="button" on:click={focusComposer}>');
	});

	test('the search count is said once; no live region holds a button; the renamed toggle is a plain button', () => {
		const toolbar = pane.slice(pane.indexOf('<div class="search-results-toolbar"'), pane.indexOf('{#key'));
		expect(toolbar).toContain('<div class="search-results-toolbar">');
		expect(toolbar).not.toContain('aria-live');
		expect(toolbar).not.toContain('aria-pressed');
		// Each live region is a span of words.
		for (const region of toolbar.match(/<span[^>]*role="status"[^>]*>[\s\S]*?<\/span>/g) ?? []) expect(region).not.toContain('<button');
		const emptySearch = pane.slice(pane.indexOf('stream-start--search'), pane.indexOf('<MessageList'));
		expect(emptySearch).not.toContain('role="status"');
		expect(emptySearch).not.toContain('chat.search.results_many');
	});

	test('the typing stamp re-inks when the member list arrives (the stores are arguments)', () => {
		expect(pane).toContain('findPerson(visibleTypingUsers[0], $serverMembers as User[], $users as User[])');
	});
});
