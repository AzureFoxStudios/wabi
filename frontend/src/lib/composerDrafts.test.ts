import { describe, expect, test } from 'bun:test';
import { ComposerDraftMemory } from './composerDrafts';

describe('composer session drafts', () => {
  test('simultaneous center and dock editors do not cancel one another', () => {
    const memory = new ComposerDraftMemory<string>(() => 'realm');
    const center = memory.open('one', () => true, 'center');
    const dock = memory.open('one', () => true, 'dock');
    center.save('center'); dock.save('dock');
    expect(center.current()).toBe(true);
    expect(memory.open('one', () => true, 'center').initial).toBe('center');
    memory.remove('one');
    expect(dock.current()).toBe(false);
  });
  test('workspace remount restores text/files; channels remain independent', () => {
    const memory = new ComposerDraftMemory<{ text: string; files: object[] }>(() => 'server/account');
    const file = {};
    memory.open('one').save({ text: 'unfinished', files: [file] });
    expect(memory.open('two').initial).toBeUndefined();
    const restored = memory.open('one');
    expect(restored.initial?.text).toBe('unfinished');
    expect(restored.initial?.files[0]).toBe(file);
    restored.clear();
    expect(memory.open('one').initial).toBeUndefined();
  });
  test('retired editors cannot overwrite replacement drafts or clear them after an await', () => {
    const memory = new ComposerDraftMemory<string>(() => 'realm');
    const old = memory.open('channel'); old.save('old');
    const replacement = memory.open('channel'); replacement.save('new');
    old.save('late'); old.clear();
    expect(old.current()).toBe(false);
    expect(memory.open('channel').initial).toBe('new');
  });
  test('logout/server/account changes discard drafts and fence old work', () => {
    let realm: string | null = 'server/account';
    const memory = new ComposerDraftMemory<string>(() => realm);
    const old = memory.open('one'); old.save('private');
    realm = null;
    expect(old.current()).toBe(false);
    realm = 'server/account';
    expect(memory.open('one').initial).toBeUndefined();
    memory.open('one').save('private'); realm = 'other/account';
    expect(memory.open('one').initial).toBeUndefined();
  });
  test('revocation and re-add cannot revive a draft or old upload', () => {
    const memory = new ComposerDraftMemory<string>(() => 'realm');
    let allowed = true;
    const old = memory.open('group', () => allowed); old.save('private');
    allowed = false; memory.remove('group');
    allowed = true;
    old.save('late');
    expect(old.current()).toBe(false);
    expect(memory.open('group').initial).toBeUndefined();
  });
});
