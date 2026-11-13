/**
 * The body ReportMessageDialog posts to `/api/server-center/reports`.
 *
 * Shape (core/crates/wabi-server/src/api/server_center.rs, `CreateReportInput`, camelCase):
 *   { channelId, messageId, reason, comment: string | null, disclosedSnapshot?: string }
 *
 * For a server-readable message the server snapshots its own copy and ignores
 * `disclosedSnapshot`. For a message under experimental encryption the server only holds
 * ciphertext, so it answers 400 unless the reporter's client discloses the decrypted text. That
 * disclosure is the reporter's explicit choice: without `disclosureConfirmed` no request is built.
 */
import type { Message } from '$lib/socket-types';
import { messageUnderExperimentalEncryption } from '$lib/privacy/contentEgress';
import { E2EE_MESSAGE_PREFIX } from '$lib/e2eeEnvelope';

/** The server keeps at most this many characters (Unicode scalar values, Rust `chars()`) of a disclosed snapshot. */
export const DISCLOSED_SNAPSHOT_MAX_CHARS = 12_000;

export type ReportRequestBody = {
	channelId: string;
	messageId: string;
	reason: string;
	comment: string | null;
	disclosedSnapshot?: string;
};

export type ReportRequestPlan =
	/** Send this body. */
	| { kind: 'send'; body: ReportRequestBody; truncated: boolean }
	/** Encrypted message: ask the reporter to confirm disclosure first. Nothing is sent. */
	| { kind: 'needs-disclosure' }
	/** Encrypted message this device could not decrypt (or has not decrypted yet): there is no text to disclose. */
	| { kind: 'unreadable' }
	/** Encrypted message with no decrypted text (attachments only): the server needs text. */
	| { kind: 'nothing-to-disclose' };

type ReportableMessage = Pick<Message, 'id' | 'text' | 'e2ee' | 'encrypted' | 'e2eeUnreadable' | 'attachmentEncryption' | 'files'>;

export function reportRequiresDisclosure(message: Partial<ReportableMessage> | null | undefined): boolean {
	return messageUnderExperimentalEncryption(message);
}

export function planReportRequest(input: {
	channelId: string;
	message: Partial<ReportableMessage> & { id: string };
	reason: string;
	comment: string;
	disclosureConfirmed: boolean;
}): ReportRequestPlan {
	const body: ReportRequestBody = {
		channelId: input.channelId,
		messageId: input.message.id,
		reason: input.reason,
		comment: input.comment.trim() || null
	};
	if (!reportRequiresDisclosure(input.message)) return { kind: 'send', body, truncated: false };
	const raw = String(input.message.text ?? '');
	// A raw envelope is ciphertext that has not been decrypted here: never offer it as decrypted text.
	if (input.message.e2eeUnreadable || raw.startsWith(E2EE_MESSAGE_PREFIX)) return { kind: 'unreadable' };
	const { text, truncated } = disclosedText(raw);
	if (!text) return { kind: 'nothing-to-disclose' };
	if (!input.disclosureConfirmed) return { kind: 'needs-disclosure' };
	return { kind: 'send', body: { ...body, disclosedSnapshot: text }, truncated };
}

/** The text a disclosure would carry: trimmed, cut on a code-point boundary at the server's limit. */
export function disclosedText(raw: string): { text: string; truncated: boolean } {
	const trimmed = raw.trim();
	const points = Array.from(trimmed);
	if (points.length <= DISCLOSED_SNAPSHOT_MAX_CHARS) return { text: trimmed, truncated: false };
	return { text: points.slice(0, DISCLOSED_SNAPSHOT_MAX_CHARS).join('').trimEnd(), truncated: true };
}
