import { describe, expect, test } from 'bun:test';
import { filterMessages } from './searchFilter';
import { FAILED_CHECK_TEXT, NO_KEY_TEXT } from '$lib/e2eeUnreadable';
import type { Message } from '$lib/socket';

const message = (id: string, text: string, extra: Partial<Message> = {}): Message =>
	({ id, user: 'mika', userId: 'user-1', text, type: 'text', timestamp: 1, ...extra }) as Message;

describe('chat search and messages this device cannot show', () => {
	const readable = message('1', 'the key is under the mat');
	const noKey = message('2', NO_KEY_TEXT, { e2eeUnreadable: 'no-key' });
	const failed = message('3', FAILED_CHECK_TEXT, { e2eeUnreadable: 'failed-check' });
	const all = [readable, noKey, failed];

	test('a text search does not match the placeholder words of an unreadable message', () => {
		// "key", "device" and "experimental" are in the placeholders, not in what anyone wrote.
		expect(filterMessages(all, 'key', 100).map((m) => m.id)).toEqual(['1']);
		expect(filterMessages(all, 'experimental', 100)).toEqual([]);
		expect(filterMessages(all, 'device', 100)).toEqual([]);
	});

	test('without a text term they are still listed', () => {
		expect(filterMessages(all, '', 100).map((m) => m.id)).toEqual(['1', '2', '3']);
		expect(filterMessages(all, 'by:mika', 100).map((m) => m.id)).toEqual(['1', '2', '3']);
	});
});
