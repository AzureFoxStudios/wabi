import { describe, expect, it } from 'bun:test';
import en from './i18n/locales/en.json';
import {
	callStateWord,
	callsSummary,
	focusedSession,
	micGoesTo,
	sessionBadgeLabel,
	sessionSilenced,
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

/** The call your mic goes to, the way calling_impl_core registers a primary join. */
const micRoom = { focus: 'focused', direction: 'transmit' } as const;

describe('micGoesTo', () => {
	it('follows the audio path: the focused call that transmits, never focus alone', () => {
		expect(micGoesTo(session('a', micRoom))).toBe(true);
		// A Listen join (or a room Authority admission keeps listen-only) is registered as the first,
		// focused session with direction 'listen': the mic does not go there (review: w1-calls major 2).
		expect(micGoesTo(session('b', { focus: 'focused', direction: 'listen' }))).toBe(false);
		expect(micGoesTo(session('c', { direction: 'transmit' }))).toBe(false);
	});

	it('"All rooms I hear" sends the mic to every call you are in', () => {
		expect(micGoesTo(session('b'), { transmitMode: 'all-listening' })).toBe(true);
		expect(micGoesTo(session('c', { volume: 0 }), { transmitMode: 'all-listening' })).toBe(true);
	});
});

describe('sessionState', () => {
	it('names the mic call, the calls you hear and the calls you silenced', () => {
		expect(sessionState(session('a', micRoom)).key).toBe('mic-here');
		expect(sessionState(session('b')).key).toBe('listening');
		expect(sessionState(session('c', { volume: 0 })).key).toBe('silent');
		// The per-call speaker toggle ("Silence this call") is silence too, not a hidden state.
		expect(sessionState(session('d', { muted: true })).key).toBe('silent');
	});

	it('a focused listen-only call reads Listening, never Mic here', () => {
		const listenOnly = session('a', { focus: 'focused', direction: 'listen' });
		expect(sessionState(listenOnly).key).toBe('listening');
		expect(sessionState(listenOnly).hint).toContain('Your mic does not go here');
		expect(sessionState({ ...listenOnly, volume: 0 }).key).toBe('silent');
	});

	it('reads "Muted" on the mic call only while the microphone is muted', () => {
		expect(sessionState(session('a', micRoom), { micMuted: true })).toMatchObject({ key: 'muted', icon: 'micOff' });
		expect(sessionState(session('b'), { micMuted: true }).key).toBe('listening');
	});

	it('"All rooms I hear": every connected room reads Mic here, with a hint that says so', () => {
		const audio = { transmitMode: 'all-listening' } as const;
		const states = [session('a', micRoom), session('b'), session('c', { volume: 0 })].map((s) => sessionState(s, audio));
		expect(states.map((state) => state.key)).toEqual(['mic-here', 'mic-here', 'mic-here']);
		for (const state of states) expect(state.hint).toBe('Your mic goes to every room you hear.');
		expect(sessionState(session('b'), { ...audio, micMuted: true })).toMatchObject({ key: 'muted', hint: 'Your mic goes to every room you hear. It is muted.' });
		// Still joining: the connection comes first.
		expect(sessionState(session('d', { lifecycle: 'joining' }), audio).key).toBe('joining');
	});

	it('while deafened no call reads Listening; the mic call still says the mic goes there', () => {
		expect(sessionState(session('b'), { deafened: true })).toMatchObject({ key: 'silent' });
		expect(sessionState(session('b'), { deafened: true }).hint).toContain('Deafen');
		expect(sessionState(session('a', micRoom), { deafened: true, micMuted: true }).key).toBe('muted');
	});

	it('puts the connection first: a joining or dropped call carries no audio yet', () => {
		expect(sessionState(session('a', { ...micRoom, lifecycle: 'joining' })).key).toBe('joining');
		expect(sessionState(session('a', { lifecycle: 'reconnecting' })).key).toBe('reconnecting');
		expect(sessionState(session('a', { lifecycle: 'failed' })).key).toBe('lost');
	});

	it('words come from the locale when a key exists, with matching English', () => {
		for (const s of [session('a', micRoom), session('b'), session('c', { volume: 0 }), session('d', { lifecycle: 'joining' })]) {
			const view = sessionState(s);
			expect(callStateWord(view, t)).toBe(view.label);
		}
		expect(callStateWord(sessionState(session('e', { lifecycle: 'reconnecting' })), t)).toBe('Reconnecting…');
	});

	it('never names a transport or a lifecycle enum', () => {
		const words = [
			session('a', { ...micRoom, transport: 'wabidb' }),
			session('b', { transport: 'p2p' }),
			session('c', { lifecycle: 'failed' })
		].map((s) => callStateWord(sessionState(s), t));
		for (const word of words) expect(word).not.toMatch(/wabidb|p2p|sfu|connected|failed|idle/i);
	});
});

describe('sessionSilenced', () => {
	it('is one silence: the speaker toggle or a volume of 0', () => {
		expect(sessionSilenced(session('a', { muted: true }))).toBe(true);
		expect(sessionSilenced(session('a', { volume: 0 }))).toBe(true);
		expect(sessionSilenced(session('a', { volume: 35 }))).toBe(false);
	});
});

describe('focusedSession', () => {
	it('is the one call the mic goes to, not the focused listen-only call', () => {
		expect(focusedSession([session('a', { focus: 'focused', direction: 'listen' }), session('b')])).toBeNull();
		expect(focusedSession([session('a', micRoom), session('b')])?.id).toBe('a');
		expect(focusedSession([session('a', micRoom), session('b')], { transmitMode: 'all-listening' })).toBeNull();
	});
});

describe('callsSummary', () => {
	it('counts the rooms you are in out of the rooms there are, and says where the mic is', () => {
		const sessions = [session('lounge', micRoom), session('cowork'), session('listen', { volume: 0 })];
		expect(callsSummary(sessions, { nameOf, roomCount: 3, t })).toBe('In 3 rooms · mic in Studio lounge');
		expect(callsSummary([session('lounge', micRoom)], { nameOf, roomCount: 3, t })).toBe('In 1 of 3 rooms · mic in Studio lounge');
	});

	it('says listening only when the mic goes to no call', () => {
		expect(callsSummary([session('cowork')], { nameOf, roomCount: 3, t })).toBe('In 1 of 3 rooms · listening only');
		expect(callsSummary([session('lounge', { focus: 'focused', direction: 'listen' })], { nameOf, roomCount: 1, t })).toBe(
			'In 1 room · listening only'
		);
	});

	it('"All rooms I hear" says the mic is in all of them', () => {
		const sessions = [session('lounge', micRoom), session('cowork'), session('listen', { volume: 0 })];
		expect(callsSummary(sessions, { nameOf, roomCount: 3, t, audio: { transmitMode: 'all-listening' } })).toBe('In 3 rooms · mic in all 3 rooms');
	});

	it('counts direct and group calls as calls, not rooms', () => {
		const dm = session('dm', { kind: 'direct', channelId: null, ...micRoom });
		const names2 = (s: CallSession) => (s.id === 'dm' ? 'Mira' : nameOf(s));
		expect(callsSummary([dm], { nameOf: names2, roomCount: 3, t })).toBe('1 call · mic in the call with Mira');
		expect(callsSummary([dm, session('cowork')], { nameOf: names2, roomCount: 3, t })).toBe('In 1 of 3 rooms · 1 call · mic in the call with Mira');
	});

	it('counts the rooms there are while not in a call, and is empty without rooms', () => {
		expect(callsSummary([], { nameOf, roomCount: 3, t })).toBe('3 rooms');
		expect(callsSummary([], { nameOf, roomCount: 1, t })).toBe('1 room');
		expect(callsSummary([], { nameOf, roomCount: 0, t })).toBe('');
	});
});

describe('voiceStatusLine', () => {
	it('names the mic room and how many more you hear', () => {
		const status = voiceStatusLine([session('cowork'), session('lounge', micRoom), session('listen')], { t });
		expect(status?.session.id).toBe('lounge');
		expect(status?.line).toBe('Mic here · listening to 2 more');
		expect(voiceStatusLine([session('lounge', micRoom)], { t })?.line).toBe('Mic here');
	});

	it('says Muted when the microphone is muted', () => {
		expect(voiceStatusLine([session('lounge', micRoom), session('cowork')], { micMuted: true, t })?.line).toBe('Muted · listening to 1 more');
	});

	it('a focused listen-only room reads Listening, never Mic here (the Listen action)', () => {
		const status = voiceStatusLine([session('lounge', { focus: 'focused', direction: 'listen' })], { t });
		expect(status?.session.id).toBe('lounge');
		expect(status?.line).toBe('Listening');
	});

	it('"All rooms I hear" says the mic goes to every room', () => {
		const rooms = [session('lounge', micRoom), session('cowork'), session('listen')];
		expect(voiceStatusLine(rooms, { t, transmitMode: 'all-listening' })?.line).toBe('Mic in all rooms I hear');
		expect(voiceStatusLine(rooms, { t, transmitMode: 'all-listening', micMuted: true })?.line).toBe('Muted · mic in all rooms I hear');
		expect(voiceStatusLine([session('lounge', micRoom)], { t, transmitMode: 'all-listening' })?.line).toBe('Mic here');
	});

	it('"listening to N more" counts only the rooms you hear, never a silenced one', () => {
		expect(voiceStatusLine([session('lounge', micRoom), session('cowork'), session('listen', { volume: 0 })], { t })?.line).toBe(
			'Mic here · listening to 1 more'
		);
		expect(voiceStatusLine([session('lounge', micRoom), session('cowork', { muted: true }), session('listen', { volume: 0 })], { t })?.line).toBe(
			'Mic here · 2 silent rooms'
		);
		expect(voiceStatusLine([session('cowork', { muted: true }), session('listen', { volume: 0 })], { t })?.line).toBe('Silent · 2 rooms');
	});

	it('with no mic room, "Listening · N rooms" counts only the rooms you hear (w1-calls recheck)', () => {
		expect(voiceStatusLine([session('cowork'), session('listen'), session('quiet', { volume: 0 })], { t })?.line).toBe('Listening · 2 rooms · 1 silent');
		expect(voiceStatusLine([session('cowork'), session('quiet', { muted: true })], { t })?.line).toBe('Listening · 1 room · 1 silent');
		expect(voiceStatusLine([session('cowork'), session('listen')], { t })?.line).toBe('Listening · 2 rooms');
	});

	it('does not say listening while deafened', () => {
		expect(voiceStatusLine([session('lounge', micRoom), session('cowork'), session('listen')], { t, deafened: true })?.line).toBe('Mic here · 2 more rooms');
		expect(voiceStatusLine([session('cowork'), session('listen')], { t, deafened: true })?.line).toBe('Deafened · 2 rooms');
	});

	it('listens only when the mic is in a direct call or nowhere', () => {
		const status = voiceStatusLine([session('cowork'), session('listen'), session('dm', { kind: 'direct', ...micRoom })], { t });
		expect(status?.session.id).toBe('cowork');
		expect(status?.line).toBe('Listening · 2 rooms');
	});

	it('shows connecting instead of a raw lifecycle, and nothing outside a voice room', () => {
		expect(voiceStatusLine([session('lounge', { ...micRoom, lifecycle: 'joining' })], { t })).toMatchObject({ line: 'Connecting…', pending: true });
		expect(voiceStatusLine([session('lounge', { ...micRoom, lifecycle: 'failed' })], { t })?.line).toBe('Connection trouble');
		expect(voiceStatusLine([], { t })).toBeNull();
		expect(voiceStatusLine([session('dm', { kind: 'direct', ...micRoom })], { t })).toBeNull();
	});
});
