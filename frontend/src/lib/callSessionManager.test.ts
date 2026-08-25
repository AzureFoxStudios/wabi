import { describe, expect, it, beforeEach } from 'bun:test';
import { get } from 'svelte/store';
import { callSessionManager, callSessions, focusedCallSessionId } from './callSessionManager';
import { sessionBadge } from './callSessionTypes';

/**
 * Phase 2 contract tests for the multi-session call model: exactly one
 * focused session, background/silenced derived from volume, focus handoff
 * on leave, and DM/group sessions coexisting with channel sessions.
 */

describe('CallSessionManager', () => {
	beforeEach(() => {
		callSessionManager.leaveAll();
	});

	it('first registered session claims focus and transmit', () => {
		const session = callSessionManager.register({ id: 'ch-1', channelId: 'ch-1', kind: 'channel', name: 'General' });
		expect(session.focus).toBe('focused');
		expect(session.direction).toBe('transmit');
		expect(get(focusedCallSessionId)).toBe('ch-1');
		callSessionManager.markConnected('ch-1', 'wabidb');
		expect(callSessionManager.get('ch-1')?.transport).toBe('wabidb');
		expect(callSessionManager.get('ch-1')?.lifecycle).toBe('connected');
	});

	it('second session joins as background listener; focus switch promotes it', () => {
		callSessionManager.register({ id: 'ch-1', kind: 'channel' });
		const second = callSessionManager.register({ id: 'ch-2', kind: 'channel' });
		expect(second.focus).toBe('background');
		expect(second.direction).toBe('listen');

		callSessionManager.setFocus('ch-2');
		expect(callSessionManager.get('ch-2')?.focus).toBe('focused');
		// Promoting a listen session flips it to transmit.
		expect(callSessionManager.get('ch-2')?.direction).toBe('transmit');
		// The previous focus demotes to background.
		expect(callSessionManager.get('ch-1')?.focus).toBe('background');
		expect(get(focusedCallSessionId)).toBe('ch-2');
	});

	it('exactly one focused session at all times', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.register({ id: 'b', kind: 'channel' });
		callSessionManager.register({ id: 'c', kind: 'channel' });
		callSessionManager.setFocus('c');
		const focused = [...get(callSessions).values()].filter((s) => s.focus === 'focused');
		expect(focused.length).toBe(1);
		expect(focused[0].id).toBe('c');
	});

	it('volume 0 reads as silenced badge; restore returns to background', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.register({ id: 'b', kind: 'channel' });
		callSessionManager.setVolume('b', 0);
		expect(callSessionManager.badge('b')).toBe('silenced');
		// Focused session never shows silenced (you transmit there).
		callSessionManager.setVolume('a', 0);
		expect(callSessionManager.badge('a')).toBe('focused');
		callSessionManager.setVolume('b', 40);
		expect(callSessionManager.badge('b')).toBe('background');
	});

	it('unregistering the focused session hands focus to the connected session first', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.register({ id: 'b', kind: 'channel' });
		callSessionManager.register({ id: 'c', kind: 'channel' });
		callSessionManager.markConnected('b', 'wabidb');
		callSessionManager.unregister('a');
		// 'b' is connected (real audio); 'c' is still joining — the live call wins.
		expect(get(focusedCallSessionId)).toBe('b');
		expect(callSessionManager.get('b')?.focus).toBe('focused');
	});

	it('unregistering the last session clears focus', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.unregister('a');
		expect(get(focusedCallSessionId)).toBeNull();
		expect(callSessionManager.list()).toHaveLength(0);
	});

	it('DM and group sessions coexist with channel sessions under one model', () => {
		callSessionManager.register({ id: 'ch-1', channelId: 'ch-1', kind: 'channel' });
		const dm = callSessionManager.register({ id: 'dm:user-1:user-2', kind: 'direct', name: 'Alice' });
		expect(dm.focus).toBe('background');
		expect(callSessionManager.list()).toHaveLength(2);
		expect(callSessionManager.list().map((s) => s.kind).sort()).toEqual(['channel', 'direct']);
	});

	it('participant roster updates flow through', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.setParticipants('a', [
			{ userId: 'user-1', username: 'one' },
			{ userId: 'user-2', username: 'two' }
		]);
		expect(callSessionManager.get('a')?.participants).toHaveLength(2);
		callSessionManager.upsertParticipant('a', { userId: 'user-2', username: 'two', isMuted: true });
		expect(callSessionManager.get('a')?.participants.find((p) => p.userId === 'user-2')?.isMuted).toBe(true);
		callSessionManager.removeParticipant('a', 'user-1');
		expect(callSessionManager.get('a')?.participants).toHaveLength(1);
	});

	it('lifecycle transitions and failure do not leak focus', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.markConnected('a', 'p2p');
		callSessionManager.markReconnecting('a');
		expect(callSessionManager.get('a')?.lifecycle).toBe('reconnecting');
		callSessionManager.markFailed('a');
		expect(callSessionManager.get('a')?.lifecycle).toBe('failed');
		expect(callSessionManager.get('a')?.transport).toBeNull();
		// A failed session still holds its slot until explicitly unregistered.
		expect(callSessionManager.get('a')).toBeDefined();
	});

	it('re-registering a session keeps its settings (volume/name) stable', () => {
		callSessionManager.register({ id: 'a', kind: 'channel', name: 'First' });
		callSessionManager.setVolume('a', 35);
		callSessionManager.register({ id: 'a', kind: 'channel' });
		expect(callSessionManager.get('a')?.volume).toBe(35);
		expect(callSessionManager.get('a')?.name).toBe('First');
	});

	it('sessionBadge derivation matches the mockup three-state model', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.register({ id: 'b', kind: 'channel' });
		callSessionManager.register({ id: 'c', kind: 'channel' });
		callSessionManager.setVolume('c', 0);
		expect(sessionBadge(callSessionManager.get('a')!)).toBe('focused');
		expect(sessionBadge(callSessionManager.get('b')!)).toBe('background');
		expect(sessionBadge(callSessionManager.get('c')!)).toBe('silenced');
	});

	it('sessionIndex gives a stable attribution slot for sounds', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.register({ id: 'b', kind: 'channel' });
		expect(callSessionManager.sessionIndex('a')).toBeGreaterThanOrEqual(0);
		expect(callSessionManager.sessionIndex('zz')).toBe(0);
	});

	it('spatial seats set, survive re-registration, and clear', () => {
		callSessionManager.register({ id: 'a', kind: 'channel' });
		callSessionManager.setSpatialSeat('a', 'user-9', { x: 2, y: 0, z: -3 });
		expect(callSessionManager.get('a')?.spatialSeats['user-9']).toEqual({ x: 2, y: 0, z: -3 });
		// Re-register (reconnect heal) must not drop the stage layout.
		callSessionManager.register({ id: 'a', kind: 'channel' });
		expect(callSessionManager.get('a')?.spatialSeats['user-9']).toEqual({ x: 2, y: 0, z: -3 });
		callSessionManager.clearSpatialSeat('a', 'user-9');
		expect(callSessionManager.get('a')?.spatialSeats['user-9']).toBeUndefined();
	});
});
