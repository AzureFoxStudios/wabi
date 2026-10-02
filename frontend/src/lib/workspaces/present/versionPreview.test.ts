import { expect, test } from 'bun:test';
import { prepareEdition, verifyEdition } from './versionPreview';
import type { AudienceSlide } from '../bridge';
const slide = (id: string): AudienceSlide => ({ id, title: id, body: 'Approved body', layout: 'text', image: null });

test('retains the audience current slide after authoring reorder', () => {
    const slides = [slide('second'), slide('first')];
    const approved = prepareEdition(slides, 16 / 9, 'first');
    expect(approved.destination).toBe('first');
    expect(approved.currentMissing).toBe(false);
    expect(() => verifyEdition(approved, slides, 16 / 9, 'first')).not.toThrow();
});
test('removed or hidden current slide requires an explicit destination', () => {
    const slides = [slide('remaining')], approved = prepareEdition(slides, 4 / 3, 'removed');
    expect(approved.destination).toBe('');
    expect(approved.currentMissing).toBe(true);
    expect(() => verifyEdition(approved, slides, 4 / 3, '')).toThrow('Choose');
    expect(() => verifyEdition(approved, slides, 4 / 3, 'removed')).toThrow('Choose');
    expect(() => verifyEdition(approved, slides, 4 / 3, 'remaining')).not.toThrow();
});
test('preview is immutable relative to subsequent authoring or remote edits', () => {
    const slides = [slide('first')], approved = prepareEdition(slides, 16 / 9, 'first');
    slides[0].body = 'NOT APPROVED';
    expect(approved.slides[0].body).toBe('Approved body');
    expect(() => verifyEdition(approved, slides, 16 / 9, 'first')).toThrow('changed after');
});
test('aspect changes and reorder invalidate approval; private extras do not enter the DTO', () => {
    const slides = [{ ...slide('first'), notes: 'SECRET NOTES', history: 'SECRET HISTORY' }, slide('second')];
    const approved = prepareEdition(slides, 16 / 9, 'first');
    expect(JSON.stringify(approved)).not.toContain('SECRET');
    expect(() => verifyEdition(approved, slides, 4 / 3, 'first')).toThrow('changed after');
    expect(() => verifyEdition(approved, [...slides].reverse(), 16 / 9, 'first')).toThrow('changed after');
});
test('invalid editions cannot be approved', () => {
    expect(() => prepareEdition([], 16 / 9, '')).toThrow();
    expect(() => prepareEdition([slide('same'), slide('same')], 16 / 9, 'same')).toThrow('Duplicate');
    expect(() => prepareEdition([slide('one')], Number.NaN, 'one')).toThrow('aspect');
});
