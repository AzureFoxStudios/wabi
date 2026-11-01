/**
 * Words and states for a DM or group conversation's own chrome (design contract §7.16, §8.10,
 * §9.2): the composer-replacement row shown while sending is paused, plain-word errors for the
 * encryption actions, the message-lifetime choices, a call that did not start and the DMs hub
 * search.
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

export interface DmGateActionView {
	id: DmSendGateActionId;
	/** The verb in progress while its request runs, else the action's own label. */
	label: string;
	busy: boolean;
}

/**
 * One paused-row button as it should render now. "Check again" follows the status check; the
 * other actions follow the encryption request in flight. Components call this from a reactive
 * statement that names both flags, so a request that ends (or fails) re-enables the button.
 */
export function dmGateActionView(action: DmSendGateAction, state: { checking: boolean; busy: boolean }): DmGateActionView {
	const busy = action.id === 'check' ? state.checking : state.busy;
	return { id: action.id, label: busy ? action.busyLabel : action.label, busy };
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

const FOREVER_CHOICE = 'Until someone deletes them';

function presetLabel(value: string): string {
	return (MESSAGE_RETENTION_LABELS as Record<string, string>)[value] ?? value;
}

/**
 * The "Keep new messages for" choices, as menu rows (sentence case): "Until someone deletes
 * them", "5 seconds" … "90 days". The same rows serve the desktop menu and the phone sheet.
 */
export function dmRetentionOptions(): DmRetentionOption[] {
	return [
		{ value: DM_RETENTION_FOREVER, label: FOREVER_CHOICE },
		...MESSAGE_RETENTION_PRESETS.map((value: string) => ({ value, label: presetLabel(value) }))
	];
}

/**
 * The lifetime said as the retention chip says it (§9.2): "Kept until someone deletes them",
 * "Kept 24 hours". Never a privacy claim.
 */
export function dmRetentionPhrase(value: string): string {
	return value === DM_RETENTION_FOREVER ? 'Kept until someone deletes them' : `Kept ${presetLabel(value)}`;
}

/** The control's accessible name. It starts with the visible words ("Kept 24 hours") so voice
 *  control can target what it sees (WCAG 2.5.3), then says what choosing does. */
export function dmRetentionControlLabel(value: string): string {
	return `${dmRetentionPhrase(value)}. Change how long new messages are kept`;
}

// ---------------------------------------------------------------------------- calls

/**
 * Plain words for a call that did not start, by cause: another call in progress, no connection,
 * a refused or missing microphone/camera, or anything else. The raw message is logged by the
 * caller and never shown.
 */
export function dmCallStartError(error: unknown, withVideo: boolean): string {
	const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
	const message = rawMessage(error).toLowerCase();
	if (message.includes('already active') || message.includes('ringing')) {
		return 'You’re already in a call. Leave it, then start this one.';
	}
	if (
		message.includes('no connection') ||
		message.includes('offline') ||
		message.includes('not connected') ||
		message.includes('active server connection') ||
		message.includes('reconnect')
	) {
		return 'Not connected to the server. Calls start once you’re back online.';
	}
	const device = withVideo ? 'camera and microphone' : 'microphone';
	if (name === 'NotAllowedError' || name === 'SecurityError' || message.includes('permission') || message.includes('denied')) {
		return `Couldn’t use your ${device}. Allow access in your browser, then try again.`;
	}
	if (name === 'NotFoundError' || name === 'NotReadableError' || message.includes('device not found') || message.includes('could not start')) {
		return `No ${device} is available. Connect one, then try again.`;
	}
	return withVideo ? 'Couldn’t start the video call. Try again in a moment.' : 'Couldn’t start the call. Try again in a moment.';
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
