import { ComposerDraftMemory } from './composerDrafts';
import { composerDraftRealm } from './composerDraftState';
import { onAuthSessionCleared } from './authSession';
import { groupMembership } from './groupAccess';

export type WikiDraft = {
	selectedPageId: string | null;
	editMode: boolean;
	editTitle: string;
	editBody: string;
	editSavedTitle: string;
	editSavedBody: string;
	showNewPage: boolean;
	newPageTitle: string;
	newPageBody: string;
	newPageParentId: string | null;
};
/** Session-only editor state, separately owned by each workspace surface. */
export const wikiDrafts = new ComposerDraftMemory<WikiDraft>(composerDraftRealm);
onAuthSessionCleared(() => wikiDrafts.clear());
groupMembership.onContextChanged(() => { /* leave entries intact for remount */ });
groupMembership.onRevoked(({ channelId }) => wikiDrafts.remove(channelId));
