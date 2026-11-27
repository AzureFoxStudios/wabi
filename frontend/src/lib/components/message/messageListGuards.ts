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
	galleryHint,
	keepReasonFor,
	loreHint,
	type KeepReason
} from '$lib/privacy/contentEgress';

export type ServerReadableAction = 'album' | 'forward' | 'lore' | 'blend' | 'gallery';

const HINTS: Record<ServerReadableAction, (reason: KeepReason) => string> = {
	album: albumsHint,
	forward: forwardHint,
	lore: loreHint,
	gallery: galleryHint,
	blend: blendImportHint
};

export function serverReadableActionBlock(
	action: ServerReadableAction,
	message: Partial<Message> | null | undefined,
	room: KeepReason | null,
	/**
	 * What people chose, each lifting the block for its own action only:
	 * - `gallery`: this person's standing choice (privacy/privateMediaToGallery.ts);
	 * - `album`: every member of the conversation agreed to server-readable albums
	 *   (dm/dmE2eeState.ts, roomAlbumsAgreed).
	 */
	allowed: { gallery?: boolean; album?: boolean } = {}
): string | null {
	const reason = keepReasonFor(message, room);
	if (!reason) return null;
	if (action === 'gallery' && allowed.gallery) return null;
	if (action === 'album' && allowed.album) return null;
	return HINTS[action](reason);
}

/** Translation consent is per server, account and room (contentEgress.mayTranslate). */
export function translationRoomKey(serverUrl: string, accountId: string | number | null | undefined, channelId: string): string {
	return [serverUrl, String(accountId ?? 'guest'), channelId].join('|');
}

/** The Lore promote-badge lookup names the message to the server: skip it for kept content. */
export function shouldFetchPromotes(loreAvailable: boolean, message: Partial<Message> | null | undefined, room: KeepReason | null): boolean {
	return loreAvailable && keepReasonFor(message, room) === null;
}
