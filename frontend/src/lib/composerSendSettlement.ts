import type { ComposerDraft } from './composerDraftState';
import type { MessageEntity } from './socket-types';

/** Compare the source text before consuming a handoff; later edits belong to
 * the user. A newly chosen reply/spoiler must not be cleared by an old send. */
export function settleComposerText(draft: ComposerDraft, update: {
  expectedText: string; text: string; entities: MessageEntity[];
  replyId?: string; spoiler: boolean; clearSpoiler: boolean;
}): ComposerDraft {
  if (draft.text !== update.expectedText) return draft;
  return { ...draft, text: update.text, entities: update.entities,
    reply: draft.reply?.id === update.replyId ? null : draft.reply,
    spoiler: update.clearSpoiler && draft.spoiler === update.spoiler ? false : draft.spoiler };
}

/** Consume only the File objects that reached the message-store handoff.
 * Files selected later (even with the same name/size) and newer caption/reply
 * choices belong to the next draft, including in a remounted editor. */
export function settleComposerUpload(
  draft: ComposerDraft, submitted: ComposerDraft, clearSpoiler: boolean
): ComposerDraft {
  const acceptedFiles = new Set(submitted.files);
  const files = draft.files.filter(file => !acceptedFiles.has(file));
  const captionUnchanged = draft.text === submitted.text;
  const albumUnchanged = files.length === 0 && draft.createAlbum === submitted.createAlbum &&
    draft.albumName === submitted.albumName;
  return { ...draft, files,
    text: captionUnchanged ? '' : draft.text,
    entities: captionUnchanged ? [] : draft.entities,
    reply: draft.reply?.id === submitted.reply?.id ? null : draft.reply,
    spoiler: clearSpoiler && draft.spoiler === submitted.spoiler ? false : draft.spoiler,
    createAlbum: albumUnchanged ? false : draft.createAlbum,
    albumName: albumUnchanged ? '' : draft.albumName };
}
