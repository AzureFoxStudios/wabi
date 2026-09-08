import { describe, expect, test } from 'bun:test';
import { ComposerDraftMemory } from './composerDrafts';
import { sendComposerBatch } from './composerSendBatch';
import { settleComposerText } from './composerSendSettlement';
import { clearAuthSession, onAuthSessionCleared } from './authSession';
import type { ComposerDraft } from './composerDraftState';

const draft = (text: string): ComposerDraft => ({ text, gifCaption: '', entities: [], files: [], spoiler: false,
  createAlbum: false, albumName: '', reply: null, editing: null });

describe('composer handoff settlement', () => {
  test('a partial split send keeps only the unsent remainder after failure', async () => {
    const memory = new ComposerDraftMemory<ComposerDraft>(() => 'realm');
    const editor = memory.open('one');
    editor.save(draft('first second third'));
    const transaction = editor.beginSend()!;
    let expectedText = 'first second third';
    const result = await sendComposerBatch({ payloads: ['first', 'second', 'third'], canContinue: editor.current,
      send: text => text === 'second' ? { ok: false, reason: 'no_socket' } : { ok: true },
      accepted: sent => {
        const text = ['first', 'second', 'third'].slice(sent).join(' ');
        const expected = expectedText;
        transaction.settle(value => settleComposerText(value, { expectedText: expected, text, entities: [], spoiler: false, clearSpoiler: false }));
        expectedText = text;
      } });
    transaction.finish();
    expect(result).toEqual({ sent: 1, reason: 'no_socket' });
    expect(memory.open('one').initial?.text).toBe('second third');
  });

  test('a pending handoff follows a remount, blocks duplicates, and cannot send the next part', async () => {
    const memory = new ComposerDraftMemory<ComposerDraft>(() => 'realm');
    const old = memory.open('one'); old.save(draft('first second'));
    const transaction = old.beginSend()!;
    let resolve!: (value: { ok: boolean }) => void;
    const sent: string[] = [];
    const run = sendComposerBatch({ payloads: ['first', 'second'], canContinue: old.current,
      send: text => { sent.push(text); return new Promise(r => resolve = r); },
      accepted: () => transaction.settle(value => settleComposerText(value, { expectedText: 'first second', text: 'second', entities: [], spoiler: false, clearSpoiler: false })) });
    const replacement = memory.open('one');
    let visible = replacement.initial!;
    let pending = replacement.isSending();
    const unsubscribe = replacement.onSendState((nextPending, update) => { pending = nextPending; if (update) visible = update(visible); });
    expect(replacement.beginSend()).toBeNull();
    expect(pending).toBe(true);
    resolve({ ok: true });
    expect(await run).toEqual({ sent: 1, interrupted: true });
    transaction.finish();
    expect(sent).toEqual(['first']);
    expect(visible.text).toBe('second');
    expect(pending).toBe(false);
    expect(memory.open('one').initial?.text).toBe('second');
    unsubscribe();
  });

  test('late settlement cannot clear replacement edits or newly selected replies', () => {
    const original = draft('message');
    original.reply = { id: 'old-reply' } as ComposerDraft['reply'];
    const changed = { ...original, text: 'new writing', reply: { id: 'new-reply' } as ComposerDraft['reply'] };
    const update = { expectedText: 'message', text: '', entities: [], replyId: 'old-reply', spoiler: false, clearSpoiler: true };
    expect(settleComposerText(changed, update)).toBe(changed);
    expect(settleComposerText({ ...changed, text: 'message' }, update).reply?.id).toBe('new-reply');
  });

  test('enqueue rejection is a handled failure with the draft retained', async () => {
    let accepted = false;
    expect(await sendComposerBatch({ payloads: ['one'], canContinue: () => true,
      send: async () => { throw new Error('quota'); }, accepted: () => { accepted = true; } }))
      .toEqual({ sent: 0, reason: 'enqueue_failed' });
    expect(accepted).toBe(false);
  });

  test('logout signal clears unmounted drafts even when the same realm returns before another read', () => {
    const memory = new ComposerDraftMemory<ComposerDraft>(() => 'same-server/same-account');
    const old = memory.open('one'); old.save(draft('private'));
    const transaction = old.beginSend()!;
    const unsubscribe = onAuthSessionCleared(() => memory.clear());
    try {
      clearAuthSession('https://fixture.invalid');
      const replacement = memory.open('one'); replacement.save(draft('new session'));
      transaction.settle(() => draft('late private result')); transaction.finish();
      expect(old.current()).toBe(false);
      expect(replacement.isSending()).toBe(false);
      expect(memory.open('one').initial?.text).toBe('new session');
    } finally { unsubscribe(); }
  });

  test('a failed in-flight handoff leaves all pending text and unlocks the remounted editor', async () => {
    const memory = new ComposerDraftMemory<ComposerDraft>(() => 'realm');
    const old = memory.open('one'); old.save(draft('not queued'));
    const transaction = old.beginSend()!;
    let reject!: (reason: Error) => void;
    const send = sendComposerBatch({ payloads: ['not queued'], canContinue: old.current,
      send: () => new Promise((_resolve, fail) => reject = fail), accepted: () => { throw new Error('must not settle'); } });
    const replacement = memory.open('one');
    reject(new Error('queue transaction aborted'));
    expect((await send).reason).toBe('enqueue_failed');
    transaction.finish();
    expect(replacement.isSending()).toBe(false);
    expect(replacement.initial?.text).toBe('not queued');
  });
});
