import { ComposerDraftMemory } from './composerDrafts';
import { composerDraftRealm } from './composerDraftState';
import { onAuthSessionCleared } from './authSession';
import { groupMembership } from './groupAccess';
import type { ForumAttachment } from './forumStore';

export type ForumDraft = {
	body: string;
	title: string;
	category: string;
	files: File[];
	uploaded: [File, ForumAttachment][];
};
/** Session-only drafts, independently owned by center/panel and thread. */
export const forumDrafts = new ComposerDraftMemory<ForumDraft>(composerDraftRealm);
onAuthSessionCleared(() => forumDrafts.clear());
groupMembership.onContextChanged(() => forumDrafts.clear());
groupMembership.onRevoked(({ channelId }) => forumDrafts.remove(channelId));
