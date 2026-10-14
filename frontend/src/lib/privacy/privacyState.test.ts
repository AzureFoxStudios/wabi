import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DMPrivacyMode } from '../dmPrivacyMode';
import {
	PRIVACY_EXPLANATION,
	PRIVACY_LINK_HREF,
	PRIVACY_LINK_LABEL,
	PRIVACY_STATES,
	isPrivacyState,
	privacyFacts,
	privacyPopoverBody,
	privacyStateFor,
	privacyWords,
	retentionChipVisible,
	retentionFact,
	retentionLabel,
	retentionTitle,
	type PrivacyPolicy,
	type PrivacyState
} from './privacyState';

/** §7.20 table and §9.2, verbatim (channel wording; DMs say "this conversation"). */
const SPEC: Record<PrivacyState, { glyph: string; word: string; desktop: string; phone: string; phoneWord?: string }> = {
	'server-readable': {
		glyph: 'lockOpen',
		word: 'Server-readable',
		desktop: 'The server operator can read messages in this channel.',
		phone: 'The operator can read this channel.'
	},
	'server-readable-by-choice': {
		glyph: 'lockOpen',
		word: 'Server-readable by choice',
		desktop: 'You chose to send without encryption in this conversation.',
		phone: 'You chose server-readable.'
	},
	'encryption-pending': {
		glyph: 'hourglass',
		word: 'Encryption pending',
		desktop: "Messages wait for everyone's devices. You can choose to send server-readable instead.",
		phone: 'Waiting for devices.'
	},
	'experimental-encryption': {
		glyph: 'lock',
		word: 'Experimental encryption',
		desktop: 'Not independently verified.',
		phone: 'Not independently verified.'
	},
	checking: { glyph: 'hourglass', word: 'Checking privacy…', desktop: '', phone: '', phoneWord: 'Checking…' }
};

const SHARED_TYPES = ['text', 'voice', 'forum', 'wiki', 'gallery', 'lore', 'planning', 'stage', 'announcement', 'mystery'];

/** Every flag a stale or hostile policy could carry, alone and together. */
const POLICIES: (PrivacyPolicy | null | undefined)[] = [
	undefined,
	null,
	{},
	{ enabled: true },
	{ e2ee: true },
	{ confidentiality: 'experimental_e2ee' },
	{ pendingDefault: true },
	{ serverReadableSelected: true, serverReadableAllowedByMe: true },
	{ enabled: true, e2ee: true, confidentiality: 'experimental_e2ee', privateConversation: true },
	{ retention: 'live' },
	{ retention: 'forever' }
];

