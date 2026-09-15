import { describe, expect, it } from 'bun:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { noteCompletionRange, noteCompletionSource } from './completion';

const notes = [{ title: 'First pilot', trashedAt: null }, { title: 'Trashed', trashedAt: 1 }];
describe('notebook completion', () => {
 it('suggests only live notebook titles after an opener', () => {
  const state = EditorState.create({ doc: 'See [[Fi' });
  const result = noteCompletionSource(() => notes)(new CompletionContext(state, state.doc.length, false));
  expect(result?.from).toBe(6);
  expect(result?.options.map(option => option.label)).toEqual(['First pilot']);
  expect(noteCompletionRange('ordinary prose', 14)).toBeNull();
 });
 it('shares parser exclusions for fenced/inline code, HTML and escaping', () => {
  for (const [text, position] of [
   ['```md\n[[Fi\n```', 10], ['`[[Fi]]`', 5], ['<div>[[Fi</div>', 9], ['<img alt="[[Fi">', 13], ['\\[[Fi', 5], ['<!-- [[Fi -->', 9]
  ] as const) expect(noteCompletionRange(text, position)).toBeNull();
  expect(noteCompletionRange('\\\\[[Fi', 6)).not.toBeNull();
 });
 it('preserves aliases and closing brackets when accepting a title', () => {
  for (const [doc, pos, expected] of [
   ['[[Fi', 4, '[[First pilot]]'], ['[[Fi]]', 4, '[[First pilot]]'],
   ['[[Fi|the plan]] after', 4, '[[First pilot|the plan]] after'],
   ['[[Fi|the plan', 4, '[[First pilot|the plan]]'],
   ['[[First old title]]', 7, '[[First pilot]]']
  ] as const) {
   let state = EditorState.create({ doc, selection: { anchor: pos } });
   const completion = noteCompletionSource(() => notes)(new CompletionContext(state, pos, false))!;
   const option = completion.options[0];
   const view = { get state() { return state; }, dispatch(spec: Parameters<EditorState['update']>[0]) {
    const update = state.update(spec); expect(update.annotation(Transaction.userEvent)).toBe('input.complete'); state = update.state;
   } } as unknown as EditorView;
   if (typeof option.apply !== 'function') throw new Error('Expected completion command');
   option.apply(view, option, completion.from, pos);
   expect(state.doc.toString()).toBe(expected);
   expect(state.selection.main.head).toBe(expected.indexOf(']]') + 2);
  }
 });
 it('does not complete inside an alias', () => { expect(noteCompletionRange('[[First|alias', 13)).toBeNull(); });
});
