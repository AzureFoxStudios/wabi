import { describe, expect, test } from 'bun:test';
import { shouldAttemptE2eeForChannelType } from './e2eeChannelPolicy';

describe('E2EE channel policy', () => {
	test('only known private conversations opt into E2EE', () => {
		expect(shouldAttemptE2eeForChannelType('dm')).toBe(true);
		expect(shouldAttemptE2eeForChannelType('group')).toBe(true);
		expect(shouldAttemptE2eeForChannelType('text')).toBe(false);
		expect(shouldAttemptE2eeForChannelType('voice')).toBe(false);
		expect(shouldAttemptE2eeForChannelType('forum')).toBe(false);
		expect(shouldAttemptE2eeForChannelType('gallery')).toBe(false);
		expect(shouldAttemptE2eeForChannelType('lore')).toBe(false);
	});

	test('unknown channel types remain fail-closed', () => {
		expect(shouldAttemptE2eeForChannelType(undefined)).toBe(true);
		expect(shouldAttemptE2eeForChannelType(null)).toBe(true);
		expect(shouldAttemptE2eeForChannelType('')).toBe(true);
	});
});
