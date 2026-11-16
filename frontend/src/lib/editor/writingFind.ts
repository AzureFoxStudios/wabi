/**
 * Find and replace for the writing surface, built on @codemirror/state and @codemirror/view only
 * (@codemirror/search is deliberately not a dependency).
 *
 * - Pure helpers: `findMatches`, `replaceAllChanges`, `matchIndex`.
 * - `findField`: the query, the panel's open state and the match decorations.
 * - A panel at the bottom of the editor (`role="search"`): Find, Previous / Next, Match case, a
 *   "N of M" count, and (writable pages only) Replace and Replace all.
 * - `findKeymap`: Ctrl F Find, Ctrl H Find and replace, Enter / Shift Enter or F3 / Shift F3 to
 *   step, Esc to close. Replacements go through ordinary `view.dispatch`, so the Yjs binding sees
 *   plain changes; Replace all is a single transaction, so one undo reverts it.
 */
import { Prec, StateEffect, StateField, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, getPanel, keymap, showPanel, type DecorationSet, type Panel } from '@codemirror/view';

export interface FindQuery {
	search: string;
	caseSensitive: boolean;
}

export interface MatchRange {
	from: number;
	to: number;
}

function escapePattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every non-overlapping match of the query in `text`, in order. An empty query matches nothing. */
export function findMatches(text: string, query: FindQuery): MatchRange[] {
	if (!query.search) return [];
	const pattern = new RegExp(escapePattern(query.search), query.caseSensitive ? 'gu' : 'giu');
	const found: MatchRange[] = [];
	for (const match of text.matchAll(pattern)) {
		const from = match.index ?? 0;
		found.push({ from, to: from + match[0].length });
	}
	return found;
}

/** Changes that replace every match with `replacement`, valid against `text` as one transaction. */
export function replaceAllChanges(text: string, query: FindQuery, replacement: string): ChangeSpec[] {
	return findMatches(text, query).map((range) => ({ from: range.from, to: range.to, insert: replacement }));
}

/** The match exactly covered by [from, to], or -1. */
export function matchIndex(matches: readonly MatchRange[], from: number, to: number): number {
	return matches.findIndex((range) => range.from === from && range.to === to);
}

interface FindState {
	open: boolean;
	search: string;
	replace: string;
	caseSensitive: boolean;
	/** The Replace row is showing (Ctrl H). Never shown on a read-only page. */
	replacing: boolean;
	matches: MatchRange[];
}

const setFind = StateEffect.define<Partial<Omit<FindState, 'matches'>>>();

function withMatches(state: EditorState, value: Omit<FindState, 'matches'>): FindState {
	return { ...value, matches: value.open ? findMatches(state.doc.toString(), value) : [] };
}

export const findField = StateField.define<FindState>({
	create: () => ({ open: false, search: '', replace: '', caseSensitive: false, replacing: false, matches: [] }),
	update(value, tr) {
		let next = value;
		let dirty = tr.docChanged;
		for (const effect of tr.effects) {
			if (effect.is(setFind)) {
				next = { ...next, ...effect.value };
				dirty = true;
			}
		}
		return dirty ? withMatches(tr.state, next) : value;
	}
});

const matchMark = Decoration.mark({ class: 'cm-w-find-match' });
const currentMark = Decoration.mark({ class: 'cm-w-find-match cm-w-find-current' });

const findDecorations = EditorView.decorations.compute([findField, 'selection'], (state): DecorationSet => {
	const { matches } = state.field(findField);
	if (matches.length === 0) return Decoration.none;
	const { from, to } = state.selection.main;
	return Decoration.set(matches.map((range) => (range.from === from && range.to === to ? currentMark : matchMark).range(range.from, range.to)));
});

/** The state of the find panel, for hosts and tests. */
export function findStateOf(state: EditorState): Readonly<FindState> {
	return state.field(findField);
}

// -------------------------------------------------------------------------------- commands

function inputIn(view: EditorView, name: 'find' | 'replace'): HTMLInputElement | null {
	return getPanel(view, createFindPanel)?.dom.querySelector<HTMLInputElement>(`[data-find="${name}"]`) ?? null;
}

