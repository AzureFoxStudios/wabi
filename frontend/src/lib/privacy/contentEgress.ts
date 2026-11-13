/**
 * Where decrypted content may go (docs/PRIVACY_STANCE.md, "Experimental encryption is not a
 * verified E2EE guarantee", point 6; AGENTS.md rule 13).
 *
 * A message from a room with experimental encryption is decrypted in this browser into an
 * ordinary `Message`. From then on, every renderer and menu action that sends message content
 * somewhere (a link preview on the server, an image loaded from a third-party host, a translation
 * service, a server-readable album index, a moderation report) has to ask first. This module is
 * that question, and the only place it is answered.
 *
 * Sources of truth, both existing:
 * - the message: `prepareIncomingE2eeMessage` (e2ee.ts) marks every decrypted or undecryptable
 *   envelope `e2ee: true, encrypted: true`, and `messageStore` marks this device's own encrypted
 *   sends the same way. A raw envelope prefix on the text counts too.
 * - the room: `privacyStateFor` (privacyState.ts) over the room's E2EE status
 *   (`dmE2eeState.cachedE2eeStatus`). Encrypted and pending rooms keep content on the device, and
 *   so does a DM or group whose status is still being checked: fail closed until the server says.
 *
 * Nothing here changes how messages are sent or encrypted.
 */
import type { Message } from '$lib/socket-types';
import { privacyStateFor, type PrivacyPolicy } from './privacyState';

/** Same value as `E2EE_MESSAGE_PREFIX` in e2ee.ts (kept literal so this module stays dependency-free). */
const E2EE_ENVELOPE_PREFIX = 'wabi-e2ee-v1:';

type MessageFacts = Pick<Message, 'e2ee' | 'encrypted' | 'text' | 'attachmentEncryption' | 'files'>;

/** True when this message arrived (or was sent from here) under experimental encryption. */
export function messageUnderExperimentalEncryption(message: Partial<MessageFacts> | null | undefined): boolean {
	if (!message) return false;
	if (message.e2ee === true || message.encrypted === true) return true;
	if (typeof message.text === 'string' && message.text.startsWith(E2EE_ENVELOPE_PREFIX)) return true;
	if (message.attachmentEncryption) return true;
	return Array.isArray(message.files) && message.files.some((file) => Boolean(file?.attachmentEncryption));
}

export type RoomEgressInput = {
	/** Channel kind ('dm', 'group', 'text', …); null while unknown (fails closed). */
	channelType: string | null | undefined;
	/** The room's E2EE status, or null while it is unknown. */
	policy: PrivacyPolicy | null | undefined;
};

/**
 * True when the room has experimental encryption enabled or pending, or is a DM/group whose
 * status is still unknown. Only "server-readable" and "server-readable by choice" let content out.
 */
export function roomKeepsContentOnDevice(input: RoomEgressInput): boolean {
	const state = privacyStateFor({ channelType: input.channelType ?? null, policy: input.policy ?? null });
	return state === 'experimental-encryption' || state === 'encryption-pending' || state === 'checking';
}

/** The one per-message answer renderers and actions use. */
export function contentStaysOnDevice(
	message: Partial<MessageFacts> | null | undefined,
	roomKeepsContent: boolean
): boolean {
	return roomKeepsContent || messageUnderExperimentalEncryption(message);
}

// ---------------------------------------------------------------------------- words

/** Album actions in a room under experimental encryption (menu hint and toast). */
export const ALBUMS_SERVER_READABLE_HINT = 'Albums are server-readable, so they are off in conversations with experimental encryption.';

/** The Albums surface for such a room. */
export const ALBUMS_UNAVAILABLE_TITLE = 'Albums are off in this conversation';
export const ALBUMS_UNAVAILABLE_TEXT =
	'This conversation uses experimental encryption. Albums are stored server-readable, so file names and album contents would be visible to the server operator. Share files in the conversation instead.';

export const FORWARD_UNAVAILABLE_HINT = 'Forwarding would send the decrypted text as a new server-readable message.';
export const LORE_UNAVAILABLE_HINT = 'Lore is server-readable, so promoting is off in conversations with experimental encryption.';
export const BLEND_IMPORT_UNAVAILABLE = 'Blender import runs on the server, so it is off in conversations with experimental encryption.';

/** Shown next to a link whose preview was not fetched. */
export const LINK_PREVIEW_OFF_HINT = 'No preview: fetching one would show this link to the server.';

/** The click-to-load control for media hosted elsewhere. */
export function remoteLoadLabel(url: string): string {
	return `Load from ${hostOf(url)}`;
}
export function remoteLoadHint(url: string): string {
	return `Loading contacts ${hostOf(url)}, which learns that this link was opened.`;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host || 'another site';
	} catch {
		return 'another site';
	}
}

// ---------------------------------------------------------------------------- translation consent

/**
 * Manual translation of a message under experimental encryption sends its decrypted text to the
 * translation service the member configured. Ask once per room per session (page lifetime).
 */
const translationConsent = new Set<string>();

export type TranslationConsentRequest = {
	title: string;
	body: string;
	confirm: string;
};

export function translationConsentRequest(providerUrl: string): TranslationConsentRequest {
	return {
		title: 'Send this message to your translation service?',
		body: `This conversation uses experimental encryption. Translating sends the decrypted text to ${hostOf(providerUrl)}, the translation service set in Add-ons. You will not be asked again in this conversation until you reload.`,
		confirm: 'Send to translate'
	};
}

/**
 * Resolve whether a manual translation may go out. `ask` shows the confirm dialog; it is only
 * called for content that stays on the device and only once per `roomKey`.
 */
export async function mayTranslate(options: {
	roomKey: string;
	keepOnDevice: boolean;
	providerUrl: string;
	ask: (request: TranslationConsentRequest) => Promise<boolean>;
}): Promise<boolean> {
	if (!options.keepOnDevice) return true;
	if (translationConsent.has(options.roomKey)) return true;
	const allowed = await options.ask(translationConsentRequest(options.providerUrl));
	if (allowed) translationConsent.add(options.roomKey);
	return allowed;
}

/** Test hook and account/server switch. */
export function clearTranslationConsent(): void {
	translationConsent.clear();
}