describe('privacyStateFor', () => {
	test('channel types other than dm and group are always Server-readable', () => {
		for (const channelType of SHARED_TYPES) {
			for (const policy of POLICIES) {
				for (const encryptSend of [undefined, null, true, false]) {
					expect(privacyStateFor({ channelType, policy, encryptSend })).toBe('server-readable');
					expect(privacyStateFor({ channel: { type: channelType }, policy, encryptSend })).toBe('server-readable');
				}
			}
		}
	});

	test('derives every DM and group state from the authenticated room status', () => {
		for (const channelType of ['dm', 'group']) {
			const at = (policy: PrivacyPolicy | null, encryptSend?: boolean) => privacyStateFor({ channelType, policy, encryptSend });
			expect(at({ enabled: false, pendingDefault: true, serverReadableSelected: false })).toBe('encryption-pending');
			expect(at({ enabled: true, pendingDefault: false, serverReadableSelected: false })).toBe('experimental-encryption');
			expect(at({ enabled: true }, true)).toBe('experimental-encryption');
			// The sender turned encryption off in a room whose policy is encrypted.
			expect(at({ enabled: true }, false)).toBe('server-readable-by-choice');
			// This member made the server-readable choice.
			expect(at({ enabled: false, serverReadableSelected: true, serverReadableAllowedByMe: true })).toBe(
				'server-readable-by-choice'
			);
			// Someone else chose it: the room is server-readable, this member has not chosen anything.
			expect(at({ enabled: false, serverReadableSelected: true, serverReadableAllowedByMe: false })).toBe('server-readable');
			// An older room without the new-room policy.
			expect(at({ enabled: false, pendingDefault: false, serverReadableSelected: false })).toBe('server-readable');
			// The member summary's own answer for a shared room.
			expect(at({ privateConversation: false, e2ee: false })).toBe('server-readable');
			expect(at({ e2ee: true, privateConversation: true, confidentiality: 'experimental_e2ee' })).toBe('experimental-encryption');
		}
	});

	test('is Checking until the policy is known, and never invents encryption', () => {
		expect(privacyStateFor()).toBe('checking');
		expect(privacyStateFor({ channelType: 'dm' })).toBe('checking');
		expect(privacyStateFor({ channelType: 'group', policy: null })).toBe('checking');
		// A summary alone cannot tell an older plaintext room from a pending one.
		expect(privacyStateFor({ channelType: 'dm', policy: { e2ee: false, privateConversation: true } })).toBe('checking');
		expect(privacyStateFor({ channelType: 'dm', policy: { confidentiality: 'server_readable' } })).toBe('checking');
		// Unknown channel kinds stay fail-closed: no claim either way without a policy.
		expect(privacyStateFor({ channelType: null })).toBe('checking');
		expect(privacyStateFor({ channelType: '' })).toBe('checking');
		// The composer only encrypts once the room said so; that is evidence.
		expect(privacyStateFor({ channelType: 'dm', encryptSend: true })).toBe('experimental-encryption');
		expect(privacyStateFor({ channelType: 'dm', encryptSend: false })).toBe('checking');
	});

	test('retention is never evidence of confidentiality', () => {
		for (const retention of ['live', '5s', '24h', '7d', 'forever']) {
			expect(privacyStateFor({ channelType: 'text', policy: { retention } })).toBe('server-readable');
			expect(privacyStateFor({ channelType: 'dm', policy: { retention } })).toBe('checking');
			expect(privacyStateFor({ channelType: 'dm', policy: { retention, enabled: false } })).toBe('server-readable');
		}
	});

	test('the device-local DM mode preference never changes the state', () => {
		const modes: (DMPrivacyMode | null | undefined)[] = [undefined, null, 'open', 'sealed', 'private'];
		const cases: [string, PrivacyPolicy | null][] = [
			['dm', null],
			['dm', { enabled: false }],
			['dm', { pendingDefault: true }],
			['group', { enabled: true }],
			['text', null]
		];
		for (const [channelType, policy] of cases) {
			const expected = privacyStateFor({ channelType, policy });
			for (const dmMode of modes) expect(privacyStateFor({ channelType, policy, dmMode })).toBe(expected);
		}
	});

	test('only returns the five known states', () => {
		const seen = new Set<PrivacyState>();
		for (const channelType of [...SHARED_TYPES, 'dm', 'group', null, undefined]) {
			for (const policy of POLICIES) {
				for (const encryptSend of [undefined, true, false]) seen.add(privacyStateFor({ channelType, policy, encryptSend }));
			}
		}
		for (const state of seen) expect(PRIVACY_STATES).toContain(state);
		expect(isPrivacyState('server-readable')).toBe(true);
		expect(isPrivacyState('secure')).toBe(false);
		expect(isPrivacyState(undefined)).toBe(false);
	});
});

describe('privacyWords', () => {
	test('every state matches the §7.20 table on desktop and phone', () => {
		for (const state of PRIVACY_STATES) {
			const spec = SPEC[state];
			const desktop = privacyWords(state);
			expect(desktop).toEqual({
				state,
				glyph: spec.glyph as never,
				word: spec.word,
				sentence: spec.desktop,
				title: spec.desktop ? `${spec.word} · ${spec.desktop}` : spec.word
			});
			const phone = privacyWords(state, { surface: 'phone' });
			expect(phone.word).toBe(spec.phoneWord ?? spec.word);
			expect(phone.sentence).toBe(spec.phone);
			expect(phone.glyph).toBe(desktop.glyph as never);
			// A short phone label keeps the full words in its title.
			expect(phone.title).toBe(desktop.title);
		}
	});

	test('the exact composer colophon words', () => {
		expect(privacyWords('server-readable').word).toBe('Server-readable');
		expect(privacyWords('experimental-encryption').word).toBe('Experimental encryption');
		expect(privacyWords('experimental-encryption').title).toBe('Experimental encryption · Not independently verified.');
		expect(privacyWords('encryption-pending').title).toBe(
			"Encryption pending · Messages wait for everyone's devices. You can choose to send server-readable instead."
		);
	});

	test('in DMs and groups "this channel" becomes "this conversation"', () => {
		expect(privacyWords('server-readable', { conversation: true }).sentence).toBe(
			'The server operator can read messages in this conversation.'
		);
		expect(privacyWords('server-readable', { conversation: true, surface: 'phone' }).sentence).toBe(
			'The operator can read this conversation.'
		);
		expect(privacyWords('server-readable-by-choice', { conversation: true }).sentence).toBe(SPEC['server-readable-by-choice'].desktop);
	});

	test('the state word is never empty, on any surface', () => {
		for (const state of PRIVACY_STATES) {
			for (const surface of ['desktop', 'phone'] as const) {
				expect(privacyWords(state, { surface }).word.length).toBeGreaterThan(3);
			}
		}
	});

	test('an unknown state reads as Checking, never as encrypted', () => {
		const words = privacyWords('secure' as PrivacyState);
		expect(words.state).toBe('checking');
		expect(words.word).toBe('Checking privacy…');
		expect(privacyPopoverBody('secure' as PrivacyState)).toBe(privacyPopoverBody('checking'));
		expect(privacyFacts('secure' as PrivacyState).at(-1)).toEqual({ term: 'Encryption', value: 'Checking…' });
	});
});

