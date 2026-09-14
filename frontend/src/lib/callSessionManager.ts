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
import { clearVoiceAdmission, voiceAdmissionForcesListen } from './voiceAdmissionState';

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

function policyForcesListen(sessionId: string, channelId: string | null, kind: string): boolean {
	return kind === 'channel' && voiceAdmissionForcesListen(channelId ?? sessionId);
}

export class CallSessionManager {
	/** Create (or re-register) a session. Returns the stored session. */
	register(input: RegisterCallSessionInput): CallSession {
		const next = new Map(get(sessionsWritable));
		const existing = next.get(input.id);
		const now = Date.now();
		const channelId = input.channelId ?? null;

		// Authority admission wins over optimistic client direction. A room whose
		// entry policy resolved this exact device to listen-only can still be the
		// focused/visible stage, but its session model never advertises transmit.
		const forcedListen = policyForcesListen(input.id, channelId, input.kind);
		const anyFocused = existing?.focus === 'focused' || focusedHasValue(next);
		const direction: CallSessionDirection = forcedListen
			? 'listen'
			: (input.direction ?? (anyFocused ? 'listen' : 'transmit'));
		const focus: CallSessionFocus = existing?.focus ?? (anyFocused ? 'background' : 'focused');

		const session: CallSession = {
			id: input.id,
			channelId,
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
		if (removed.kind === 'channel') clearVoiceAdmission(removed.channelId ?? removed.id);
		audioBindings?.onSessionEnded?.(id);
		if (removed.focus === 'focused') {
			const successor = [...next.values()]
				.filter((s) => s.lifecycle === 'connected' || s.lifecycle === 'joining' || s.lifecycle === 'reconnecting')
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
		const ended = [...get(sessionsWritable).values()];
		commit(new Map());
		focusedCallSessionId.set(null);
		for (const session of ended) {
			if (session.kind === 'channel') clearVoiceAdmission(session.channelId ?? session.id);
			audioBindings?.onSessionEnded?.(session.id);
		}
	}

	/** Focus exactly one session; policy-listen-only sessions remain receive-only. */
	setFocus(id: string): void {
		const next = new Map(get(sessionsWritable));
		if (!next.has(id)) return;
		this.applyFocus(next, id);
		const session = next.get(id)!;
		if (
			session.direction === 'listen' &&
			!policyForcesListen(session.id, session.channelId, session.kind)
		) {
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
		this.update(id, (session) => ({
			...session,
			direction: policyForcesListen(session.id, session.channelId, session.kind) ? 'listen' : direction,
			lastActivityAt: Date.now()
		}));
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

	activeSessions(): CallSession[] {
		return this.list()
			.filter((s) => s.lifecycle === 'connected' || s.lifecycle === 'reconnecting')
			.sort((a, b) => (a.focus === 'focused' ? -1 : 0) - (b.focus === 'focused' ? -1 : 0) || b.joinedAt - a.joinedAt);
	}

	badge(id: string): CallSessionBadge | null {
		const session = this.get(id);
		return session ? sessionBadge(session) : null;
	}

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

export interface CallSessionAudioBindings {
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

export const callSessionManager = new CallSessionManager();

export function backfillCallSessionChannelNames(
	channelList: ReadonlyArray<{ id: string; name?: string | null }>
): void {
	if (!channelList || channelList.length === 0) return;
	const namesById = new Map<string, string>();
	for (const channel of channelList) {
		const name = channel?.name?.trim();
		if (channel?.id && name) namesById.set(channel.id, name);
	}
	if (namesById.size === 0) return;
	for (const session of get(sessionsWritable).values()) {
		const lookupId = session.channelId ?? session.id;
		const resolved = namesById.get(lookupId);
		if (!resolved) continue;
		if (session.kind === 'channel') {
			if (session.name !== resolved) callSessionManager.setName(session.id, resolved);
			continue;
		}
		const current = session.name?.trim();
		if (!current || current === session.id || current === session.channelId) {
			callSessionManager.setName(session.id, resolved);
		}
	}
}
