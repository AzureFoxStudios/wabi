import { describe, expect, test } from 'bun:test';
import { ComposerDraftMemory } from './composerDrafts';
import { sendComposerBatch } from './composerSendBatch';
import { settleComposerUpload } from './composerSendSettlement';
import type { ComposerDraft } from './composerDraftState';

const attachment = () => new File(['same bytes'], 'attachment.txt', { type: 'text/plain', lastModified: 1 });
const draft = (files: File[]): ComposerDraft => ({ text: 'caption', gifCaption: '', entities: [], files,
  spoiler: true, createAlbum: true, albumName: 'Submitted album',
  reply: { id: 'submitted-reply' } as ComposerDraft['reply'], editing: null });

describe('attachment handoff settlement', () => {
  test('consumes accepted attachments and their unchanged caption/reply/album choices', () => {
    const submitted = draft([attachment()]);
    const settled = settleComposerUpload(submitted, submitted, true);
    expect(settled.files).toEqual([]);
    expect(settled.text).toBe('');
    expect(settled.reply).toBeNull();
    expect(settled.spoiler).toBe(false);
    expect(settled.createAlbum).toBe(false);
    expect(settled.albumName).toBe('');
    expect(submitted.files.length).toBe(1);
  });

  test('does not confuse a replacement File with an identical name, bytes, size or timestamp', () => {
    const submitted = draft([attachment()]);
    const replacement = attachment();
    const newer = { ...submitted, text: 'next caption', files: [replacement],
      reply: { id: 'next-reply' } as ComposerDraft['reply'], spoiler: false, albumName: 'Next album' };
    const settled = settleComposerUpload(newer, submitted, true);
    expect(settled.files[0]).toBe(replacement);
    expect(settled.text).toBe('next caption');
    expect(settled.reply?.id).toBe('next-reply');
    expect(settled.spoiler).toBe(false);
    expect(settled.albumName).toBe('Next album');
  });

  test('removes only accepted files after appending another selection and preserves locked spoilers', () => {
    const submitted = draft([attachment()]);
    const appended = attachment();
    const settled = settleComposerUpload({ ...submitted, files: [...submitted.files, appended] }, submitted, false);
    expect(settled.files).toEqual([appended]);
    expect(settled.spoiler).toBe(true);
    expect(settled.createAlbum).toBe(true);
  });

  test('a pending attachment blocks the remounted editor and settles its files after acceptance', async () => {
    const memory = new ComposerDraftMemory<ComposerDraft>(() => 'realm');
    const submitted = draft([attachment()]);
    const old = memory.open('channel'); old.save(submitted);
    const transaction = old.beginSend()!;
    let release!: (result: { ok: boolean }) => void;
    const run = sendComposerBatch({ payloads: [submitted], canContinue: old.current,
      send: () => new Promise(resolve => release = resolve),
      accepted: () => transaction.settle(value => settleComposerUpload(value, submitted, true)) });
    const replacement = memory.open('channel');
    let visible = replacement.initial!;
    const unsubscribe = replacement.onSendState((_pending, update) => { if (update) visible = update(visible); });
    expect(replacement.isSending()).toBe(true);
    expect(replacement.beginSend()).toBeNull();
    release({ ok: true });
    expect(await run).toEqual({ sent: 1 });
    transaction.finish();
    expect(visible.files).toEqual([]);
    expect(visible.text).toBe('');
    expect(replacement.read()?.files).toEqual([]);
    expect(replacement.isSending()).toBe(false);
    unsubscribe();
  });

  test('failed handoff preserves files/caption/reply for a remounted editor to retry', async () => {
    const memory = new ComposerDraftMemory<ComposerDraft>(() => 'realm');
    const submitted = draft([attachment()]);
    const old = memory.open('channel'); old.save(submitted);
    const transaction = old.beginSend()!;
    let release!: (result: { ok: boolean; reason: string }) => void;
    const run = sendComposerBatch({ payloads: [submitted], canContinue: old.current,
      send: () => new Promise(resolve => release = resolve),
      accepted: () => transaction.settle(value => settleComposerUpload(value, submitted, true)) });
    const replacement = memory.open('channel');
    release({ ok: false, reason: 'queue_failed' });
    expect(await run).toEqual({ sent: 0, reason: 'queue_failed' });
    transaction.finish();
    expect(replacement.read()).toBe(submitted);
    expect(replacement.isSending()).toBe(false);
  });
});