/** Open Find (or Find and replace) seeded from a one-line selection, and focus the Find field. */
export function openFind(view: EditorView, replacing = false): boolean {
	const state = view.state;
	const current = state.field(findField);
	const range = state.selection.main;
	const picked = !range.empty && range.to - range.from <= 200 ? state.sliceDoc(range.from, range.to) : '';
	const search = picked && !picked.includes('\n') ? picked : current.search;
	const showReplace = !state.readOnly && (replacing || (current.open && current.replacing));
	view.dispatch({ effects: setFind.of({ open: true, search, replacing: showReplace }) });
	const field = inputIn(view, 'find');
	if (field) {
		field.focus();
		field.select();
	}
	return true;
}

/** Set the search text, replacement or case option (what the panel's fields do as you type). */
export function setFindQuery(view: EditorView, change: { search?: string; replace?: string; caseSensitive?: boolean }): void {
	view.dispatch({ effects: setFind.of(change) });
}

export function closeFind(view: EditorView): boolean {
	if (!view.state.field(findField).open) return false;
	view.dispatch({ effects: setFind.of({ open: false }) });
	view.focus();
	return true;
}

function selectMatch(view: EditorView, range: MatchRange): void {
	view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }), userEvent: 'select.search' });
}

/** Go to the next (or previous) match from the selection, wrapping; opens Find when it is closed. */
export function findStep(view: EditorView, forward: boolean, focusText = false): boolean {
	const state = view.state.field(findField);
	if (!state.open) return openFind(view);
	const { matches } = state;
	if (matches.length === 0) return true;
	const { from, to } = view.state.selection.main;
	let target: MatchRange | undefined;
	if (forward) target = matches.find((range) => range.from >= to && !(range.from === from && range.to === to)) ?? matches[0];
	else target = [...matches].reverse().find((range) => range.to <= from) ?? matches[matches.length - 1];
	selectMatch(view, target);
	if (focusText) view.focus();
	return true;
}

/** Replace the selected match (or, when the selection is not a match, go to the next one). */
export function replaceOne(view: EditorView): boolean {
	const state = view.state.field(findField);
	if (view.state.readOnly || !state.open) return false;
	const { from, to } = view.state.selection.main;
	if (matchIndex(state.matches, from, to) < 0) return findStep(view, true);
	view.dispatch({
		changes: { from, to, insert: state.replace },
		selection: { anchor: from + state.replace.length },
		userEvent: 'input.replace'
	});
	return findStep(view, true);
}

/** Replace every match in one transaction (one undo step). Returns false when nothing matched. */
export function replaceAll(view: EditorView): boolean {
	const state = view.state.field(findField);
	if (view.state.readOnly || !state.open) return false;
	const changes = replaceAllChanges(view.state.doc.toString(), state, state.replace);
	if (changes.length === 0) return false;
	view.dispatch({ changes, userEvent: 'input.replace', scrollIntoView: true });
	return true;
}

// ----------------------------------------------------------------------------------- panel

