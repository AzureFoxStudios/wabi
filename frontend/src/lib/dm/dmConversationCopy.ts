/**
 * Words and states for a DM or group conversation's own chrome (design contract §7.16, §8.10,
 * §9.2): the composer-replacement row shown while sending is paused, plain-word errors for the
 * encryption actions, the message-lifetime choices and the DMs hub search.
 *
 * The privacy *state* is never worded here: the header chip and the colophon come from
 * privacyState.ts through PrivacyBadge, and the titles below reuse those exact words. This module
 * only says what the conversation is waiting for and what the member can do about it.
 *
 * Truth rules:
 * - The composer shows only when the room status is known and lets this member send; every other
 *   case (status not loaded yet, pending devices, someone else's server-readable choice, a key
 *   update) is a paused row with its reason. Nothing here unpauses sending.
 * - A failed request never shows the raw Error.message (it is logged by the caller) and never
 *   says "E2EE": the member sees the cause in plain words and what stayed unchanged.
 */
import type { E2eeRoomStatus } from '../e2ee';
import { privacyWords } from '../privacy/privacyState';
import { DEFAULT_DM_RETENTION, MESSAGE_RETENTION_LABELS, MESSAGE_RETENTION_PRESETS } from '../../../../shared/messageRetention.js';

// ---------------------------------------------------------------------------- sending paused

export type DmSendGateKind = 'rekey' | 'pending' | 'confirm-readable' | 'checking';
export type DmSendGateActionId = 'rekey' | 'check' | 'server-readable';

export interface DmSendGateAction {
	id: DmSendGateActionId;
	label: string;
	/** The verb in progress while the request runs ("Checking…"). */
	busyLabel: string;
}

export interface DmSendGate {
	kind: DmSendGateKind;
	/** Icon registry name, drawn in --w-seal: this row is about who can read the conversation. */
	glyph: 'lock' | 'lockOpen' | 'hourglass';
	/** The state in the words the header chip uses. */
	title: string;
	/** One plain sentence: why sending is paused and what changes it. */
	text: string;
	/** Who the room is waiting for, or '' when there is nothing to add. */
	detail: string;
	actions: DmSendGateAction[];
}

const CHECK: DmSendGateAction = { id: 'check', label: 'Check again', busyLabel: 'Checking…' };
const SEND_READABLE: DmSendGateAction = { id: 'server-readable', label: 'Send server-readable', busyLabel: 'Switching…' };
const REKEY: DmSendGateAction = { id: 'rekey', label: 'Trust devices and update keys', busyLabel: 'Updating keys…' };

/**
 * The composer-replacement row for a conversation, or null when the composer may show.
 * `missing` names the participants whose devices are not ready yet ("Theo Park, 1 other").
 * The branch order is the send path's own: an encrypted room that needs new keys, then a new room
 * waiting for devices, then another member's server-readable choice this member has not
 * confirmed, then anything not yet known.
 */
export function dmSendGate(status: E2eeRoomStatus | null | undefined, missing = ''): DmSendGate | null {
	if (status && !status.pendingDefault && !status.needsRekey && (!status.serverReadableSelected || status.serverReadableAllowedByMe)) {
		return null;
	}
	if (status?.enabled && status.needsRekey) {
		return {
			kind: 'rekey',
			glyph: 'lock',
			title: 'Encryption keys need an update',
			text: 'Membership or devices changed. Review the participant devices before you trust the new key.',
			detail: 'Newly added devices may not open earlier encrypted messages.',
			actions: [REKEY]
		};
	}
	if (status?.pendingDefault) {
		const words = privacyWords('encryption-pending', { conversation: true });
		const waiting = status.missingUserIds?.length ?? 0;
		return {
			kind: 'pending',
			glyph: 'hourglass',
			title: words.word,
			text: words.sentence,
			detail: waiting > 0 ? (missing.trim() ? `Waiting for ${missing.trim()}.` : 'Waiting for participant devices.') : "Everyone's devices are ready. Encryption is starting.",
			actions: [CHECK, SEND_READABLE]
		};
	}
	if (status?.serverReadableSelected && !status.serverReadableAllowedByMe) {
		return {
			kind: 'confirm-readable',
			glyph: 'lockOpen',
			title: privacyWords('server-readable', { conversation: true }).word,
			text: 'Another participant chose to send without encryption. Confirm it for your account before you send.',
			detail: "You can turn encryption on later, once everyone's devices are ready.",
			actions: [SEND_READABLE]
		};
	}
	return {
		kind: 'checking',
		glyph: 'hourglass',
		title: privacyWords('checking').word,
		text: 'Sending is paused until this device confirms who can read this conversation.',
		detail: '',
		actions: [CHECK]
	};
}

