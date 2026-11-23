import { describe, expect, test } from 'bun:test';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { headingChanges, listChanges, setHeading, toggleList } from './writingBlocks';
import { closeFind, findField, setFindQuery, findMatches, findStep, openFind, replaceAll, replaceAllChanges, replaceOne, writingFind } from './writingFind';
import { writingKeymap } from './writingSurface';

// Word-style keys: Ctrl K link (Ctrl Shift K alias), headings, lists, find and replace.

function stateOf(doc: string, anchor = 0, head = anchor, readOnly = false): EditorState {
	return EditorState.create({
		doc,
		selection: EditorSelection.single(anchor, head),
		extensions: [writingFind(), readOnly ? EditorState.readOnly.of(true) : []]
	});
}

/** A view stand-in: enough for commands that read `state`, `dispatch` and `focus`. */
function fakeView(initial: EditorState) {
	const log: TransactionSpec[] = [];
	const view = {
		state: initial,
		dispatch(...specs: TransactionSpec[]) {
			log.push(...specs);
			view.state = view.state.update(...specs).state;
		},
		focus() {},
		// getPanel needs a real view; Find's focus step is skipped when there is no panel.
		plugin: () => null,
		dom: null
	};
	return { view: view as unknown as EditorView & { state: EditorState }, log };
}
const apply = (state: EditorState, changes: ReturnType<typeof headingChanges>) => (changes ? state.update({ changes }).state.doc.toString() : state.doc.toString());

describe('keymap', () => {
	const bindings = () => {
		const state = EditorState.create({ extensions: writingKeymap() });
		return new Map(state.facet(keymap).flat().map((binding) => [binding.key, binding]));
	};
	test('has every Word-style binding and keeps the old ones', () => {
		const keys = bindings();
		for (const key of ['Mod-k', 'Mod-Shift-k', 'Mod-Alt-1', 'Mod-Alt-2', 'Mod-Alt-3', 'Mod-Alt-0', 'Mod-Shift-n', 'Mod-Shift-l', 'Mod-Shift-7', 'Mod-Shift-8', 'Mod-b', 'Mod-i', 'Mod-Shift-x', 'Mod-e', 'Mod-Enter', 'Alt-F10']) {
			expect(keys.has(key)).toBe(true);
		}
	});
	test('Ctrl K and Ctrl Shift K both insert a link', () => {
		const keys = bindings();
		for (const key of ['Mod-k', 'Mod-Shift-k']) {
			const { view } = fakeView(stateOf('see word here', 4, 8));
			expect(keys.get(key)!.run!(view)).toBe(true);
			expect(view.state.doc.toString()).toBe('see [word](https://) here');
		}
	});
	test('find keys are bound', () => {
		const state = EditorState.create({ extensions: writingFind() });
		const keys = state.facet(keymap).flat().map((binding) => binding.key);
		for (const key of ['Mod-f', 'Mod-h', 'F3', 'Escape']) expect(keys).toContain(key);
	});
	test('heading and list keys run through the keymap', () => {
		const keys = bindings();
		const heading = fakeView(stateOf('Title'));
		expect(keys.get('Mod-Alt-2')!.run!(heading.view)).toBe(true);
		expect(heading.view.state.doc.toString()).toBe('## Title');
		const list = fakeView(stateOf('a\nb', 0, 3));
		expect(keys.get('Mod-Shift-7')!.run!(list.view)).toBe(true);
		expect(list.view.state.doc.toString()).toBe('1. a\n2. b');
	});
});

