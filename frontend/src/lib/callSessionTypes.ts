/**
 * Phase 2 calling overhaul — multi-session call model (2026-08-25).
 *
 * Types for CallSession: ONE record per connected call (voice channel, DM,
 * group), replacing the "one primary + listening[] + bolted-on DM call"
 * model that could not express N concurrent calls with per-call
 * focus/volume/mute (the 3-call FOCUSED/BACKGROUND/SILENCED controller).
 */

export type CallSessionKind = 'channel' | 'direct' | 'group';

/** 'transmit' = we send audio there; 'listen' = receive-only (multi-listen). */
export type CallSessionDirection = 'transmit' | 'listen';

/**
 * Attention state. `silenced` is DERIVED (volume === 0 and not focused) —
 * see sessionBadge(). The stored field is only focused|background so the
 * state machine stays simple and the mockup's three badges remain a pure
 * function of (focus, volume).
 */
export type CallSessionFocus = 'focused' | 'background';

export type CallSessionLifecycle = 'joining' | 'connected' | 'reconnecting' | 'failed' | 'ended';

export interface CallSessionParticipant {
	/** Stable id (user-N); socket id for guests. */
	userId: string;
	username: string;
	isMuted?: boolean;
	isSpeaking?: boolean;
	isListenOnly?: boolean;
}

/** Active transport for this session's media, when connected. */
export type CallSessionTransport = 'wabidb' | 'p2p' | 'sfu' | null;

/** Position in the spatial hearing stage (same space as the p2p engine). */
export interface CallSpatialPosition {
	x: number;
	y: number;
	z: number;
}

export interface CallSession {
	/** Channel id for channels; deterministic session id for DM/group. */
	id: string;
	/** Null for DM sessions that have no channel record. */
	channelId: string | null;
	/** Display name — callers resolve it from the channel list when available. */
	name: string;
	kind: CallSessionKind;
	direction: CallSessionDirection;
	focus: CallSessionFocus;
	/** 0..100 output volume for this call. 0 == silenced. */
	volume: number;
	/** Local output mute for this call (distinct from global deafen). */
	muted: boolean;
	lifecycle: CallSessionLifecycle;
	transport: CallSessionTransport;
	participants: CallSessionParticipant[];
	/**
	 * Personal spatial-hearing seats for this call (userId → position).
	 * Absent users fall back to the auto-circle layout.
	 */
	spatialSeats: Record<string, CallSpatialPosition>;
	joinedAt: number;
	lastActivityAt: number;
}

/** The three-state badge from the voice-view/right-panel mockups. */
export type CallSessionBadge = 'focused' | 'background' | 'silenced';

export function sessionBadge(session: Pick<CallSession, 'focus' | 'volume'>): CallSessionBadge {
	if (session.volume <= 0 && session.focus !== 'focused') return 'silenced';
	return session.focus;
}

/**
 * Plain-language badge copy (design contract §7.26): the internal terms never reach the UI.
 * The focused session is where your mic goes ("Mic here"); the others are "Listening", or
 * "Silent" at volume 0. "Muted" is kept for a muted microphone only (People, the sidebar
 * roster, the Mic toggle), so one word never means two things.
 */
export function sessionBadgeLabel(badge: CallSessionBadge): string {
	if (badge === 'focused') return 'Mic here';
	if (badge === 'background') return 'Listening';
	return 'Silent';
}

// ---------------------------------------------------------------------------
// What the call surfaces say about you in a call (§7.26, §8.1 item 7, §8.5).
// One vocabulary for the Calls page cards, the companion rows and the sidebar
// status row. Pure: every word is a locale key with its English beside it.
// ---------------------------------------------------------------------------

/** "Send my mic to" (lib/calling `voiceTransmitMode`): the one call your mic is in, or every call you hear. */
export type CallTransmitMode = 'primary' | 'all-listening';

/** Your own audio, from lib/calling: what the words need to say where your mic goes and what you hear. */
export interface CallAudioContext {
	/** Global microphone mute (`isMuted`): the mic call then reads "Muted". */
	micMuted?: boolean;
	/** Global deafen (`isDeafened`): you hear no call, so no call reads "Listening". */
	deafened?: boolean;
	/** "Send my mic to" (`voiceTransmitMode`). Default 'primary'. */
	transmitMode?: CallTransmitMode;
}

/**
 * Does your microphone go to this call? Mirrors the audio path, never only the focus:
 * calling_impl_core `shouldTransmitToChannel` and the relay capture in callingWabidb.
 * - "All rooms I hear" sends it to every call you are in, listen-only ones included.
 * - Otherwise only the focused call that transmits gets it. A listen-only call (Listen, a room
 *   joined while your mic is in another call, a room Authority admission keeps listen-only) never
 *   does, focused or not.
 */
export function micGoesTo(session: Pick<CallSession, 'focus' | 'direction'>, audio: CallAudioContext = {}): boolean {
	if (audio.transmitMode === 'all-listening') return true;
	return session.focus === 'focused' && session.direction === 'transmit';
}

