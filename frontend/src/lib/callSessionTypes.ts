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
	joinedAt: number;
	lastActivityAt: number;
}

/** The three-state badge from the voice-view/right-panel mockups. */
export type CallSessionBadge = 'focused' | 'background' | 'silenced';

export function sessionBadge(session: CallSession): CallSessionBadge {
	if (session.volume <= 0 && session.focus !== 'focused') return 'silenced';
	return session.focus;
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