describe('headings', () => {
	test('set a level on a plain line, replace another level, toggle the same level off', () => {
		expect(apply(stateOf('Title'), headingChanges(stateOf('Title'), 1))).toBe('# Title');
		const two = stateOf('## Title');
		expect(apply(two, headingChanges(two, 3))).toBe('### Title');
		expect(apply(two, headingChanges(two, 2))).toBe('Title');
	});
	test('Normal removes the marker; nothing to do on a plain line', () => {
		const h = stateOf('### Title');
		expect(apply(h, headingChanges(h, 0))).toBe('Title');
		expect(headingChanges(stateOf('Title'), 0)).toBeNull();
	});
	test('acts on each selected line, and the selection end at a line start leaves that line out', () => {
		const state = stateOf('a\nb\nc', 0, 4);
		expect(apply(state, headingChanges(state, 1))).toBe('# a\n# b\nc');
		const wide = stateOf('a\nb\nc', 0, 5);
		expect(apply(wide, headingChanges(wide, 2))).toBe('## a\n## b\n## c');
	});
	test('mixed levels become the asked level before toggling off', () => {
		const state = stateOf('# a\nb', 0, 5);
		expect(apply(state, headingChanges(state, 1))).toBe('# a\n# b');
	});
	test('are ignored inside fenced code', () => {
		const doc = '```\ncode\n```\nafter';
		const inside = stateOf(doc, 6);
		expect(headingChanges(inside, 1)).toBeNull();
		const { view } = fakeView(inside);
		expect(setHeading(view, 1)).toBe(false);
		expect(view.state.doc.toString()).toBe(doc);
		const mixed = stateOf(doc, 0, doc.length);
		expect(apply(mixed, headingChanges(mixed, 1))).toBe('```\ncode\n```\n# after');
	});
	test('do nothing on a read-only page', () => {
		const { view } = fakeView(stateOf('x', 0, 0, true));
		expect(setHeading(view, 1)).toBe(false);
	});
});

describe('lists', () => {
	test('bullet on one line, and off again', () => {
		const plain = stateOf('item');
		expect(apply(plain, listChanges(plain, 'bullet'))).toBe('- item');
		const bulleted = stateOf('- item');
		expect(apply(bulleted, listChanges(bulleted, 'bullet'))).toBe('item');
	});
	test('numbered on one line, and off again', () => {
		const plain = stateOf('item');
		expect(apply(plain, listChanges(plain, 'number'))).toBe('1. item');
		const numbered = stateOf('1. item');
		expect(apply(numbered, listChanges(numbered, 'number'))).toBe('item');
	});
	test('multi-line selection: every line gets a marker (numbers count up), blank lines skipped', () => {
		const state = stateOf('a\n\nb\nc', 0, 6);
		expect(apply(state, listChanges(state, 'bullet'))).toBe('- a\n\n- b\n- c');
		expect(apply(state, listChanges(state, 'number'))).toBe('1. a\n\n2. b\n3. c');
	});
	test('partly listed selection completes the list; fully listed removes it', () => {
		const partly = stateOf('- a\nb', 0, 5);
		expect(apply(partly, listChanges(partly, 'bullet'))).toBe('- a\n- b');
		const all = stateOf('- a\n- b', 0, 7);
		expect(apply(all, listChanges(all, 'bullet'))).toBe('a\nb');
		const nums = stateOf('1. a\n2. b', 0, 9);
		expect(apply(nums, listChanges(nums, 'number'))).toBe('a\nb');
	});
	test('switches between bullets and numbers, keeps indent', () => {
		const state = stateOf('  - a');
		expect(apply(state, listChanges(state, 'number'))).toBe('  1. a');
		const nums = stateOf('1. a');
		expect(apply(nums, listChanges(nums, 'bullet'))).toBe('- a');
	});
	test('a lone blank line starts a list; fenced code is left alone', () => {
		const blank = stateOf('');
		expect(apply(blank, listChanges(blank, 'bullet'))).toBe('- ');
		expect(listChanges(stateOf('```\nx\n```', 5), 'bullet')).toBeNull();
	});
	test('toggleList dispatches one transaction and keeps the selection on the text', () => {
		const { view, log } = fakeView(stateOf('abc', 0, 3));
		expect(toggleList(view, 'bullet')).toBe(true);
		expect(log).toHaveLength(1);
		expect(view.state.doc.toString()).toBe('- abc');
		expect(view.state.selection.main.to).toBe(5);
	});
});