function createFindPanel(view: EditorView): Panel {
	const dom = document.createElement('div');
	dom.className = 'cm-w-find';
	dom.setAttribute('role', 'search');
	dom.setAttribute('aria-label', 'Find and replace');

	const button = (label: string, text: string, onClick: () => void, pressable = false): HTMLButtonElement => {
		const el = document.createElement('button');
		el.type = 'button';
		el.className = 'w-btn w-btn--quiet w-btn--sm';
		el.textContent = text;
		el.setAttribute('aria-label', label);
		if (pressable) el.setAttribute('aria-pressed', 'false');
		el.addEventListener('click', onClick);
		return el;
	};
	const field = (name: 'find' | 'replace', label: string): { wrap: HTMLLabelElement; input: HTMLInputElement } => {
		const wrap = document.createElement('label');
		wrap.className = 'w-field cm-w-find-field';
		const input = document.createElement('input');
		input.type = 'text';
		input.setAttribute('data-find', name);
		input.setAttribute('aria-label', label);
		input.placeholder = label;
		input.autocomplete = 'off';
		input.spellcheck = false;
		wrap.append(input);
		return { wrap, input };
	};

	const findRow = document.createElement('div');
	findRow.className = 'cm-w-find-row';
	const finder = field('find', 'Find');
	const count = document.createElement('span');
	count.className = 'cm-w-find-count';
	count.setAttribute('aria-live', 'polite');
	const caseButton = button('Match case', 'Match case', () => setFindQuery(view, { caseSensitive: !view.state.field(findField).caseSensitive }), true);
	findRow.append(
		finder.wrap,
		count,
		button('Previous match', 'Previous', () => findStep(view, false)),
		button('Next match', 'Next', () => findStep(view, true)),
		caseButton,
		button('Close find', 'Close', () => closeFind(view))
	);

	const replaceRow = document.createElement('div');
	replaceRow.className = 'cm-w-find-row';
	const replacer = field('replace', 'Replace with');
	replaceRow.append(replacer.wrap, button('Replace this match', 'Replace', () => replaceOne(view)), button('Replace all matches', 'Replace all', () => replaceAll(view)));

	dom.append(findRow, replaceRow);

	finder.input.addEventListener('input', () => setFindQuery(view, { search: finder.input.value }));
	replacer.input.addEventListener('input', () => setFindQuery(view, { replace: replacer.input.value }));
	finder.input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			findStep(view, !event.shiftKey);
		}
	});
	replacer.input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			replaceOne(view);
		}
	});
	dom.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeFind(view);
		} else if (event.key === 'F3') {
			event.preventDefault();
			findStep(view, !event.shiftKey);
		}
	});

	const sync = (state: EditorState) => {
		const value = state.field(findField);
		if (finder.input.value !== value.search) finder.input.value = value.search;
		if (replacer.input.value !== value.replace) replacer.input.value = value.replace;
		caseButton.setAttribute('aria-pressed', String(value.caseSensitive));
		replaceRow.hidden = state.readOnly || !value.replacing;
		const { from, to } = state.selection.main;
		const index = matchIndex(value.matches, from, to);
		count.textContent = !value.search ? '' : value.matches.length === 0 ? 'No matches' : `${index < 0 ? '–' : index + 1} of ${value.matches.length}`;
	};
	sync(view.state);

	return {
		dom,
		top: false,
		mount() {
			finder.input.focus();
			finder.input.select();
		},
		update(update) {
			sync(update.state);
		}
	};
}

const findPanel = showPanel.from(findField, (value) => (value.open ? createFindPanel : null));

const findTheme = EditorView.baseTheme({
	'.cm-w-find': {
		display: 'flex',
		flexDirection: 'column',
		gap: 'var(--space-2, 8px)',
		padding: 'var(--space-2, 8px) var(--space-3, 12px)',
		borderTop: 'var(--w-bw, 1px) solid var(--w-line)',
		background: 'var(--w-bg2)',
		color: 'var(--w-text)'
	},
	'.cm-w-find-row': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2, 8px)' },
	'.cm-w-find-row[hidden]': { display: 'none' },
	'.cm-w-find-field': { flex: '1 1 12rem', minWidth: '0' },
	'.cm-w-find-count': { color: 'var(--w-mute)', fontFamily: 'var(--w-font-mono, inherit)', fontSize: 'calc(11px * var(--w-fs, 1))', minWidth: '5rem' },
	'.cm-w-find-match': { background: 'color-mix(in srgb, var(--w-accent) 22%, transparent)', borderRadius: '2px' },
	'.cm-w-find-current': { background: 'color-mix(in srgb, var(--w-accent) 45%, transparent)', outline: '1px solid var(--w-accent)' }
});

/** Ctrl F / Ctrl H / F3 / Esc. Read-only pages open Find without Replace. */
export const findKeymap: Extension = Prec.high(
	keymap.of([
		{ key: 'Mod-f', run: (view) => openFind(view, false), preventDefault: true },
		{ key: 'Mod-h', run: (view) => openFind(view, true), preventDefault: true },
		{ key: 'F3', run: (view) => findStep(view, true), shift: (view) => findStep(view, false), preventDefault: true },
		{ key: 'Escape', run: (view) => closeFind(view) }
	])
);

/** The whole find-and-replace feature as one extension. */
export function writingFind(): Extension {
	return [findField, findPanel, findDecorations, findTheme, findKeymap];
}