describe('retention', () => {
	test('labels follow §9.2 and never call retention private', () => {
		expect(retentionLabel('forever')).toBe('Kept until someone deletes them');
		expect(retentionLabel('24h')).toBe('Kept 24 hours');
		expect(retentionLabel('1d')).toBe('Kept 24 hours');
		expect(retentionLabel('live')).toBe('Live only · not saved');
		expect(retentionLabel('7d')).toBe('Kept 7 days');
		expect(retentionLabel('1h')).toBe('Kept 1 hour');
		expect(retentionLabel('30s')).toBe('Kept 30 seconds');
		expect(retentionLabel('5m')).toBe('Kept 5 minutes');
		expect(retentionLabel({ retention: '24h' })).toBe('Kept 24 hours');
	});

	test('a missing or corrupt policy is null, never a guessed default', () => {
		for (const value of [undefined, null, '', 'soon', '0s', '366d', {}, { retention: null }, { retention: 'forever!' }]) {
			expect(retentionLabel(value as PrivacyPolicy | string | null | undefined)).toBeNull();
			expect(retentionFact(value as PrivacyPolicy | string | null | undefined)).toBeNull();
			expect(retentionTitle(value as PrivacyPolicy | string | null | undefined)).toBeNull();
			expect(retentionChipVisible(value as PrivacyPolicy | string | null | undefined)).toBe(false);
		}
	});

	test('the colophon chip shows only when messages are not kept until deleted', () => {
		expect(retentionChipVisible('forever')).toBe(false);
		expect(retentionChipVisible('24h')).toBe(true);
		expect(retentionChipVisible('live')).toBe(true);
		expect(retentionChipVisible({ retention: '7d' })).toBe(true);
	});

	test('Kept facts and tooltips', () => {
		expect(retentionFact('forever')).toBe('Until someone deletes them');
		expect(retentionFact('24h')).toBe('24 hours');
		expect(retentionFact('live')).toBe('Live only · not saved');
		expect(retentionTitle('live')).toBe(
			'New messages are shown live and not saved. Not saving them does not hide them from the server operator.'
		);
		expect(retentionTitle('24h')).toBe('New messages are kept 24 hours. Earlier messages keep the lifetime they were sent with.');
	});
});

describe('popover', () => {
	test('facts are Room, Kept, Encryption in order, with the §7.20 values', () => {
		expect(privacyFacts('server-readable', { room: '#general · Common Ground', retention: 'forever' })).toEqual([
			{ term: 'Room', value: '#general · Common Ground' },
			{ term: 'Kept', value: 'Until someone deletes them' },
			{ term: 'Encryption', value: 'Only for DMs and groups' }
		]);
		expect(privacyFacts('experimental-encryption', { room: 'Theo Park', retention: { retention: '24h' }, conversation: true })).toEqual([
			{ term: 'Room', value: 'Theo Park' },
			{ term: 'Kept', value: '24 hours' },
			{ term: 'Encryption', value: 'Experimental · not independently verified' }
		]);
		// Facts the caller cannot vouch for are left out rather than guessed.
		expect(privacyFacts('encryption-pending', { room: '  ', retention: null })).toEqual([
			{ term: 'Encryption', value: 'Pending · waiting for devices' }
		]);
		expect(privacyFacts('server-readable', { conversation: true }).at(-1)?.value).toBe('Off in this conversation');
		expect(privacyFacts('server-readable-by-choice').at(-1)?.value).toBe('Off · you chose server-readable');
	});

	test('the body says what the server operator can read', () => {
		expect(privacyPopoverBody('server-readable')).toBe('The server operator can read messages in this channel.');
		expect(privacyPopoverBody('server-readable', { conversation: true })).toBe(
			'The server operator can read messages in this conversation.'
		);
		expect(privacyPopoverBody('encryption-pending')).toBe(SPEC['encryption-pending'].desktop);
		expect(privacyPopoverBody('experimental-encryption')).toContain('The server operator can still see');
		expect(privacyPopoverBody('server-readable-by-choice')).toContain('The server operator can read messages sent this way.');
	});

	test('the explanation and the link are the §9.2 words', () => {
		expect(PRIVACY_EXPLANATION).toBe(
			"New DMs and groups start encryption-pending and use experimental encryption once everyone's devices are ready. Sending server-readable instead needs each sender's choice. The encryption has not been independently verified, and it does not hide everything from the server operator."
		);
		expect(PRIVACY_LINK_LABEL).toBe('How privacy works in Wabi');
		expect(PRIVACY_LINK_HREF).toBe('/privacy');
	});
});

