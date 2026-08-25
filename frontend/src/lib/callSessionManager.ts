/**
 * Phase 2 calling overhaul — the CallSessionManager (2026-08-25).
 *
 * One CallSession per connected call (voice channel / DM / group). Exactly
 * one session is FOCUSED at a time (the call you transmit to and the stage
 * the focused view renders); every other session is background audio at its
 * own volume, or silenced at volume 0. Pure state machine over an immutable
 * Map — unit-testable without sockets, audio, or Svelte components.
 *
 * The legacy model (calling_impl_core's activeVoiceChannelId +
 * listeningVoiceChannels) is being migrated onto this manager: join/leave
 * paths register/unregister sessions here during Phase 2, and Phase 3/4 UI
 * (CallStage, voice view, right-panel controller) binds to `callSessions`.
 */

import { writable, get } from 'svelte/store';
import type {
	CallSession,
	CallSessionBadge,
	CallSessionDirection,
	CallSessionFocus,
	CallSessionParticipant,
	CallSessionTransport,
	CallSpatialPosition,
	RegisterCallSessionInput
} from './callSessionTypes';
import { sessionBadge } from './callSessionTypes';

const sessionsWritable = writable<ReadonlyMap<string, CallSession>>(new Map());

/** Live map of id → CallSession. Bind UI here; updates are immutable. */
export const callSessions = { subscribe: sessionsWritable.subscribe };

/** The single focused session id, or null when connected to nothing. */
export const focusedCallSessionId = writable<string | null>(null);

function cloneSession(session: CallSession): CallSession {
	return { ...session, participants: session.participants.map((p) => ({ ...p })) };
}

function commit(next: Map<string, CallSession>): void {
	sessionsWritable.set(next);
}

export class CallSessionManager {
	/** Create (or re-register) a session. Returns the stored session. */
	register(input: RegisterCallSessionInput): CallSession {
		const next = new Map(get(sessionsWritable));
		const existing = next.get(input.id);
		const now = Date.now();

	 // First session claims focus; later sessions join as background listeners
		// unless explicitly promoted (mockup contract: exactly one FOCUSED).
		const anyFocused = existing?.focus === 'focused' || focusedHasValue(next);
		const direction: CallSessionDirection =
			input.direction ?? (anyFocused ? 'listen' : 'transmit');
		const focus: CallSessionFocus = existing?.focus ?? (anyFocused ? 'background' : 'focused');

		const session: CallSession = {
			id: input.id,
			channelId: input.channelId ?? null,
			name: input.name ?? existing?.name ?? input.id,
			kind: input.kind,
			direction,
			focus,
			volume: input.volume ?? existing?.volume ?? 100,
			muted: existing?.muted ?? false,
			lifecycle: 'joining',
			transport: existing?.transport ?? null,
			participants: input.participants ?? existing?.participants ?? [],
			spatialSeats: existing?.spatialSeats ?? {},
			joinedAt: existing?.joinedAt ?? now,
			lastActivityAt: now
		};
		next.set(input.id, session);
		commit(next);
		if (focus === 'focused') focusedCallSessionId.set(input.id);
		return cloneSession(session);
	}

	markConnected(id: string, transport: CallSessionTransport): void {
		this.update(id, (session) => ({ ...session, lifecycle: 'connected', transport, lastActivityAt: Date.now() }));
	}

	markReconnecting(id: string): void {
		this.update(id, (session) => ({ ...session, lifecycle: 'reconnecting', lastActivityAt: Date.now() }));
	}

	markFailed(id: string): void {
		this.update(id, (session) => ({ ...session, lifecycle: 'failed', transport: null, lastActivityAt: Date.now() }));
	}

	/** End a session. If it was focused, focus falls to the most recent
	 *  connected background session (auto-promote) or to nothing. */
	unregister(id: string): void {
		const next = new Map(get(sessionsWritable));
		const removed = next.get(id);
		if (!removed) return;
		next.delete(id);
		commit(next);
		audioBindings?.onSessionEnded?.(id);
		if (removed.focus === 'focused') {
			// Prefer a connected session over one still joining; break ties by
			// recency. Same-millisecond joins resolve to insertion order.
			const successor = [...next.values()]
				.filter((s) => s.lifecycle === 'connected' || s.lifecycle === 'joining')
				.sort((a, b) => {
					const aLive = a.lifecycle === 'connected' ? 1 : 0;
					const bLive = b.lifecycle === 'connected' ? 1 : 0;
					if (aLive !== bLive) return bLive - aLive;
					return b.joinedAt - a.joinedAt;
				})[0];
			if (successor) {
				this.applyFocus(next, successor.id);
				commit(next);
			} else {
				focusedCallSessionId.set(null);
			}
		}
	}

	leaveAll(): void {
		const ended = [...get(sessionsWritable).keys()];
		commit(new Map());
		focusedCallSessionId.set(null);
		for (const id of ended) audioBindings?.onSessionEnded?.(id);
	}

	/** Focus exactly one session; every other focused session demotes to
	 *  background. Promoting a listen session flips it to transmit (you now
	 *  speak there — the "primary channel switch" the old model lacked). */
	setFocus(id: string): void {
		const next = new Map(get(sessionsWritable));
		if (!next.has(id)) return;
		this.applyFocus(next, id);
		const session = next.get(id)!;
		if (session.direction === 'listen') {
			next.set(id, { ...session, direction: 'transmit' });
		}
		commit(next);
	}

