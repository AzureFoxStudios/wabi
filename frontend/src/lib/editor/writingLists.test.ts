import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import type { EditorView } from '@codemirror/view';
import { continueMarkup, indentChanges } from './writingLists';
import { writingKeymap } from './writingSurface';
import { keymap } from '@codemirror/view';

const stateOf = (doc: string, anchor = 0, head = anchor, readOnly = false) =>
	EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [markdown(), readOnly ? EditorState.readOnly.of(true) : []] });
const apply = (state: EditorState, direction: 1 | -1) => {
	const changes = indentChanges(state, direction);
	return changes ? state.update({ changes }).state.doc.toString() : null;
};
function fake(state: EditorState) {
	const view = { state, dispatch: (...specs: never[]) => { view.state = view.state.update(...specs).state; } };
	return view as unknown as EditorView & { state: EditorState };
}
const enter = (doc: string, at: number) => {
	const view = fake(stateOf(doc, at));
	const handled = continueMarkup(view);
	return { handled, doc: view.state.doc.toString(), caret: view.state.selection.main.head };
};

describe('Tab and Shift-Tab', () => {
	test('indent a list line by two spaces wherever the caret is, and outdent it', () => {
		expect(apply(stateOf('- a\n- b', 5), 1)).toBe('- a\n  - b');
		expect(apply(stateOf('1. a', 4), 1)).toBe('  1. a');
		expect(apply(stateOf('  - b', 5), -1)).toBe('- b');
		expect(apply(stateOf('    - b', 5), -1)).toBe('  - b');
	});
	test('off a list line Tab is left to the browser', () => {
		expect(indentChanges(stateOf('plain', 2), 1)).toBeNull();
		expect(indentChanges(stateOf('plain', 0, 3), 1)).toBeNull();
		expect(indentChanges(stateOf('- a', 0), -1)).toBeNull();
	});
	test('a selection over several lines indents every non-blank line', () => {
		expect(apply(stateOf('a\n\nb', 0, 4), 1)).toBe('  a\n\n  b');
		expect(apply(stateOf('  a\n  b', 0, 7), -1)).toBe('a\nb');
	});
	test('a selection ending at a line start leaves that line out', () => {
		expect(apply(stateOf('a\nb\nc', 0, 4), 1)).toBe('  a\n  b\nc');
	});
	test('fenced code is not nested as a list line, read-only does nothing', () => {
		expect(indentChanges(stateOf('```\n- a\n```', 6), 1)).toBeNull();
		expect(indentChanges(stateOf('- a', 1, 1, true), 1)).toBeNull();
	});
	test('bound to Tab and Shift-Tab, Enter', () => {
		const keys = new Map(EditorState.create({ extensions: writingKeymap() }).facet(keymap).flat().map((b) => [b.key, b]));
		for (const key of ['Tab', 'Shift-Tab', 'Enter']) expect(keys.has(key)).toBe(true);
		expect(keys.get('Tab')!.run!(fake(stateOf('text', 2)))).toBe(false);
	});
});

describe('Enter', () => {
	test('continues bullets, numbers and tasks at the same indent', () => {
		expect(enter('- a', 3).doc).toBe('- a\n- ');
		expect(enter('  - a', 5).doc).toBe('  - a\n  - ');
		expect(enter('1. a', 4).doc).toBe('1. a\n2. ');
		expect(enter('- [ ] a', 7).doc).toBe('- [ ] a\n- [ ] ');
	});
	test('an empty item ends the list', () => {
		expect(enter('- a\n- ', 6).doc).toBe('- a\n');
		expect(enter('1. a\n2. ', 8).doc).toBe('1. a\n');
	});
	test('does nothing off a list, in fenced code, or read-only', () => {
		expect(enter('plain', 5).handled).toBe(false);
		expect(enter('```\n- a', 7).handled).toBe(false);
		expect(continueMarkup(fake(stateOf('- a', 3, 3, true)))).toBe(false);
	});
});
