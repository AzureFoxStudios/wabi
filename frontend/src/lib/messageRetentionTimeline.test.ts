import { expect, test } from 'bun:test';
import { messageDeadlineFromTimeline, parseRetentionTimeline } from './messageRetentionTimeline';

test('a shorter current policy never expires history from an earlier forever epoch', () => {
	const epochs = parseRetentionTimeline({ epochs: [
		{ fromMicros: 0, label: 'forever', durationMs: null },
		{ fromMicros: 2_000_000, label: '5s', durationMs: 5_000 },
		{ fromMicros: 4_000_000, label: '1h', durationMs: 3_600_000 }
	] });
	expect(epochs).not.toBeNull();
	expect(messageDeadlineFromTimeline(1_500, epochs)).toBeNull();
	expect(messageDeadlineFromTimeline(2_500, epochs)).toBe(7_500);
	expect(messageDeadlineFromTimeline(4_500, epochs)).toBe(3_604_500);
});

test('invalid or missing policy history fails open for display without inventing a deadline', () => {
	expect(parseRetentionTimeline({ epochs: [{ fromMicros: 4, label: '5s', durationMs: 5000 }] })).toBeNull();
	expect(parseRetentionTimeline({ epochs: [{ fromMicros: 0, label: '5s', durationMs: -5 }] })).toBeNull();
	expect(messageDeadlineFromTimeline(Date.now(), null)).toBeNull();
});
