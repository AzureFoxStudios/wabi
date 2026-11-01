import { describe, expect, test } from 'bun:test';
import { serverHostLabel, serverUnreadBadge, serverUnreadLabel } from './serverSwitcherLabels';

describe('serverHostLabel: the host without its scheme', () => {
	test('drops the scheme and the trailing slash, keeps the port and a path', () => {
		expect(serverHostLabel('http://127.0.0.1:5196')).toBe('127.0.0.1:5196');
		expect(serverHostLabel('https://wabi.example.org/')).toBe('wabi.example.org');
		expect(serverHostLabel('https://wabi.example.org/community///')).toBe('wabi.example.org/community');
		expect(serverHostLabel('wabi.example.org')).toBe('wabi.example.org');
	});

	test('never shows credentials, and is empty for nothing', () => {
		expect(serverHostLabel('https://mira:secret@wabi.example.org')).toBe('wabi.example.org');
		expect(serverHostLabel('')).toBe('');
		expect(serverHostLabel(null)).toBe('');
		expect(serverHostLabel('   ')).toBe('');
	});

	test('a long run of slashes is trimmed in linear time', () => {
		const started = performance.now();
		expect(serverHostLabel(`https://a.example/${'/'.repeat(50_000)}x`).startsWith('a.example/')).toBe(true);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe('unread words', () => {
	test('badge numerals stop at 99+ and the label says unread', () => {
		expect(serverUnreadBadge(0)).toBe('');
		expect(serverUnreadBadge(7)).toBe('7');
		expect(serverUnreadBadge(120)).toBe('99+');
		expect(serverUnreadLabel(3)).toBe('3 unread');
		expect(serverUnreadLabel(-1)).toBe('');
		expect(serverUnreadLabel(Number.NaN)).toBe('');
	});
});
