import { expect, test } from 'bun:test';
import { retentionClockShouldTick } from './messageRetentionClock';

test('static and hidden badges still expire a short-lived message on time', () => {
	for (const mode of ['static', 'off'] as const) {
		expect(retentionClockShouldTick(mode, 4_999, 5_000, false)).toBe(false);
		expect(retentionClockShouldTick(mode, 5_000, 5_000, false)).toBe(true);
	}
});

test('live badges advance while visible and all modes stay idle without a deadline', () => {
	expect(retentionClockShouldTick('live', 2_000, 5_000, true)).toBe(true);
	expect(retentionClockShouldTick('live', 2_000, 5_000, false)).toBe(false);
	expect(retentionClockShouldTick('static', 2_000, null, true)).toBe(false);
});
