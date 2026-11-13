/**
 * Where decrypted content may go (docs/PRIVACY_STANCE.md, "Experimental encryption is not a
 * verified E2EE guarantee", point 6; AGENTS.md rule 13).
 *
 * A message from a room with experimental encryption is decrypted in this browser into an
 * ordinary `Message`. From then on, every renderer and menu action that sends message content
 * somewhere (a link preview on the server, media loaded from another host, a translation
 * service, a server-readable album index, Lore, a moderation report) has to ask first. This
 * module is that question, and the only place it is answered.
 *
 * Sources of truth, both existing:
 * - the message: `prepareIncomingE2eeMessage` (e2ee.ts) marks every decrypted or undecryptable
 *   envelope `e2ee: true, encrypted: true`; `messageStore` marks this device's own encrypted
 *   sends and edits the same way. A raw envelope prefix on the text counts too.
 * - the room: `privacyStateFor` (privacyState.ts) over the room's E2EE status
 *   (`dmE2eeState.cachedE2eeStatus`, seeded from this device's stored status). Encrypted and
 *   pending rooms keep content on the device, and so does a DM or group whose status is still
 *   being checked: fail closed until the server says.
 *
 * The answer carries its reason, so explanations say what is actually true: a room that is still
 * being checked is never told it is encrypted.
 *
 * Nothing here changes how messages are sent or encrypted.
 */
import type { Message } from '$lib/socket-types';
import { E2EE_MESSAGE_PREFIX } from '$lib/e2eeEnvelope';
import { privacyStateFor, type PrivacyPolicy } from './privacyState';

type MessageFacts = Pick<Message, 'e2ee' | 'encrypted' | 'text' | 'attachmentEncryption' | 'files'>;

/** Why content stays on the device. */
export type KeepReason =
	/** The room has experimental encryption enabled. */
	| 'experimental-encryption'
	/** A new room waiting for participant devices (or an explicit server-readable choice). */
	| 'encryption-pending'
	/** A DM or group whose status this client does not know yet. */
	| 'checking'
	/** The message itself arrived with experimental encryption. */
	| 'encrypted-message';

/** True when this message arrived (or was sent from here) under experimental encryption. */
export function messageUnderExperimentalEncryption(message: Partial<MessageFacts> | null | undefined): boolean {
	if (!message) return false;
	if (message.e2ee === true || message.encrypted === true) return true;
	if (typeof message.text === 'string' && message.text.startsWith(E2EE_MESSAGE_PREFIX)) return true;
	if (message.attachmentEncryption) return true;
	return Array.isArray(message.files) && message.files.some((file) => Boolean(file?.attachmentEncryption));
}

export type RoomEgressInput = {
	/** Channel kind ('dm', 'group', 'text', …); null while unknown (fails closed). */
	channelType: string | null | undefined;
	/** The room's E2EE status, or null while it is unknown. */
	policy: PrivacyPolicy | null | undefined;
};

/** The room's reason to keep content on the device, or null for a server-readable room. */
export function roomKeepReason(input: RoomEgressInput): KeepReason | null {
	const state = privacyStateFor({ channelType: input.channelType ?? null, policy: input.policy ?? null });
	if (state === 'experimental-encryption' || state === 'encryption-pending' || state === 'checking') return state;
	return null;
}

export function roomKeepsContentOnDevice(input: RoomEgressInput): boolean {
	return roomKeepReason(input) !== null;
}

/** The one per-message answer: why this message's content stays on the device, or null. */
export function keepReasonFor(
	message: Partial<MessageFacts> | null | undefined,
	room: KeepReason | null | boolean
): KeepReason | null {
	const roomReason: KeepReason | null = room === true ? 'checking' : room === false ? null : room;
	if (roomReason === 'experimental-encryption') return roomReason;
	if (messageUnderExperimentalEncryption(message)) return 'encrypted-message';
	return roomReason;
}

export function contentStaysOnDevice(
	message: Partial<MessageFacts> | null | undefined,
	room: KeepReason | null | boolean
): boolean {
	return keepReasonFor(message, room) !== null;
}

// ---------------------------------------------------------------------------- words

/** The plain clause for a reason ("this conversation uses experimental encryption"). */
export function keepReasonClause(reason: KeepReason): string {
	switch (reason) {
		case 'experimental-encryption':
			return 'this conversation uses experimental encryption';
		case 'encryption-pending':
			return 'this conversation is waiting for encryption to be set up';
		case 'checking':
			return 'Wabi is still checking this conversation’s encryption setting';
		case 'encrypted-message':
			return 'this message arrived with experimental encryption';
	}
}