// ---------------------------------------------------------------------------- action errors

export type DmEncryptionAction = 'check' | 'server-readable' | 'rekey' | 'enable';

export interface DmActionError {
	/** The request that failed; a failed check folds into the sending-paused row. */
	action: DmEncryptionAction;
	/** Bold one-line cause. */
	title: string;
	/** What stayed unchanged and what to do next. */
	text: string;
}

const UNCHANGED: Record<DmEncryptionAction, string> = {
	check: 'Sending stays paused until it can. Nothing was sent.',
	'server-readable': 'Nothing changed. Try again.',
	rekey: 'Nothing changed. Check participant devices and try again.',
	enable: 'Messages stay server-readable. Try again.'
};

const FAILED: Record<DmEncryptionAction, string> = {
	check: "Couldn't check who can read this conversation",
	'server-readable': "Couldn't switch to server-readable",
	rekey: "Couldn't update the encryption keys",
	enable: "Couldn't turn on encryption"
};

function rawMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === 'string' ? error : '';
}

/**
 * Plain words for a failed encryption request. The cause is classified from the thrown message
 * but never repeats it: the member sees what happened and what is unchanged. `null` (the request
 * returned nothing) reads as the generic failure for the action.
 */
export function dmEncryptionError(action: DmEncryptionAction, error: unknown): DmActionError {
	const message = rawMessage(error).toLowerCase();
	const tail = UNCHANGED[action];
	if (message.includes('registered account') || message.includes('sign in with')) {
		return {
			action,
			title: 'This account can’t set up encryption',
			text: action === 'check'
				? 'Sign in with a registered account to send in this conversation. Nothing was sent.'
				: 'Sign in with a registered account, then try again. Nothing changed.'
		};
	}
	if (message.includes('session expired') || message.includes('sign in again')) {
		return { action, title: 'Your session ended', text: `Sign in again, then try once more. ${action === 'check' ? 'Nothing was sent.' : 'Nothing changed.'}` };
	}
	if (message.includes('webcrypto') || message.includes('persist') || message.includes('key material')) {
		return { action, title: 'This browser can’t keep encryption keys', text: `Try another browser, or leave private browsing. ${tail}` };
	}
	if (message.includes('missing') && message.includes('device')) {
		return { action, title: 'Some devices aren’t ready yet', text: `Everyone needs an updated Wabi on their device first. ${tail}` };
	}
	return { action, title: FAILED[action], text: tail };
}

// ---------------------------------------------------------------------------- message lifetime

export interface DmRetentionOption {
	value: string;
	label: string;
}

/** '' is "until deleted" (the server's null); everything else is a preset such as '24h'. */
export const DM_RETENTION_FOREVER = '';

/** The lifetime a conversation uses now: '' when kept until deleted, else its preset. */
export function dmRetentionChoice(channel: { autoDeleteAfter?: unknown } | null | undefined): string {
	const value = channel?.autoDeleteAfter;
	if (value === null || String(value) === 'forever') return DM_RETENTION_FOREVER;
	return typeof value === 'string' && value ? value : DEFAULT_DM_RETENTION;
}

/** The kit Select options, read after a "Kept" prefix: "Kept until deleted", "Kept 24 hours". */
export function dmRetentionOptions(): DmRetentionOption[] {
	return [
		{ value: DM_RETENTION_FOREVER, label: 'until deleted' },
		...MESSAGE_RETENTION_PRESETS.map((value: string) => ({
			value,
			label: (MESSAGE_RETENTION_LABELS as Record<string, string>)[value] ?? value
		}))
	];
}

// ---------------------------------------------------------------------------- hub search

/** True when any of the conversation's names contains the query (case and accents ignored). */
export function conversationMatches(query: string, names: ReadonlyArray<string | null | undefined>): boolean {
	const needle = fold(query);
	if (!needle) return true;
	return names.some((name) => typeof name === 'string' && fold(name).includes(needle));
}

function fold(value: string): string {
	return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