/** The one state a call card, a companion row or the sidebar status row shows. */
export type CallStateKey = 'mic-here' | 'muted' | 'listening' | 'silent' | 'joining' | 'reconnecting' | 'lost';

export interface CallStateView {
	key: CallStateKey;
	/** Registry glyph beside the word (lib/components/ui/icons.ts). */
	icon: 'mic' | 'micOff' | 'headphones' | 'headphonesOff' | 'signal' | 'alert';
	/** Locale key for the word, or null while the word has no key yet (`label` is shown). */
	labelKey: string | null;
	/** The word in English. */
	label: string;
	/** One sentence for the tooltip: what the state means for you. */
	hint: string;
}

const STATE_VIEWS: Record<CallStateKey, CallStateView> = {
	'mic-here': { key: 'mic-here', icon: 'mic', labelKey: 'calls.mic_here', label: 'Mic here', hint: 'Your mic goes to this call.' },
	muted: { key: 'muted', icon: 'micOff', labelKey: 'calls.muted', label: 'Muted', hint: 'Your mic goes to this call. It is muted.' },
	listening: { key: 'listening', icon: 'headphones', labelKey: 'calls.listening', label: 'Listening', hint: 'You hear this call. Your mic does not go here.' },
	silent: { key: 'silent', icon: 'headphonesOff', labelKey: 'calls.silent', label: 'Silent', hint: 'You do not hear this call. Your mic does not go here.' },
	joining: { key: 'joining', icon: 'signal', labelKey: 'calls.joining', label: 'Joining…', hint: 'Connecting to this call.' },
	reconnecting: { key: 'reconnecting', icon: 'signal', labelKey: null, label: 'Reconnecting…', hint: 'The connection dropped. Reconnecting.' },
	lost: { key: 'lost', icon: 'alert', labelKey: null, label: 'Connection lost', hint: 'This call lost its connection.' }
};

/** "All rooms I hear": the same words, with a hint that says the mic goes everywhere you listen. */
const ALL_ROOMS_VIEWS: Record<'mic-here' | 'muted', CallStateView> = {
	'mic-here': { ...STATE_VIEWS['mic-here'], hint: 'Your mic goes to every room you hear.' },
	muted: { ...STATE_VIEWS.muted, hint: 'Your mic goes to every room you hear. It is muted.' }
};

const DEAFENED_VIEW: CallStateView = { ...STATE_VIEWS.silent, hint: 'Sound is off for every call (Deafen). Your mic does not go here.' };

/**
 * Your state in one call. The connection comes first (a call that is still joining carries
 * no audio yet), then where your mic goes (`micGoesTo`), then whether you hear it.
 * A call your mic goes to reads "Mic here" (or "Muted") even when you silenced it: what you
 * send matters more than what you hear.
 */
export function sessionState(
	session: Pick<CallSession, 'focus' | 'direction' | 'volume' | 'muted' | 'lifecycle'>,
	audio: CallAudioContext = {}
): CallStateView {
	if (session.lifecycle === 'joining') return STATE_VIEWS.joining;
	if (session.lifecycle === 'reconnecting') return STATE_VIEWS.reconnecting;
	if (session.lifecycle === 'failed') return STATE_VIEWS.lost;
	if (micGoesTo(session, audio)) {
		const views = audio.transmitMode === 'all-listening' ? ALL_ROOMS_VIEWS : STATE_VIEWS;
		return audio.micMuted ? views.muted : views['mic-here'];
	}
	if (audio.deafened) return DEAFENED_VIEW;
	if (session.volume <= 0 || session.muted) return STATE_VIEWS.silent;
	return STATE_VIEWS.listening;
}

/** "Silence this call" is on: the per-call speaker is off or the volume is 0 (one silence, §7.26). */
export function sessionSilenced(session: Pick<CallSession, 'volume' | 'muted'>): boolean {
	return session.muted || session.volume <= 0;
}

/** Translates a locale key with values; components pass `(key, values) => $_(key, { values })`. */
export type CallCopy = (key: string, values?: Record<string, string | number>) => string;

/** The word for a state view, through the locale when it has a key. */
export function callStateWord(view: CallStateView, t?: CallCopy): string {
	return view.labelKey && t ? t(view.labelKey) : view.label;
}

function roomsWord(count: number, t: CallCopy): string {
	return t(count === 1 ? 'calls.summary_rooms_one' : 'calls.summary_rooms_many', { count });
}

/** The calls your mic goes to (not the ones that lost their connection). */
export function micSessions<T extends Pick<CallSession, 'focus' | 'direction' | 'lifecycle'>>(
	sessions: readonly T[],
	audio: CallAudioContext = {}
): T[] {
	return sessions.filter((session) => session.lifecycle !== 'failed' && micGoesTo(session, audio));
}

/** The one call your mic goes to, or null (no call, or "All rooms I hear" with more than one). */
export function focusedSession<T extends Pick<CallSession, 'focus' | 'direction' | 'lifecycle'>>(
	sessions: readonly T[],
	audio: CallAudioContext = {}
): T | null {
	const mic = micSessions(sessions, audio);
	return mic.length === 1 ? mic[0] : null;
}