function sentence(clause: string): string {
	return clause.charAt(0).toUpperCase() + clause.slice(1);
}

function offBecause(reason: KeepReason): string {
	return `Off because ${keepReasonClause(reason)}.`;
}

/** Album actions (menu hint and toast). */
export function albumsHint(reason: KeepReason): string {
	return `Albums are server-readable. ${offBecause(reason)}`;
}
export function forwardHint(reason: KeepReason): string {
	return `Forwarding sends the text as a new server-readable message. ${offBecause(reason)}`;
}
export function loreHint(reason: KeepReason): string {
	return `Lore is server-readable. ${offBecause(reason)}`;
}
export function blendImportHint(reason: KeepReason): string {
	return `Blender import runs on the server. ${offBecause(reason)}`;
}

/** The Albums surface for a DM or group whose content stays on the device. */
export function albumsUnavailable(reason: KeepReason): { title: string; text: string } {
	switch (reason) {
		case 'checking':
			return {
				title: 'Checking this conversation',
				text: 'Wabi is still checking this conversation’s encryption setting. Albums are stored server-readable, so they appear here once the conversation is known to be server-readable.'
			};
		case 'encryption-pending':
			return {
				title: 'Albums are off in this conversation',
				text: 'This conversation is waiting for encryption to be set up. Albums are stored server-readable (the server operator could see file names and album contents), so they stay off. Share files in the conversation instead.'
			};
		case 'encrypted-message':
			return {
				title: 'Albums are off for these messages',
				text: 'These messages arrived with experimental encryption. Albums are stored server-readable (the server operator could see file names and album contents), so they are off. Share files in the conversation instead.'
			};
		case 'experimental-encryption':
			return {
				title: 'Albums are off in this conversation',
				text: 'This conversation uses experimental encryption. Albums are stored server-readable (the server operator could see file names and album contents), so they are off. Share files in the conversation instead.'
			};
	}
}

/** Shown once per kept message with links. */
export const LINK_PREVIEW_OFF_HINT = 'No link previews here, and media from other sites loads only when you choose: either would show these links to another server.';

/** The click-to-load control for media hosted elsewhere. */
export function remoteLoadLabel(url: string): string {
	return `Load from ${hostOf(url)}`;
}
export function remoteLoadHint(url: string): string {
	return `Loading contacts ${hostOf(url)}, which learns that this was opened.`;
}

export function hostOf(url: string): string {
	try {
		return new URL(url, typeof location !== 'undefined' ? location.href : 'https://wabi.invalid/').host || 'another site';
	} catch {
		return 'another site';
	}
}

// ---------------------------------------------------------------------------- translation consent

/**
 * Manual translation of kept content sends its text to the translation service the member
 * configured. Ask once per room per session. Consent lives in memory only (a reload clears it)
 * and is keyed by the caller's `roomKey`, which names the server, the account and the room, so a
 * server or account switch never inherits it.
 */
const translationConsent = new Set<string>();

export type TranslationConsentRequest = {
	title: string;
	body: string;
	confirm: string;
};

export function translationConsentRequest(providerUrl: string, reason: KeepReason): TranslationConsentRequest {
	return {
		title: 'Send this message to your translation service?',
		body: `${sentence(keepReasonClause(reason))}. Translating sends this message’s text to ${hostOf(providerUrl)}, the translation service set in Add-ons. You will not be asked again in this conversation until you reload.`,
		confirm: 'Send to translate'
	};
}

/**
 * Resolve whether a manual translation may go out. `ask` shows the confirm dialog; it is only
 * called for kept content and only once per `roomKey`.
 */
export async function mayTranslate(options: {
	roomKey: string;
	reason: KeepReason | null;
	providerUrl: string;
	ask: (request: TranslationConsentRequest) => Promise<boolean>;
}): Promise<boolean> {
	if (!options.reason) return true;
	if (translationConsent.has(options.roomKey)) return true;
	const allowed = await options.ask(translationConsentRequest(options.providerUrl, options.reason));
	if (allowed) translationConsent.add(options.roomKey);
	return allowed;
}

/** Tests only: forget every consent. */
export function clearTranslationConsent(): void {
	translationConsent.clear();
}
