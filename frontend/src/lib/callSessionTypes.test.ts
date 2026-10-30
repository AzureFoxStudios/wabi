import { describe, expect, it } from 'bun:test';
import en from './i18n/locales/en.json';
import {
	callStateWord,
	callsSummary,
	sessionBadgeLabel,
	sessionState,
	voiceStatusLine,
	type CallCopy,
	type CallSession
} from './callSessionTypes';

/**
 * The words the call surfaces use (design contract §7.26, §8.1 item 7, §8.5): one vocabulary for
 * the Calls cards, the companion rows and the sidebar status row. "Muted" means a muted mic only;
 * a call you do not hear is "Silent" (critique voice#7: mute meant three things on one screen).
 */

/** Resolves a key against the shipped English pack, like `$_` does at runtime. */
const t: CallCopy = (key, values = {}) => {
	const template = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
	if (typeof template !== 'string') throw new Error(`missing locale key ${key}`);
	return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
};

let clock = 1;
function session(id: string, patch: Partial<CallSession> = {}): CallSession {
	return {
		id,
		channelId: id,
		name: id,
		kind: 'channel',
		direction: 'listen',
		focus: 'background',
		volume: 100,
		muted: false,
		lifecycle: 'connected',
		transport: null,
		participants: [],
		spatialSeats: {},
		joinedAt: clock++,
		lastActivityAt: 0,
		...patch
	};
}

const names: Record<string, string> = { lounge: 'Studio lounge', cowork: 'Quiet coworking', listen: 'Listening room' };
const nameOf = (s: CallSession) => names[s.id] ?? s.id;

describe('sessionBadgeLabel', () => {
	it('says where the mic goes, and never reuses "Muted" for volume 0', () => {
		expect(sessionBadgeLabel('focused')).toBe('Mic here');
		expect(sessionBadgeLabel('background')).toBe('Listening');
		expect(sessionBadgeLabel('silenced')).toBe('Silent');
	});
});

describe('sessionState', () => {
	it('names the mic call, the calls you hear and the calls you silenced', () => {
		expect(sessionState(session('a', { focus: 'focused' })).key).toBe('mic-here');
		expect(sessionState(session('b')).key).toBe('listening');
		expect(sessionState(session('c', { volume: 0 })).key).toBe('silent');
		// The per-call speaker toggle ("Silence this call") is silence too, not a hidden state.
		expect(sessionState(session('d', { muted: true })).key).toBe('silent');
	});

	it('reads "Muted" on the mic call only while the microphone is muted', () => {
		expect(sessionState(session('a', { focus: 'focused' }), { micMuted: true })).toMatchObject({ key: 'muted', icon: 'micOff' });
		expect(sessionState(session('b'), { micMuted: true }).key).toBe('listening');
	});

	it('puts the connection first: a joining or dropped call carries no audio yet', () => {
		expect(sessionState(session('a', { focus: 'focused', lifecycle: 'joining' })).key).toBe('joining');
		expect(sessionState(session('a', { lifecycle: 'reconnecting' })).key).toBe('reconnecting');
		expect(sessionState(session('a', { lifecycle: 'failed' })).key).toBe('lost');
	});

	it('words come from the locale when a key exists, with matching English', () => {
		for (const s of [session('a', { focus: 'focused' }), session('b'), session('c', { volume: 0 }), session('d', { lifecycle: 'joining' })]) {
			const view = sessionState(s);
			expect(callStateWord(view, t)).toBe(view.label);
		}
		expect(callStateWord(sessionState(session('e', { lifecycle: 'reconnecting' })), t)).toBe('Reconnecting…');
	});

	it('never names a transport or a lifecycle enum', () => {
		const words = [
			session('a', { focus: 'focused', transport: 'wabidb' }),
			session('b', { transport: 'p2p' }),
			session('c', { lifecycle: 'failed' })
		].map((s) => callStateWord(sessionState(s), t));
		for (const word of words) expect(word).not.toMatch(/wabidb|p2p|sfu|connected|failed|idle/i);
	});
});

describe('callsSummary', () => {
	it('counts rooms and says where the mic is', () => {
		const sessions = [session('lounge', { focus: 'focused' }), session('cowork'), session('listen', { volume: 0 })];
		expect(callsSummary(sessions, { nameOf, roomCount: 3, t })).toBe('3 rooms · mic in Studio lounge');
		expect(callsSummary([session('cowork')], { nameOf, roomCount: 3, t })).toBe('1 room');
	});

	it('counts the rooms there are while not in a call, and is empty without rooms', () => {
		expect(callsSummary([], { nameOf, roomCount: 3, t })).toBe('3 rooms');
		expect(callsSummary([], { nameOf, roomCount: 1, t })).toBe('1 room');
		expect(callsSummary([], { nameOf, roomCount: 0, t })).toBe('');
	});
});

describe('voiceStatusLine', () => {
	it('names the mic room and how many more you hear', () => {
		const status = voiceStatusLine([session('cowork'), session('lounge', { focus: 'focused' }), session('listen')], { t });
		expect(status?.session.id).toBe('lounge');
		expect(status?.line).toBe('Mic here · listening to 2 more');
		expect(voiceStatusLine([session('lounge', { focus: 'focused' })], { t })?.line).toBe('Mic here');
	});

	it('says Muted when the microphone is muted', () => {
		expect(voiceStatusLine([session('lounge', { focus: 'focused' }), session('cowork')], { micMuted: true, t })?.line).toBe(
			'Muted · listening to 1 more'
		);
	});

	it('listens only when the mic is in a direct call or nowhere', () => {
		const status = voiceStatusLine([session('cowork'), session('listen'), session('dm', { kind: 'direct', focus: 'focused' })], { t });
		expect(status?.session.id).toBe('cowork');
		expect(status?.line).toBe('Listening · 2 rooms');
	});

	it('shows connecting instead of a raw lifecycle, and nothing outside a voice room', () => {
		expect(voiceStatusLine([session('lounge', { focus: 'focused', lifecycle: 'joining' })], { t })).toMatchObject({ line: 'Connecting…', pending: true });
		expect(voiceStatusLine([session('lounge', { focus: 'focused', lifecycle: 'failed' })], { t })?.line).toBe('Connection trouble');
		expect(voiceStatusLine([], { t })).toBeNull();
		expect(voiceStatusLine([session('dm', { kind: 'direct', focus: 'focused' })], { t })).toBeNull();
	});
});