/**
 * The Calls masthead summary (§7.23). In a call it says how many of the voice rooms you are in and
 * where your mic goes: "In 1 of 3 rooms · mic in Studio lounge", "In 3 rooms · mic in all 3 rooms",
 * "In 2 of 3 rooms · listening only". Direct and group calls are calls, not rooms ("1 call").
 * With no call it counts the voice rooms there are ("3 rooms"), and with no rooms it is empty.
 */
export function callsSummary(
	sessions: readonly CallSession[],
	opts: { nameOf: (session: CallSession) => string; roomCount: number; t: CallCopy; audio?: CallAudioContext }
): string {
	if (sessions.length === 0) return opts.roomCount > 0 ? roomsWord(opts.roomCount, opts.t) : '';
	const rooms = sessions.filter((session) => session.kind === 'channel').length;
	const calls = sessions.length - rooms;
	const parts: string[] = [];
	if (rooms > 0) {
		parts.push(opts.roomCount > rooms ? `In ${rooms} of ${opts.roomCount} rooms` : rooms === 1 ? 'In 1 room' : `In ${rooms} rooms`);
	}
	if (calls > 0) parts.push(calls === 1 ? '1 call' : `${calls} calls`);
	const mic = micSessions(sessions, opts.audio);
	if (mic.length > 1) {
		parts.push(mic.every((session) => session.kind === 'channel') ? `mic in all ${mic.length} rooms` : `mic in all ${mic.length} calls`);
	} else if (mic.length === 1) {
		const [only] = mic;
		parts.push(only.kind === 'direct' ? `mic in the call with ${opts.nameOf(only)}` : opts.t('calls.summary_mic_in', { room: opts.nameOf(only) }));
	} else {
		parts.push('listening only');
	}
	return parts.join(' · ');
}

export interface VoiceStatusLine {
	/** The session the row names: the one your mic goes to, else the first you joined. */
	session: CallSession;
	/** The second line: "Mic here · listening to 2 more", "Mic in all rooms I hear", "Connecting…". */
	line: string;
	/** True while any voice room is still connecting or reconnecting. */
	pending: boolean;
}

/**
 * The sidebar voice status row (§8.1 item 7) for the voice rooms you are in, or null when you
 * are in none. Direct and group calls have their own surfaces, so only channel sessions count;
 * a mic in a direct call, or a listen-only room, means your mic is not in any room ("Listening").
 */
export function voiceStatusLine(sessions: readonly CallSession[], opts: CallAudioContext & { t: CallCopy }): VoiceStatusLine | null {
	const rooms = sessions.filter((session) => session.kind === 'channel');
	if (rooms.length === 0) return null;
	const byJoin = [...rooms].sort((a, b) => a.joinedAt - b.joinedAt);
	const mic = micSessions(rooms, opts);
	const named = (mic.length === 1 ? mic[0] : null) ?? rooms.find((room) => room.focus === 'focused') ?? byJoin[0];
	const pending = rooms.some((room) => room.lifecycle === 'joining' || room.lifecycle === 'reconnecting');
	if (pending) return { session: named, line: 'Connecting…', pending };
	if (rooms.some((room) => room.lifecycle === 'failed')) return { session: named, line: 'Connection trouble', pending };
	if (mic.length > 1) {
		return { session: named, line: opts.micMuted ? 'Muted · mic in all rooms I hear' : 'Mic in all rooms I hear', pending };
	}
	if (mic.length === 0) {
		const heard = rooms.filter((room) => !sessionSilenced(room)).length;
		const head = opts.deafened ? 'Deafened' : heard > 0 ? opts.t('sidebar.listening') : opts.t('calls.silent');
		return { session: named, line: rooms.length > 1 ? `${head} · ${roomsWord(rooms.length, opts.t)}` : head, pending };
	}
	const head = opts.micMuted ? opts.t('calls.muted') : opts.t('sidebar.mic_here');
	const others = rooms.filter((room) => room !== named);
	if (others.length === 0) return { session: named, line: head, pending };
	// "listening to N more" counts only the rooms you hear: a silenced room is not listened to.
	const heard = opts.deafened ? 0 : others.filter((room) => !sessionSilenced(room)).length;
	let tail: string;
	if (opts.deafened) tail = others.length === 1 ? '1 more room' : `${others.length} more rooms`;
	else if (heard > 0) tail = opts.t('sidebar.listening_more', { count: heard });
	else tail = others.length === 1 ? '1 silent room' : `${others.length} silent rooms`;
	return { session: named, line: `${head} · ${tail}`, pending };
}

export interface RegisterCallSessionInput {
	id: string;
	channelId?: string | null;
	name?: string;
	kind: CallSessionKind;
	/** Default 'listen' when another session is already focused. */
	direction?: CallSessionDirection;
	volume?: number;
	participants?: CallSessionParticipant[];
}

/**
 * Manager/graph session id for a direct (DM) call. The wabidb relay's
 * `audioSessionId` must be the SAME string so the session model and the
 * audio chain address one call by one id.
 */
export function directCallSessionId(peerStableUserId: string): string {
	return `direct:${peerStableUserId}`;
}
