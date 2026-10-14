/**
 * The one privacy state source (design contract §7.20, §9.2, §9.5).
 *
 * Every privacy label in the app (composer colophon, DM header seal chip, thread-list chips,
 * palette results, the privacy popover) is derived here and worded here, so two surfaces can
 * never describe the same room differently. Components render the result through
 * `PrivacyBadge.svelte` / `PrivacyPopover.svelte`; they do not write their own privacy copy.
 *
 * Truth rules this module enforces:
 * - It returns only states the branch can actually derive. Known shared channel types (anything
 *   but `dm` / `group`) are always Server-readable. DMs and groups are labelled from the room's
 *   authenticated E2EE status (`/api/e2ee/rooms/:id`): pending, server-readable by choice,
 *   experimental encryption, or (older rooms without a new-room policy) server-readable. Until
 *   that status is known the state is Checking: a missing or failed policy request never becomes
 *   an encryption claim.
 * - Retention is never evidence of confidentiality. "Live only" rooms are still server-readable;
 *   retention gets its own words (`retentionLabel`) and is never part of the privacy word.
 * - A device-local DM mode preference (`dmPrivacyMode.ts`) is not room policy and never changes
 *   the derived state.
 * - Words follow the vocabulary in §9.2 exactly: "Server-readable", "Server-readable by
 *   choice", "Encryption pending", "Experimental encryption" (always with "Not independently
 *   verified"). Never "Secure", "End-to-end encrypted", "E2EE", "verified" on its own,
 *   "encrypted" without "experimental", or "private" for retention.
 */
import type { DMPrivacyMode } from '../dmPrivacyMode';
import { shouldAttemptE2eeForChannelType } from '../e2eeChannelPolicy';
import { currentRetentionFromPrivacy } from '../retentionDisplay';

export type PrivacyState =
	| 'server-readable'
	| 'server-readable-by-choice'
	| 'encryption-pending'
	| 'experimental-encryption'
	| 'checking';

export const PRIVACY_STATES: readonly PrivacyState[] = Object.freeze([
	'server-readable',
	'server-readable-by-choice',
	'encryption-pending',
	'experimental-encryption',
	'checking'
]);

export function isPrivacyState(value: unknown): value is PrivacyState {
	return typeof value === 'string' && (PRIVACY_STATES as readonly string[]).includes(value);
}

/**
 * What the server has told this client about a room. Structural on purpose: it accepts the
 * E2EE room status (`E2eeRoomStatus` from `/api/e2ee/rooms/:id`), the member privacy summary
 * (`/api/privacy/channels/:id`), or both merged. Only the fields below are read.
 */
export type PrivacyPolicy = {
	// E2EE room status (DMs and groups). The server sets at most one of these three.
	/** The room has an active experimental encryption key. */
	enabled?: boolean | null;
	/** New private room waiting for participant devices (or an explicit server-readable choice). */
	pendingDefault?: boolean | null;
	/** Someone chose the server-readable fallback for this room. */
	serverReadableSelected?: boolean | null;
	/** This member consented to the server-readable fallback on their own account. */
	serverReadableAllowedByMe?: boolean | null;
	// Member privacy summary.
	/** Server's confidentiality class for the room ('server_readable' | 'experimental_e2ee'). */
	confidentiality?: string | null;
	e2ee?: boolean | null;
	/** True for DMs and groups, false for shared channels. */
	privateConversation?: boolean | null;
	/** Retention label: 'live', 'forever' or a duration such as '24h' / '7d'. Never evidence. */
	retention?: string | null;
};

export type PrivacyInput = {
	/** Channel kind ('text', 'voice', 'forum', 'dm', 'group', …). Unknown is not assumed shared. */
	channelType?: string | null;
	/** The channel itself, when that is what the caller holds; `channelType` wins. */
	channel?: { type?: string | null } | null;
	/** The composer will wrap the next send in an encrypted envelope. */
	encryptSend?: boolean | null;
	/** Device-local DM mode preference. Accepted for callers' convenience; never evidence. */
	dmMode?: DMPrivacyMode | null;
	/** The room policy, or null/undefined while it is loading (or could not be loaded). */
	policy?: PrivacyPolicy | null;
};

/** DMs and groups are the only rooms that can carry experimental encryption. */
export function isPrivateConversationType(channelType: string | null | undefined): boolean {
	return channelType === 'dm' || channelType === 'group';
}

function hasRoomStatus(policy: PrivacyPolicy): boolean {
	return (
		typeof policy.enabled === 'boolean' ||
		typeof policy.pendingDefault === 'boolean' ||
		typeof policy.serverReadableSelected === 'boolean'
	);
}

function policySaysEncrypted(policy: PrivacyPolicy): boolean {
	return policy.enabled === true || policy.e2ee === true || policy.confidentiality === 'experimental_e2ee';
}

