import { expect, test } from 'bun:test';
import {
	FAILED_CHECK_TEXT, NO_KEY_NOTICE, NO_KEY_TEXT, E2eeNoKeyError,
	classifyUnreadable, hasNoKeyMessages, unreadableMessageText,
} from './e2eeUnreadable';

test('only the typed no-key error is classed as no key', () => {
	expect(classifyUnreadable(new E2eeNoKeyError('x'))).toBe('no-key');
	expect(classifyUnreadable(new Error('This device does not have the historical E2EE key for that message epoch.'))).toBe('failed-check');
	expect(classifyUnreadable('anything else')).toBe('failed-check');
});

test('the conversation notice appears only when a no-key message is present', () => {
	expect(hasNoKeyMessages([])).toBe(false);
	expect(hasNoKeyMessages([{}, { e2eeUnreadable: 'failed-check' }])).toBe(false);
	expect(hasNoKeyMessages([{}, { e2eeUnreadable: 'no-key' }])).toBe(true);
});

test('wording keeps to what the client knows', () => {
	const all = [NO_KEY_TEXT, FAILED_CHECK_TEXT, NO_KEY_NOTICE.title, NO_KEY_NOTICE.text];
	for (const text of all) {
		const lower = text.toLowerCase();
		expect(lower).not.toContain('end-to-end');
		expect(lower).not.toContain('e2ee');
		expect(lower).not.toMatch(/operator|server can.?t|only you/);
	}
	expect(unreadableMessageText('no-key')).toContain('experimental');
	expect(unreadableMessageText('failed-check')).toContain('experimental');
	// possibilities, never a stated cause or a promise of recovery elsewhere
	expect(NO_KEY_NOTICE.text).toContain('can happen');
	expect(NO_KEY_NOTICE.text).toContain('can’t tell whether another device');
});
