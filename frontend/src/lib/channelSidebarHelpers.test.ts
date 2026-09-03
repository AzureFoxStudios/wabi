/**
 * callParticipantCount (lives here, next to formatDiag, because this module
 * is link-safe in bun — callingDiagnostics drags the store graph): the
 * diagnostics-panel participant count must read the voice-channel roster on
 * the wabidb relay (activeCalls is a WebRTC/SFU-only store and stays empty
 * there — 2026-09-03: a 2-person relay call showed "Participants: 1"), and
 * keep the legacy 1 + activeCalls formula everywhere the roster isn't
 * authoritative.
 */
import { describe, expect, test } from 'bun:test';
import { callParticipantCount } from './components/sidebar/channelSidebarHelpers';

describe('callParticipantCount', () => {
	test('relay transport counts the roster (includes self)', () => {
		expect(callParticipantCount('wabidb', 0, 2)).toBe(2);
		expect(callParticipantCount('wabidb', 0, 5)).toBe(5);
	});

	test('relay with no roster knowledge falls back to activeCalls formula', () => {
		expect(callParticipantCount('wabidb', 0, null)).toBe(1);
		expect(callParticipantCount('wabidb', 2, null)).toBe(3);
	});

	test('empty roster is treated as unknown, never zero participants', () => {
		expect(callParticipantCount('wabidb', 0, 0)).toBe(1);
	});

	test('non-relay transports keep the legacy count', () => {
		expect(callParticipantCount('p2p', 0, 4)).toBe(1);
		expect(callParticipantCount('p2p', 3, 4)).toBe(4);
		expect(callParticipantCount('sfu', 3, null)).toBe(4);
	});
});
