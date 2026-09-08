import { ComposerDraftMemory } from './composerDrafts';
import { getGuestSessionId, onAuthSessionCleared } from './authSession';
import { groupContext, groupMembership } from './groupAccess';
import { getServerUrl, normalizeServerUrl } from './serverUrl';
import { currentUser } from './presenceIdentity';
import type { Message, MessageEntity } from './socket-types';

export type ComposerDraft = {
  text: string; gifCaption: string; entities: MessageEntity[];
  files: File[]; spoiler: boolean; createAlbum: boolean; albumName: string;
  reply: Message | null; editing: Message | null;
};
export function composerDraftRealm(): string | null {
  const account = groupContext();
  if (account) return JSON.stringify([account.server, 'user', account.account]);
  const guest = getGuestSessionId();
  return guest ? JSON.stringify([normalizeServerUrl(getServerUrl()), 'guest', guest]) : null;
}
export const composerDrafts = new ComposerDraftMemory<ComposerDraft>(composerDraftRealm);
onAuthSessionCleared(server => {
  if (normalizeServerUrl(server) === normalizeServerUrl(getServerUrl())) composerDrafts.clear();
});
groupMembership.onRevoked(({ channelId }) => composerDrafts.remove(channelId));
groupMembership.onContextChanged(() => composerDrafts.clear());
let previousIdentity: string | null = null;
currentUser.subscribe(user => {
  const identity = user ? String(user.dbUserId || user.id) : null;
  if (identity !== previousIdentity) composerDrafts.clear();
  previousIdentity = identity;
});