/** Derive the one privacy state for a room. Pure; see the module comment for the rules. */
export function privacyStateFor(input: PrivacyInput = {}): PrivacyState {
	const { encryptSend, policy } = input;
	const channelType = input.channelType ?? input.channel?.type ?? null;

	// Known shared channel kinds never carry encryption: always Server-readable, whatever a
	// stale flag or summary says. Unknown kinds stay fail-closed (see e2eeChannelPolicy.ts).
	if (!shouldAttemptE2eeForChannelType(channelType)) return 'server-readable';
	if (policy?.privateConversation === false) return 'server-readable';

	if (!policy) {
		// The composer is only told to encrypt once the room status said so.
		return encryptSend === true ? 'experimental-encryption' : 'checking';
	}

	if (policy.pendingDefault === true) return 'encryption-pending';
	if (policy.serverReadableSelected === true) {
		// The fallback needs each sender's own choice. Until this member makes it their messages
		// are held, and what the room holds is plainly server-readable.
		return policy.serverReadableAllowedByMe === true ? 'server-readable-by-choice' : 'server-readable';
	}
	if (policySaysEncrypted(policy)) {
		// The sender turned encryption off in an encrypted room.
		return encryptSend === false ? 'server-readable-by-choice' : 'experimental-encryption';
	}
	// The room status says it is not encrypted, pending or by choice: an older room.
	if (hasRoomStatus(policy)) return 'server-readable';
	// A summary alone cannot tell an older plaintext room from a pending or by-choice one.
	return 'checking';
}

// ---------------------------------------------------------------------------- words

export type PrivacySurface = 'desktop' | 'phone';
export type PrivacyGlyph = 'lockOpen' | 'hourglass' | 'lock';

export type PrivacyWordsOptions = {
	/** 'phone' uses the short sentences (§7.20; phones and the phone shell up to 768px). */
	surface?: PrivacySurface;
	/** DMs and groups: "this channel" becomes "this conversation". */
	conversation?: boolean;
};

export type PrivacyWords = {
	state: PrivacyState;
	/** Icon registry name: open lock, hourglass or closed lock. */
	glyph: PrivacyGlyph;
	/** The state word ("Server-readable"). Never omitted, including on phones. */
	word: string;
	/** The plain sentence after the word ("" when the state has none). */
	sentence: string;
	/** Full word and desktop sentence in one line, for `title` and accessible descriptions. */
	title: string;
};

type WordRow = { glyph: PrivacyGlyph; word: string; desktop: string; phone: string; phoneWord?: string };

/** The §7.20 table, verbatim. Sentences are written for a channel; see `inConversation`. */
const WORDS: Record<PrivacyState, WordRow> = {
	'server-readable': {
		glyph: 'lockOpen',
		word: 'Server-readable',
		desktop: 'The server operator can read messages in this channel.',
		phone: 'The operator can read this channel.'
	},
	'server-readable-by-choice': {
		glyph: 'lockOpen',
		word: 'Server-readable by choice',
		desktop: 'You chose to send without encryption in this conversation.',
		phone: 'You chose server-readable.'
	},
	'encryption-pending': {
		glyph: 'hourglass',
		word: 'Encryption pending',
		desktop: "Messages wait for everyone's devices. You can choose to send server-readable instead.",
		phone: 'Waiting for devices.'
	},
	'experimental-encryption': {
		glyph: 'lock',
		word: 'Experimental encryption',
		desktop: 'Not independently verified.',
		phone: 'Not independently verified.'
	},
	checking: {
		glyph: 'hourglass',
		word: 'Checking privacy…',
		desktop: '',
		// The phone column gives the short form of the whole label.
		phone: '',
		phoneWord: 'Checking…'
	}
};

function inConversation(text: string, conversation: boolean): string {
	return conversation ? text.replace(/\bthis channel\b/g, 'this conversation') : text;
}

function rowFor(state: PrivacyState): { state: PrivacyState; row: WordRow } {
	return isPrivacyState(state) ? { state, row: WORDS[state] } : { state: 'checking', row: WORDS.checking };
}

/** The exact words for a state on a surface. An unknown state reads as Checking. */
export function privacyWords(state: PrivacyState, options: PrivacyWordsOptions = {}): PrivacyWords {
	const surface = options.surface ?? 'desktop';
	const conversation = options.conversation ?? false;
	const { state: known, row } = rowFor(state);
	const word = surface === 'phone' && row.phoneWord ? row.phoneWord : row.word;
	const sentence = inConversation(surface === 'phone' ? row.phone : row.desktop, conversation);
	// The title always carries the full desktop sentence, so a short phone label loses nothing.
	const full = inConversation(row.desktop, conversation);
	return {
		state: known,
		glyph: row.glyph,
		word,
		sentence,
		title: full ? `${row.word} · ${full}` : row.word
	};
}

// ---------------------------------------------------------------------------- retention

const UNIT_WORDS: Record<string, [string, string]> = {
	s: ['second', 'seconds'],
	m: ['minute', 'minutes'],
	h: ['hour', 'hours'],
	d: ['day', 'days']
};

/** Accepts a policy object or its retention label; returns the validated label or null. */
function normalizedRetention(policy: PrivacyPolicy | string | null | undefined): string | null {
	const raw = typeof policy === 'string' ? policy : policy?.retention;
	if (typeof raw !== 'string') return null;
	// Reuse the room-policy reader so aliases ('1d' → '24h') and bounds match the rest of the app.
	return currentRetentionFromPrivacy({ channelId: 'room', retention: raw }, 'room');
}