describe('find matches', () => {
	test('case insensitive by default, case sensitive on request', () => {
		expect(findMatches('Cat cat CAT', { search: 'cat', caseSensitive: false })).toHaveLength(3);
		expect(findMatches('Cat cat CAT', { search: 'cat', caseSensitive: true })).toEqual([{ from: 4, to: 7 }]);
	});
	test('overlapping text is matched without overlap', () => {
		expect(findMatches('aaaa', { search: 'aa', caseSensitive: false })).toEqual([
			{ from: 0, to: 2 },
			{ from: 2, to: 4 }
		]);
		expect(findMatches('aaa', { search: 'aa', caseSensitive: false })).toHaveLength(1);
	});
	test('an empty query matches nothing; regex characters are literal', () => {
		expect(findMatches('abc', { search: '', caseSensitive: false })).toEqual([]);
		expect(findMatches('a.c abc (x)', { search: '.', caseSensitive: false })).toEqual([{ from: 1, to: 2 }]);
		expect(findMatches('(x)', { search: '(x)', caseSensitive: false })).toHaveLength(1);
	});
});

describe('replace', () => {
	const query = { search: 'a', caseSensitive: false };
	test('replaceAllChanges applies against the original text', () => {
		const state = EditorState.create({ doc: 'banana' });
		expect(state.update({ changes: replaceAllChanges('banana', query, 'oo') }).state.doc.toString()).toBe('boonoonoo');
	});
	test('replace all is a single transaction, and replace on a closed panel does nothing', () => {
		const { view, log } = fakeView(stateOf('banana'));
		expect(replaceAll(view)).toBe(false);
		openFindState(view, 'a', 'o');
		log.length = 0;
		expect(replaceAll(view)).toBe(true);
		expect(log).toHaveLength(1);
		expect(view.state.doc.toString()).toBe('bonono');
	});
	test('replace one replaces the selected match and moves to the next', () => {
		const { view } = fakeView(stateOf('banana'));
		openFindState(view, 'an', 'X');
		expect(replaceOne(view)).toBe(true); // selects the first match
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('an');
		expect(replaceOne(view)).toBe(true); // replaces it, selects the next
		expect(view.state.doc.toString()).toBe('bXana');
		expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('an');
	});
	test('replacement that contains the search does not loop', () => {
		const { view } = fakeView(stateOf('a a'));
		openFindState(view, 'a', 'aa');
		replaceOne(view);
		replaceOne(view);
		expect(view.state.doc.toString()).toBe('aa a');
	});
	test('read-only pages cannot replace and open Find without the Replace row', () => {
		const { view } = fakeView(stateOf('a a', 0, 0, true));
		openFindState(view, 'a', 'b', true);
		expect(view.state.field(findField).replacing).toBe(false);
		expect(replaceAll(view)).toBe(false);
		expect(replaceOne(view)).toBe(false);
		expect(view.state.doc.toString()).toBe('a a');
	});
	test('stepping wraps, goes back, and Escape closes', () => {
		const { view } = fakeView(stateOf('x a x a', 0));
		openFindState(view, 'a', '');
		findStep(view, true);
		expect(view.state.selection.main.from).toBe(2);
		findStep(view, true);
		expect(view.state.selection.main.from).toBe(6);
		findStep(view, true);
		expect(view.state.selection.main.from).toBe(2);
		findStep(view, false);
		expect(view.state.selection.main.from).toBe(6);
		expect(closeFind(view)).toBe(true);
		expect(view.state.field(findField).open).toBe(false);
		expect(closeFind(view)).toBe(false);
	});
});

/** Opens the Find state with a query and replacement, as the panel's fields would, without a DOM. */
function openFindState(view: EditorView, search: string, replace: string, replacing = true): void {
	openFind(view, replacing);
	setFindQuery(view, { search, replace });
}
