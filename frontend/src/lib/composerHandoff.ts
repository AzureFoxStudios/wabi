import { get, writable } from 'svelte/store';

export interface ComposerHandoff { id: string; channelId: string; text: string; isCurrent: () => boolean; }
export const composerHandoff = writable<ComposerHandoff | null>(null);

/** A one-shot insertion, not a send operation. Existing text and attachments remain owned by the composer. */
export function stageComposerHandoff(channelId: string, text: string, isCurrent: () => boolean): void {
    if (!isCurrent()) throw new Error('The account or server changed before opening chat.');
    if (!channelId || !text.trim() || text.length > 8192) throw new Error('Invalid or oversized chat reference.');
    const pending = get(composerHandoff);
    if (pending?.isCurrent()) throw new Error('A reference is already waiting in chat. Insert or dismiss it before opening another.');
    composerHandoff.set({ id: crypto.randomUUID(), channelId, text, isCurrent });
}

export function takeComposerHandoff(id: string, channelId: string): string | null {
    const pending = get(composerHandoff);
    if (!pending || pending.id !== id || pending.channelId !== channelId) return null;
    composerHandoff.set(null);
    return pending.isCurrent() ? pending.text : null;
}

export function dismissComposerHandoff(id: string): void {
    composerHandoff.update(pending => pending?.id === id ? null : pending);
}

export function appendHandoffText(existing: string, reference: string, limit: number): string | null {
    const next = existing ? `${existing}\n\n${reference}` : reference;
    return limit > 0 && next.length > limit ? null : next;
}