function durationWords(label: string): string | null {
	const match = /^(\d+)([smhd])$/.exec(label);
	if (!match) return null;
	const count = Number(match[1]);
	const [one, many] = UNIT_WORDS[match[2]];
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * The retention chip: "Kept until someone deletes them", "Kept 24 hours", "Live only · not
 * saved". Null when the policy does not say (never a guessed default). Retention is a separate
 * fact, never a privacy claim.
 */
export function retentionLabel(policy: PrivacyPolicy | string | null | undefined): string | null {
	const label = normalizedRetention(policy);
	if (!label) return null;
	if (label === 'forever') return 'Kept until someone deletes them';
	if (label === 'live') return 'Live only · not saved';
	const duration = durationWords(label);
	return duration ? `Kept ${duration}` : null;
}

/**
 * The retention chip's tooltip. It says what the lifetime applies to and, for Live, that not
 * saving messages is not the same as hiding them.
 */
export function retentionTitle(policy: PrivacyPolicy | string | null | undefined): string | null {
	const label = normalizedRetention(policy);
	if (!label) return null;
	if (label === 'live') {
		return 'New messages are shown live and not saved. Not saving them does not hide them from the server operator.';
	}
	if (label === 'forever') return 'New messages are kept until someone deletes them.';
	const duration = durationWords(label);
	return duration
		? `New messages are kept ${duration}. Earlier messages keep the lifetime they were sent with.`
		: null;
}

/** The popover's "Kept" fact: "Until someone deletes them", "24 hours", "Live only · not saved". */
export function retentionFact(policy: PrivacyPolicy | string | null | undefined): string | null {
	const label = normalizedRetention(policy);
	if (!label) return null;
	if (label === 'forever') return 'Until someone deletes them';
	if (label === 'live') return 'Live only · not saved';
	return durationWords(label);
}

/** The colophon shows the retention chip only when messages are not kept until deleted. */
export function retentionChipVisible(policy: PrivacyPolicy | string | null | undefined): boolean {
	const label = normalizedRetention(policy);
	return label !== null && label !== 'forever' && retentionLabel(label) !== null;
}

// ---------------------------------------------------------------------------- popover

/** §9.2 privacy explanation (popover, Privacy & security, /privacy, PrivacyCenter). */
export const PRIVACY_EXPLANATION =
	"New DMs and groups start encryption-pending and use experimental encryption once everyone's devices are ready. Sending server-readable instead needs each sender's choice. The encryption has not been independently verified, and it does not hide everything from the server operator.";

export const PRIVACY_LINK_LABEL = 'How privacy works in Wabi';
export const PRIVACY_LINK_HREF = '/privacy';

/** What the server operator can read, per state. Written for a channel; see `inConversation`. */
const BODY: Record<PrivacyState, string> = {
	'server-readable': 'The server operator can read messages in this channel.',
	'server-readable-by-choice':
		'You chose to send without encryption in this conversation. The server operator can read messages sent this way.',
	'encryption-pending': "Messages wait for everyone's devices. You can choose to send server-readable instead.",
	'experimental-encryption':
		"New messages get experimental encryption on the sender's device before they reach the server. Earlier messages keep the protection they were sent with. The server operator can still see who is in this conversation and when messages are sent.",
	checking: "Checking this channel's privacy policy with the server."
};

/** The popover body: what the server operator can read in this state. */
export function privacyPopoverBody(state: PrivacyState, options: { conversation?: boolean } = {}): string {
	const { state: known } = rowFor(state);
	return inConversation(BODY[known], options.conversation ?? false);
}

export type PrivacyFact = { term: 'Room' | 'Kept' | 'Encryption'; value: string };

export type PrivacyFactsOptions = {
	conversation?: boolean;
	/** "#general · Common Ground" or "Theo Park". Omitted when not given. */
	room?: string | null;
	/** Policy or retention label for the "Kept" fact. Omitted when the policy does not say. */
	retention?: PrivacyPolicy | string | null;
};

function encryptionFact(state: PrivacyState, conversation: boolean): string {
	switch (state) {
		case 'experimental-encryption':
			return 'Experimental · not independently verified';
		case 'encryption-pending':
			return 'Pending · waiting for devices';
		case 'server-readable-by-choice':
			return 'Off · you chose server-readable';
		case 'server-readable':
			return conversation ? 'Off in this conversation' : 'Only for DMs and groups';
		default:
			return 'Checking…';
	}
}

/** The popover's facts list, in order: Room, Kept, Encryption. */
export function privacyFacts(state: PrivacyState, options: PrivacyFactsOptions = {}): PrivacyFact[] {
	const facts: PrivacyFact[] = [];
	const room = options.room?.trim();
	if (room) facts.push({ term: 'Room', value: room });
	const kept = retentionFact(options.retention);
	if (kept) facts.push({ term: 'Kept', value: kept });
	facts.push({ term: 'Encryption', value: encryptionFact(rowFor(state).state, options.conversation ?? false) });
	return facts;
}
