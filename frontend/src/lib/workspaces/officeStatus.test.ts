import { describe, expect, test } from 'bun:test';
import { compactStatus } from './officeStatus';

describe('office editor header status', () => {
	const at = new Date(2026, 9, 31, 9, 41);
	const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at);

	test('saved and synced states name the time, not the place the tag already names', () => {
		expect(compactStatus('Saved on this device', at)).toBe(`Saved ${time}`);
		expect(compactStatus('Synced to this server', at)).toBe(`Synced ${time}`);
		expect(compactStatus('Saving on this device…', at)).toBe('Saving…');
		expect(compactStatus('Loading', at)).toBe('Opening…');
	});

	test('states that carry their own news keep the session words', () => {
		for (const status of ['Saved here · waiting to sync', 'Offline · changes saved here', 'Needs attention']) {
			expect(compactStatus(status, at)).toBe(status);
		}
	});
});
