/**
 * Why an experimental-encryption message is not shown on this device, and the words for it.
 *
 * Kept free of browser and crypto imports so views and tests can use it directly.
 *
 * Truth rules (root AGENTS.md, rule 13):
 * - "no-key" is the one thing the client knows when it holds no key for the message: this device
 *   cannot show it. It does not know why, and does not know whether another device still has the
 *   key, so the wording names reasons only as possibilities and promises nothing.
 * - "failed-check" covers everything else, including causes the client cannot tell apart from the
 *   error it has (for example a failed room-status request).
 * - Neither says "end-to-end encrypted" without "experimental", and neither implies the server
 *   cannot read anything.
 */
import type { Message } from './socket-types';

export type E2eeUnreadableClass = 'no-key' | 'failed-check';

/** Thrown only where this device has no cached key and no key envelope addressed to it. */
export class E2eeNoKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'E2eeNoKeyError';
	}
}

export function classifyUnreadable(error: unknown): E2eeUnreadableClass {
	return error instanceof E2eeNoKeyError ? 'no-key' : 'failed-check';
}

export const NO_KEY_TEXT =
	'[This message uses experimental encryption. This device does not have its key, so it cannot be shown]';
export const FAILED_CHECK_TEXT =
	'[This message uses experimental encryption. It failed a check on this device and is not shown]';

export function unreadableMessageText(kind: E2eeUnreadableClass): string {
	return kind === 'no-key' ? NO_KEY_TEXT : FAILED_CHECK_TEXT;
}

export const NO_KEY_NOTICE = {
	title: 'Some messages can’t be shown on this device',
	text: 'This device doesn’t have the keys for some messages in this conversation that use experimental encryption. That can happen on a new device, or if this device’s saved keys were cleared or lost. Wabi can’t tell whether another device still has them.',
} as const;

/** True when any message in the list is one this device holds no key for. */
export function hasNoKeyMessages(messages: ReadonlyArray<Pick<Message, 'e2eeUnreadable'>>): boolean {
	return messages.some((message) => message.e2eeUnreadable === 'no-key');
}
