import { beforeEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { appendHandoffText, composerHandoff, stageComposerHandoff, takeComposerHandoff, dismissComposerHandoff } from '../composerHandoff';
import { linkAnchor, rangeAnchor, slideAnchor } from './anchors';
beforeEach(() => composerHandoff.set(null));

test('appends references without overwriting existing text and enforces capacity', () => {
    expect(appendHandoffText('An unfinished message', 'Reference', 100)).toBe('An unfinished message\n\nReference');
    expect(appendHandoffText('Keep me', 'Too long', 8)).toBeNull();
    expect(appendHandoffText('', 'Reference', 0)).toBe('Reference');
});
test('a handoff is consumed only once by its destination channel', () => {
    stageComposerHandoff('room', 'Reference', () => true);
    const id = get(composerHandoff)!.id;
    expect(takeComposerHandoff(id, 'other')).toBeNull();
    expect(takeComposerHandoff(id, 'room')).toBe('Reference');
    expect(takeComposerHandoff(id, 'room')).toBeNull();
});
test('account switch or revocation prevents inserting an old reference', () => {
    let allowed = true;
    stageComposerHandoff('room', 'Private account reference', () => allowed);
    const id = get(composerHandoff)!.id;
    allowed = false;
    expect(takeComposerHandoff(id, 'room')).toBeNull();
    expect(get(composerHandoff)).toBeNull();
    expect(() => stageComposerHandoff('room', 'Reference', () => false)).toThrow('account');
});
test('a second handoff does not silently replace an unconsumed reference', () => {
    stageComposerHandoff('first', 'Original', () => true);
    const id = get(composerHandoff)!.id;
    expect(() => stageComposerHandoff('second', 'New', () => true)).toThrow('already waiting');
    dismissComposerHandoff('wrong');
    expect(get(composerHandoff)!.text).toBe('Original');
    dismissComposerHandoff(id);
    expect(get(composerHandoff)).toBeNull();
});
test('selection references retain stable identities without cell contents or slide titles', () => {
    const range = JSON.parse(linkAnchor(rangeAnchor('sheet', ['r1'], ['c1'], 'PRIVATE SHEET TITLE'))!);
    expect(range).toEqual({ v: 1, kind: 'range', sheetId: 'sheet', rows: ['r1'], columns: ['c1'], label: '' });
    expect(linkAnchor(slideAnchor('slide1', 'PRIVATE SLIDE TITLE'))).not.toContain('PRIVATE');
});
