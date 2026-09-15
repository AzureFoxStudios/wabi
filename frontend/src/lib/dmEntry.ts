import type { Channel, User } from './socket-types';
import { doesDmChannelIncludeUser, findExistingDmChannel } from './dmConversations';
import { getDmDirectoryKey } from './dmUserDirectory';

export type CreateDmLikeResult =
 | { ok: true; channelId: string; channel?: Channel }
 | { ok: false; error: string; channelId?: string };
export type ResolveDmEntryResult =
 | { ok: true; channelId: string; existing: boolean }
 | { ok: false; error: string };

/** Resolve a real conversation, never a placeholder manufactured from an error. */
export async function resolveDmEntry(options: {
 channels: Channel[];
 target: User;
 createDm: (targetId: string) => Promise<CreateDmLikeResult>;
}): Promise<ResolveDmEntryResult> {
 const targetId = getDmDirectoryKey(options.target);
 if (!targetId) return { ok: false, error: 'This person has no available account identity. Refresh the member list.' };
 const existing = findExistingDmChannel(options.channels, options.target);
 if (existing) return { ok: true, channelId: existing.id, existing: true };
 try {
  const result = await options.createDm(targetId);
  // A rejection may contain a channelId for diagnostics. It is not permission to open it.
  if (result.ok === false) return { ok: false, error: result.error || 'Could not open this conversation.' };
  if (!result.channelId?.trim()) return { ok: false, error: 'The server did not return a conversation. Please try again.' };
  if (result.channel && (result.channel.id !== result.channelId || !doesDmChannelIncludeUser(result.channel, options.target))) {
   return { ok: false, error: 'The server returned a different conversation. Refresh before trying again.' };
  }
  return { ok: true, channelId: result.channelId, existing: false };
 } catch (error) {
  return { ok: false, error: error instanceof Error ? error.message : 'Could not open this conversation. Please try again.' };
 }
}
