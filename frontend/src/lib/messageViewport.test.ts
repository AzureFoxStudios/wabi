import { describe, expect, test } from 'bun:test';
import { isNearMessageBottom, MESSAGE_BOTTOM_FOLLOW_THRESHOLD_PX } from './messageViewport';

describe('conversation viewport following', () => {
	test('follows the latest messages when already near the bottom', () => {
		expect(isNearMessageBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(true);
		expect(isNearMessageBottom({ scrollHeight: 1000, scrollTop: 472, clientHeight: 400 })).toBe(true);
	});

	test('does not steal reading position when the user is in history', () => {
		expect(isNearMessageBottom({
			scrollHeight: 2000,
			scrollTop: 500,
			clientHeight: 700
		})).toBe(false);
	});

	test('uses a bounded non-negative threshold', () => {
		expect(MESSAGE_BOTTOM_FOLLOW_THRESHOLD_PX).toBeGreaterThan(0);
		expect(isNearMessageBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 100 }, -5)).toBe(true);
	});
});
