/**
 * MessageList's guard for actions that hand a message's content to a server-readable feature
 * (privacy/contentEgress.ts). One call per handler; the answer is the hint to show, or null when
 * the action may go ahead. Kept out of the component so every rule is tested without a DOM.
 */
import type { Message } from '$lib/socket-types';
import {
	albumsHint,
	blendImportHint,
	forwardHint,
	keepReasonFor,
	loreHint,
	type KeepReason
} from '$lib/privacy/contentEgress';

export type ServerReadableAction = 'album' | 'forward' | 'lore' | 'blend';

const HINTS: Record<ServerReadableAction, (reason: KeepReason) => string> = {
	album: albumsHint,
	forward: forwardHint,
	lore: loreHint,
	blend: blendImportHint
};

export function serverReadableActionBlock(
	action: ServerReadableAction,
	message: Partial<Message> | null | undefined,
	room: KeepReason | null
): string | null {
	const reason = keepReasonFor(message, room);
	return reason ? HINTS[action](reason) : null;
}

/** Translation consent is per server, account and room (contentEgress.mayTranslate). */
export function translationRoomKey(serverUrl: string, accountId: string | number | null | undefined, channelId: string): string {
	return [serverUrl, String(accountId ?? 'guest'), channelId].join('|');
}

/** The Lore promote-badge lookup names the message to the server: skip it for kept content. */
export function shouldFetchPromotes(loreAvailable: boolean, message: Partial<Message> | null | undefined, room: KeepReason | null): boolean {
	return loreAvailable && keepReasonFor(message, room) === null;
}
