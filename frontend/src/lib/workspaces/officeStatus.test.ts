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

	test('a place can be added to the settled states so it survives the collapsed tag', () => {
		expect(compactStatus('Saved on this device', at, 'device')).toBe(`Saved ${time} · this device only`);
		expect(compactStatus('Synced to this server', at, 'server')).toBe(`Synced ${time} · on this server`);
		// Local saves of a shared file are not "this device only", and other states are untouched.
		expect(compactStatus('Saved on this device', at, 'server')).toBe(`Saved ${time}`);
		expect(compactStatus('Offline · changes saved here', at, 'device')).toBe('Offline · changes saved here');
	});

	test('states that carry their own news keep the session words', () => {
		for (const status of ['Saved here · waiting to sync', 'Offline · changes saved here', 'Needs attention']) {
			expect(compactStatus(status, at)).toBe(status);
		}
	});
});
