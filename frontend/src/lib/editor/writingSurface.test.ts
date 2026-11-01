import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { caretLines, writingDecorations } from './writingSurface';
import { applyTextEdit, toggleTaskAt } from './writingMarkdown';

// The writing page (design contract §8.8, D22): inline markers show only on the caret's lines;
// elsewhere they step aside, a checklist marker is a checkbox, a bullet a dot, a divider a
// hairline and a quote keeps only its rule. A read-only page has no caret line.

type Found = { from: number; to: number; kind: string };

/** Every decoration as [from, to, kind]: a mark's class, a widget's name, or "hidden". */
function decorations(doc: string, caret: number | null, readOnly = false): Found[] {
	const state = EditorState.create({
		doc,
		selection: { anchor: caret ?? 0 },
		extensions: readOnly ? EditorState.readOnly.of(true) : []
	});
	const set = writingDecorations(state, doc.length, caret === null ? null : caretLines(state));
	const found: Found[] = [];
	set.between(0, doc.length, (from, to, value: Decoration) => {
		const spec = value.spec as { class?: string; widget?: object };
		const kind = spec.widget ? spec.widget.constructor.name : spec.class ? spec.class : 'hidden';
		found.push({ from, to, kind });
	});
	return found;
}
const at = (found: Found[], from: number, to: number) => found.filter((item) => item.from === from && item.to === to).map((item) => item.kind);

describe('inline markers', () => {
	const doc = 'A **bold** word\nNext line';
	test('show, faint, on the caret line', () => {
		const found = decorations(doc, 4);
		expect(at(found, 2, 4)).toEqual(['cm-w-marker']);
		expect(at(found, 8, 10)).toEqual(['cm-w-marker']);
		expect(at(found, 4, 8)).toEqual(['cm-w-strong']);
	});
	test('step aside on every other line, and the words keep their style', () => {
		const found = decorations(doc, doc.length);
		expect(at(found, 2, 4)).toEqual(['hidden']);
		expect(at(found, 8, 10)).toEqual(['hidden']);
		expect(at(found, 4, 8)).toEqual(['cm-w-strong']);
	});
	test('a read-only page hides them all', () => {
		expect(at(decorations(doc, 4, true), 2, 4)).toEqual(['hidden']);
	});
	test('touching markers (bold inside a link) hide as one span, never two replacements', () => {
		const text = 'See [**this**](https://wabi.example) now\nx';
		const found = decorations(text, text.length);
		const open = text.indexOf('[');
		const close = text.indexOf('**](');
		const end = text.indexOf(') now') + 1;
		expect(at(found, open, open + 3)).toEqual(['hidden']);
		expect(at(found, close, end)).toEqual(['hidden']);
		expect(found.filter((item) => item.kind === 'hidden')).toHaveLength(2);
		expect(found.some((item) => item.kind === 'cm-w-link')).toBe(true);
	});
});

describe('block markers off the caret line', () => {
	const doc = '- [ ] Draft\n- [x] Done\n- Bullet\n1. One\n> Quote\n---\nend';
	const found = decorations(doc, doc.length);
	test('checklist markers become checkboxes; a done item is struck through', () => {
		expect(at(found, 0, 6)).toEqual(['CheckWidget']);
		expect(at(found, 12, 18)).toEqual(['CheckWidget']);
		expect(found.some((item) => item.from === 12 && item.kind === 'cm-w-task cm-w-done')).toBe(true);
	});
	test('a bullet becomes a dot, a number stays (faint), a quote keeps only its rule', () => {
		const bullet = doc.indexOf('- Bullet');
		expect(at(found, bullet, bullet + 2)).toEqual(['BulletWidget']);
		const one = doc.indexOf('1. One');
		expect(at(found, one, one + 3)).toEqual(['cm-w-marker']);
		const quote = doc.indexOf('> Quote');
		expect(at(found, quote, quote + 2)).toEqual(['hidden']);
		expect(found.some((item) => item.from === quote && item.kind === 'cm-w-quote')).toBe(true);
	});
	test('a divider is a hairline', () => {
		const rule = doc.indexOf('---');
		expect(at(found, rule, rule + 3)).toEqual(['RuleWidget']);
	});
	test('on the caret line every marker shows as typed', () => {
		const onCheck = decorations(doc, 3);
		expect(at(onCheck, 0, 6)).toEqual(['cm-w-marker']);
	});
	test('heading markers always hang, caret or not', () => {
		const text = '## Places\nx';
		expect(decorations(text, text.length).some((item) => item.from === 0 && item.to === 3 && item.kind === 'cm-w-marker cm-w-hang')).toBe(true);
	});
});

describe('caret lines', () => {
	test('span the whole selection, and are none on a read-only page', () => {
		const state = EditorState.create({ doc: 'a\nb\nc', selection: { anchor: 0, head: 4 } });
		expect(caretLines(state)).toEqual([1, 3]);
		const locked = EditorState.create({ doc: 'a', extensions: EditorState.readOnly.of(true) });
		expect(caretLines(locked)).toBeNull();
	});
});

describe('checklist toggle (checkbox click, Ctrl Enter)', () => {
	test('ticks and unticks the item on the line, keeping the caret', () => {
		const text = 'Intro\n- [ ] Draft one page\n  * [x] Nested done';
		const tick = toggleTaskAt(text, text.indexOf('Draft'));
		expect(tick).not.toBeNull();
		expect(applyTextEdit(text, tick!)).toContain('- [x] Draft one page');
		expect(tick!.anchor).toBe(text.indexOf('Draft'));
		const untick = toggleTaskAt(text, text.indexOf('Nested'));
		expect(applyTextEdit(text, untick!)).toContain('  * [ ] Nested done');
	});
	test('is nothing on a line that is not a checklist item', () => {
		expect(toggleTaskAt('- plain bullet', 3)).toBeNull();
		expect(toggleTaskAt('Intro', 2)).toBeNull();
	});
});
