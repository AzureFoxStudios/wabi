import { describe, expect, test } from 'bun:test';
import { interpretTestPushResult } from './pushClient';

describe('interpretTestPushResult', () => {
	test('requires at least one actual delivery', () => {
		expect(interpretTestPushResult({ ok: true, sent: 1, failed: 0 })).toEqual({ ok: true });
		expect(interpretTestPushResult({ ok: true, sent: 0, failed: 0 })).toEqual({
			ok: false,
			reason: 'no_registered_delivery_target'
		});
	});

	test('surfaces failed delivery attempts', () => {
		expect(interpretTestPushResult({ ok: false, sent: 0, failed: 2 })).toEqual({
			ok: false,
			reason: 'delivery_failed:2'
		});
	});

	test('does not trust an inconsistent server success flag', () => {
		expect(interpretTestPushResult({ ok: false, sent: 1, failed: 0 })).toEqual({
			ok: false,
			reason: 'server_reported_no_delivery'
		});
	});
});