	clearFocus(): void {
		const next = new Map(get(sessionsWritable));
		for (const [id, session] of next) {
			if (session.focus === 'focused') next.set(id, { ...session, focus: 'background' });
		}
		commit(next);
		focusedCallSessionId.set(null);
	}

	setDirection(id: string, direction: CallSessionDirection): void {
		this.update(id, (session) => ({ ...session, direction, lastActivityAt: Date.now() }));
	}

	/** 0..100. Volume 0 on a background session reads as SILENCED. */
	setVolume(id: string, volume: number): void {
		const clamped = Math.max(0, Math.min(100, Math.round(volume)));
		this.update(id, (session) => {
			const next = { ...session, volume: clamped, lastActivityAt: Date.now() };
			emitVolume(next);
			return next;
		});
	}

	setSessionMuted(id: string, muted: boolean): void {
		this.update(id, (session) => {
			const next = { ...session, muted };
			emitVolume(next);
			return next;
		});
	}

	setTransport(id: string, transport: CallSessionTransport): void {
		this.update(id, (session) => ({ ...session, transport }));
	}

	setName(id: string, name: string): void {
		this.update(id, (session) => ({ ...session, name }));
	}

	/** Phase 3: manual spatial seat for one user (drag on the stage). */
	setSpatialSeat(id: string, userId: string, position: CallSpatialPosition): void {
		this.update(id, (session) => ({
			...session,
			spatialSeats: { ...session.spatialSeats, [userId]: { ...position } },
			lastActivityAt: Date.now()
		}));
	}

	clearSpatialSeat(id: string, userId: string): void {
		this.update(id, (session) => {
			if (!(userId in session.spatialSeats)) return session;
			const seats = { ...session.spatialSeats };
			delete seats[userId];
			return { ...session, spatialSeats: seats, lastActivityAt: Date.now() };
		});
	}

	/** Replace the roster snapshot for a session (voice-channel-state). */
	setParticipants(id: string, participants: CallSessionParticipant[]): void {
		this.update(id, (session) => ({ ...session, participants, lastActivityAt: Date.now() }));
	}

	upsertParticipant(id: string, participant: CallSessionParticipant): void {
		this.update(id, (session) => {
			const others = session.participants.filter((p) => p.userId !== participant.userId);
			return { ...session, participants: [...others, participant], lastActivityAt: Date.now() };
		});
	}

	removeParticipant(id: string, userId: string): void {
		this.update(id, (session) => ({
			...session,
			participants: session.participants.filter((p) => p.userId !== userId),
			lastActivityAt: Date.now()
		}));
	}

	get(id: string): CallSession | undefined {
		const session = get(sessionsWritable).get(id);
		return session ? cloneSession(session) : undefined;
	}

	list(): CallSession[] {
		return [...get(sessionsWritable).values()].map(cloneSession);
	}

	/** Sessions that currently produce audio, focused first. */
	activeSessions(): CallSession[] {
		return this.list()
			.filter((s) => s.lifecycle === 'connected' || s.lifecycle === 'reconnecting')
			.sort((a, b) => (a.focus === 'focused' ? -1 : 0) - (b.focus === 'focused' ? -1 : 0) || b.joinedAt - a.joinedAt);
	}

	badge(id: string): CallSessionBadge | null {
		const session = this.get(id);
		return session ? sessionBadge(session) : null;
	}

	/** Stable index for per-session sound attribution (pitch/pan). */
	sessionIndex(id: string): number {
		return Math.max(0, this.list().findIndex((s) => s.id === id));
	}

	private update(id: string, mutate: (session: CallSession) => CallSession): void {
		const next = new Map(get(sessionsWritable));
		const session = next.get(id);
		if (!session) return;
		next.set(id, mutate(session));
		commit(next);
	}

	private applyFocus(next: Map<string, CallSession>, id: string): void {
		for (const [sessionId, session] of next) {
			if (sessionId === id && session.focus !== 'focused') {
				next.set(sessionId, { ...session, focus: 'focused' });
			} else if (sessionId !== id && session.focus === 'focused') {
				next.set(sessionId, { ...session, focus: 'background' });
			}
		}
		focusedCallSessionId.set(id);
	}
}

function focusedHasValue(sessions: Map<string, CallSession>): boolean {
	for (const session of sessions.values()) {
		if (session.focus === 'focused') return true;
	}
	return false;
}

/**
 * Audio side-effects for session state changes (per-call volume / chain
 * disposal). The manager stays dependency-free for tests; the runtime binds
 * these to the shared audio graph — see callingWabidb.ts.
 */
export interface CallSessionAudioBindings {
	/** Effective 0..100 output volume (0 while the session is muted). */
	onVolumeChanged?: (id: string, effectiveVolume: number) => void;
	onSessionEnded?: (id: string) => void;
}

let audioBindings: CallSessionAudioBindings | null = null;

export function bindCallSessionAudio(bindings: CallSessionAudioBindings): void {
	audioBindings = bindings;
}

function emitVolume(session: CallSession): void {
	audioBindings?.onVolumeChanged?.(session.id, session.muted ? 0 : session.volume);
}

/** Singleton — the single source of truth for connected calls. */
export const callSessionManager = new CallSessionManager();
