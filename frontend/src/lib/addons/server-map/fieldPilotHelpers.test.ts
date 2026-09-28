import { describe, expect, test } from 'bun:test';
import { fieldAge, hasPartialManualPin, markerPosition, needsLeaderAcknowledgement, openHelp, parseManualPin } from './fieldPilotHelpers';
import type { FieldParticipant } from '$lib/api/field';

describe('manual field pilot positions', () => {
	test('accepts only paired percent coordinates within the schematic', () => {
		expect(parseManualPin('35.5', '70')).toEqual({ x: 0.355, y: 0.7 });
		expect(parseManualPin('0', '100')).toEqual({ x: 0, y: 1 });
		expect(parseManualPin('101', '10')).toBeNull();
		expect(parseManualPin('NaN', '10')).toBeNull();
		expect(parseManualPin('', '10')).toBeNull();
		expect(hasPartialManualPin('', '10')).toBe(true);
	});

	test('uses the last position, not the latest text-only check-in', () => {
		const participant: FieldParticipant = {
			userId: 7,
			consented: true,
			lastPosition: { x: 0.2, y: 0.8, source: 'manual', observedAt: 1000, receivedAt: 1001 },
			pendingHelp: null,
			lastHelpAcknowledgement: null,
			lastCheckin: {
				id: 'fresh', status: 'okay', x: null, y: null, source: null,
				observedAt: 9000, receivedAt: 9001, acknowledgedAt: null, acknowledgedByUserId: null
			}
		};
		expect(markerPosition(participant)).toEqual({ x: 0.2, y: 0.8 });
		expect(markerPosition({ ...participant, consented: false })).toBeNull();
		expect(fieldAge(participant.lastPosition?.receivedAt, 121_001)).toBe('2 minutes ago');
		expect(needsLeaderAcknowledgement(participant.lastCheckin)).toBe(false);
		expect(needsLeaderAcknowledgement({ ...participant.lastCheckin!, status: 'help' })).toBe(true);
		expect(openHelp({ ...participant, pendingHelp: { ...participant.lastCheckin!, id: 'older-help', status: 'help' } })?.id).toBe('older-help');
	});
});
