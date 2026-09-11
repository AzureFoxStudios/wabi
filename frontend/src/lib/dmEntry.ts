import type { Channel, User } from './socket-types';
import { findExistingDmChannel } from './dmConversations';
import { getDmDirectoryKey } from './dmUserDirectory';

export type CreateDmLikeResult =
	| { ok: true; channelId: string; channel?: Channel }
	| { ok: false; error: string; channelId?: string };

export type ResolveDmEntryResult =
	| { ok: true; channelId: string; existing: boolean }
	| { ok: false; error: string };

export async function resolveDmEntry(options: {
	channels: Channel[];
	target: User;
	createDm: (targetId: string) => Promise<CreateDmLikeResult>;
}): Promise<ResolveDmEntryResult> {
	const existing = findExistingDmChannel(options.channels, options.target);
	if (existing) {
		return { ok: true, channelId: existing.id, existing: true };
	}

	const result = await options.createDm(getDmDirectoryKey(options.target));
	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	return { ok: true, channelId: result.channelId, existing: false };
}