describe('truthful vocabulary (§9.2)', () => {
	function everyOutput(): string[] {
		const out: string[] = [PRIVACY_EXPLANATION, PRIVACY_LINK_LABEL];
		for (const state of PRIVACY_STATES) {
			for (const conversation of [false, true]) {
				for (const surface of ['desktop', 'phone'] as const) {
					const words = privacyWords(state, { surface, conversation });
					out.push(words.word, words.sentence, words.title);
				}
				out.push(privacyPopoverBody(state, { conversation }));
				for (const retention of ['live', '24h', '7d', 'forever']) {
					for (const fact of privacyFacts(state, { conversation, retention, room: '#general' })) out.push(fact.value);
				}
			}
		}
		for (const retention of ['live', '30s', '1h', '24h', '7d', 'forever']) {
			out.push(retentionLabel(retention) ?? '', retentionFact(retention) ?? '', retentionTitle(retention) ?? '');
		}
		return out.filter(Boolean);
	}

	test('no output claims more than the branch can prove', () => {
		for (const text of everyOutput()) {
			expect(text).not.toMatch(/end-to-end/i);
			expect(text).not.toMatch(/e2ee/i);
			expect(text).not.toMatch(/secure/i);
			expect(text).not.toMatch(/\bprivate\b/i);
			expect(text).not.toMatch(/operator-blind/i);
			expect(text).not.toMatch(/stores nothing/i);
			expect(text).not.toMatch(/server-readable by default/i);
			// "verified" only ever appears as "not (been) independently verified".
			expect(text.replace(/\bnot (?:been )?independently verified\b/gi, '')).not.toMatch(/verified/i);
			// "encrypted" never stands without "experimental".
			if (/\bencrypted\b/i.test(text)) expect(text).toMatch(/experimental/i);
		}
	});

	/** Remove every match, repeating until none remain, so a removal never leaves a new match behind. */
	function stripAll(text: string, pattern: RegExp): string {
		let previous;
		do {
			previous = text;
			text = text.replace(pattern, '');
		} while (text !== previous);
		return text;
	}

	/** A component's code and markup, without its comments and styles. */
	function componentCode(name: string): { source: string; code: string } {
		const source = readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), 'utf8');
		let code = stripAll(source, /<!--[\s\S]*?-->/g);
		code = stripAll(code, /<style[\s\S]*?<\/style>/g);
		code = stripAll(code, /\/\*[\s\S]*?\*\//g);
		code = stripAll(code, /^\s*\/\/.*$/gm);
		return { source, code };
	}

	test('the components carry no privacy copy of their own', () => {
		for (const name of ['PrivacyBadge.svelte', 'PrivacyPopover.svelte']) {
			const { source, code: markup } = componentCode(name);
			for (const phrase of ['Server-readable', 'Encryption pending', 'Experimental encryption', 'independently verified', 'Kept ', 'Live only']) {
				expect(markup).not.toContain(phrase);
			}
			expect(markup).not.toMatch(/end-to-end|e2ee|secure/i);
			// Colors only through roles (§5).
			expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		}
	});

	test('the colophon and the header chip open the popover as a dialog', () => {
		const badge = componentCode('PrivacyBadge.svelte').code;
		expect(badge.match(/aria-haspopup="dialog"/g)?.length).toBe(2);
		const popover = componentCode('PrivacyPopover.svelte').code;
		expect(popover).toContain('role="dialog"');
		expect(popover).toContain('aria-labelledby={titleId}');
	});
});
