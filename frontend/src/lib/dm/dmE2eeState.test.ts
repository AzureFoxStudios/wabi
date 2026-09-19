import { describe, expect, test } from 'bun:test';
import { cachedE2eeStatus, clearE2eeCache } from './dmE2eeState';

describe('dmE2eeState cache', () => {
	test('returns null for unknown conversations', () => {
		clearE2eeCache();
		expect(cachedE2eeStatus('ch_nonexistent')).toBe(null);
	});

	test('cache survives clearE2eeCache', () => {
		clearE2eeCache();
		expect(cachedE2eeStatus('ch_dm')).toBe(null);
	});
});
