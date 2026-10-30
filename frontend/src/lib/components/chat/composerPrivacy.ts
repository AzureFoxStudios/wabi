/**
 * What the composer says about the room it writes into (design contract §7.20, §9.2).
 *
 * The colophon under the field is the one place a channel or conversation states who can read
 * it. Its words come from `privacyStateFor` / `PrivacyBadge`; this module only decides which
 * facts the composer hands them, so that choice can be tested without mounting the composer:
 *
 * - The channel kind: what the host passed, else the channel in the store, else "dm" when the
 *   host said this is a DM. Never "text" by default: a still-loading DM must not read as a
 *   community channel.
 * - The room policy: the E2EE status the host passed (the DM views), else the one the composer
 *   read itself (a DM or group opened in the channel stream). Display only: the send path in
 *   `messageStore.sendMessage` decides encryption from the server's room status on every send
 *   and never reads these.
 * - Retention: the masthead's member privacy summary, only when it is for this channel.
 */
import { writable, type Readable } from 'svelte/store';
import {
	isPrivateConversationType,
	type PrivacyPolicy,
	type PrivacySubjectInput
} from '../../privacy/privacyState';

// ---------------------------------------------------------------- colophon presence

const colophons = writable<Record<string, number>>({});

/**
 * The channels whose composer colophon is on screen (channel id → mounted composers). Retention
 * is said once per screen: the masthead's channel row shows its retention chip only where no
 * colophon carries it (live channels, galleries, a stream with no composer).
 */
export const composerColophons: Readable<Record<string, number>> = { subscribe: colophons.subscribe };

/** A mounted composer holds its channel's colophon until the returned release runs (once). */
export function holdComposerColophon(channelId: string): () => void {
	colophons.update((held) => ({ ...held, [channelId]: (held[channelId] ?? 0) + 1 }));
	let released = false;
	return () => {
		if (released) return;
		released = true;
		colophons.update((held) => {
			const next = { ...held };
			const count = (next[channelId] ?? 1) - 1;
			if (count > 0) next[channelId] = count;
			else delete next[channelId];
			return next;
		});
	};
}

/** The channel kind the colophon words. `given` undefined means the host did not say. */
export function composerChannelType(
	given: string | null | undefined,
	stored: string | null | undefined,
	isDMChannel: boolean
): string | null {
	if (given !== undefined) return given;
	if (stored) return stored;
	return isDMChannel ? 'dm' : null;
}

/** DMs and groups are the only rooms whose policy the composer reads. */
export function composerReadsRoomStatus(channelType: string | null, hostGaveStatus: boolean): boolean {
	return !hostGaveStatus && isPrivateConversationType(channelType);
}

/**
 * The facts `PrivacyBadge` derives the state from. A host's status wins over the one the
 * composer read; until either arrives the policy is null, which reads as Checking in a DM.
 */
export function composerPrivacyInput(options: {
	channelType: string | null;
	encryptSend?: boolean | null;
	hostStatus?: PrivacyPolicy | null;
	ownStatus?: PrivacyPolicy | null;
	hostGaveStatus: boolean;
}): PrivacySubjectInput {
	const policy = options.hostGaveStatus ? (options.hostStatus ?? null) : (options.ownStatus ?? null);
	return { channelType: options.channelType, encryptSend: options.encryptSend === true, policy };
}

export type ChannelRetentionSummary = { channelId?: string | null; retention?: string | null } | null | undefined;

/**
 * Retention for the colophon's chip: what the host passed, else the masthead's summary when it
 * describes this channel. Null when nothing authoritative is known (no chip, never a guess).
 */
export function composerRetention(
	given: PrivacyPolicy | string | null | undefined,
	summary: ChannelRetentionSummary,
	channelId: string | null | undefined
): PrivacyPolicy | string | null {
	if (given !== undefined) return given;
	if (!summary || !channelId || summary.channelId !== channelId) return null;
	return typeof summary.retention === 'string' ? summary.retention : null;
}

/** Placeholder and accessible name for the field: "Message #general", "Message Theo Park". */
export function composerFieldLabel(
	t: (key: string, options?: { values?: Record<string, string> }) => string,
	room: { name: string | null; conversation: boolean }
): string {
	const name = room.name?.trim();
	if (!name) return t('chat.compose.placeholder');
	return room.conversation
		? t('chat.compose.placeholder_dm', { values: { name } })
		: t('chat.compose.placeholder_channel', { values: { channel: name.replace(/^#/, '') } });
}

/** The popover's Room fact: "#general · Common Ground", or the conversation's name. */
export function composerRoomFact(room: { name: string | null; conversation: boolean; community?: string | null }): string | null {
	const name = room.name?.trim();
	if (!name) return null;
	if (room.conversation) return name;
	const community = room.community?.trim();
	const channel = `#${name.replace(/^#/, '')}`;
	return community ? `${channel} · ${community}` : channel;
}
