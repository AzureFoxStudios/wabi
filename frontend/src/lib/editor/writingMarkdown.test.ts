import { describe, expect, test } from 'bun:test';
import {
	activeMarks,
	applyTextEdit,
	insertBlockSnippet,
	insertInline,
	insertKind,
	linkSelection,
	placeSelectionBubble,
	SCHEDULE_TABLE,
	setLineKind,
	toggleInlineMark,
	type TextEdit
} from './writingMarkdown';

// Contract: design spec §7.15 (selection bubble), §8.8 (Insert menu, D22). Each edit is one
// replacement of the old text plus the selection in the new text (a CodeMirror transaction).

function run(text: string, edit: TextEdit) {
	const next = applyTextEdit(text, edit);
	return { text: next, selected: next.slice(Math.min(edit.anchor, edit.head), Math.max(edit.anchor, edit.head)) };
}

describe('inline marks', () => {
	test('wrap the selection and keep it selected', () => {
		const text = 'a quiet place';
		const result = run(text, toggleInlineMark(text, 2, 7, 'bold'));
		expect(result.text).toBe('a **quiet** place');
		expect(result.selected).toBe('quiet');
	});

	test('unwrap when the selection sits inside the mark, or includes it', () => {
		const inside = 'a **quiet** place';
		expect(run(inside, toggleInlineMark(inside, 4, 9, 'bold')).text).toBe('a quiet place');
		expect(run(inside, toggleInlineMark(inside, 2, 11, 'bold'))).toEqual({ text: 'a quiet place', selected: 'quiet' });
	});

	test('italic and bold share the star without mistaking one for the other', () => {
		const bold = 'a **quiet** place';
		// Italic on bold words adds a third star; bold stays.
		expect(run(bold, toggleInlineMark(bold, 4, 9, 'italic')).text).toBe('a ***quiet*** place');
		const both = 'a ***quiet*** place';
		expect(run(both, toggleInlineMark(both, 5, 10, 'italic')).text).toBe('a **quiet** place');
		expect(run(both, toggleInlineMark(both, 5, 10, 'bold')).text).toBe('a *quiet* place');
		const italic = 'a *quiet* place';
		expect(run(italic, toggleInlineMark(italic, 3, 8, 'italic')).text).toBe('a quiet place');
	});

	test('whitespace at the ends of a selection stays outside the mark', () => {
		const text = 'say hello there';
		expect(run(text, toggleInlineMark(text, 3, 10, 'strike')).text).toBe('say ~~hello~~ there');
		expect(run(text, toggleInlineMark(text, 4, 10, 'code')).text).toBe('say `hello` there');
	});

	test('an empty selection gets a pair of markers with the caret between them', () => {
		const edit = toggleInlineMark('ab', 1, 1, 'bold');
		expect(applyTextEdit('ab', edit)).toBe('a****b');
		expect(edit.anchor).toBe(3);
		expect(edit.head).toBe(3);
	});

	test('a selection across lines marks each line and keeps list prefixes outside', () => {
		const text = '- one\n- two';
		expect(run(text, toggleInlineMark(text, 2, text.length, 'bold')).text).toBe('- **one**\n- **two**');
	});

	test('reports the marks already on the selection for the bubble keys', () => {
		const text = 'a ***quiet*** and `code`';
		expect(activeMarks(text, 5, 10)).toEqual({ bold: true, italic: true, strike: false, code: false });
		expect(activeMarks(text, 19, 23).code).toBe(true);
		expect(activeMarks('plain', 0, 5)).toEqual({ bold: false, italic: false, strike: false, code: false });
	});
});

describe('links', () => {
	test('wrap words and select the address to paste over', () => {
		const text = 'see the guide';
		const result = run(text, linkSelection(text, 8, 13));
		expect(result.text).toBe('see the [guide](https://)');
		expect(result.selected).toBe('https://');
	});

	test('a selected address becomes the label and the target', () => {
		const text = 'go https://wabi.example now';
		const result = run(text, linkSelection(text, 3, 23));
		expect(result.text).toBe('go [https://wabi.example](https://wabi.example) now');
		expect(result.selected).toBe('https://wabi.example');
	});

	test('nothing selected inserts a link to fill in', () => {
		const result = run('', linkSelection('', 0, 0));
		expect(result.text).toBe('[link text](https://)');
		expect(result.selected).toBe('link text');
	});
});

describe('line kinds (Insert menu)', () => {
	test('a heading replaces the line prefix and keeps the caret in its words', () => {
		const text = 'intro\n- Weekly rhythm\nend';
		const caret = text.indexOf('rhythm');
		const edit = setLineKind(text, caret, caret, 'heading2');
		const next = applyTextEdit(text, edit);
		expect(next).toBe('intro\n## Weekly rhythm\nend');
		expect(next.slice(edit.anchor, edit.anchor + 6)).toBe('rhythm');
	});

	test('choosing the kind every selected line has turns them back into paragraphs', () => {
		const text = '- one\n- two';
		expect(applyTextEdit(text, setLineKind(text, 0, text.length, 'bullet'))).toBe('one\ntwo');
	});

	test('numbered lists count, checklists get boxes, quotes get their rule', () => {
		const text = 'one\ntwo\n\nthree';
		expect(applyTextEdit(text, setLineKind(text, 0, text.length, 'numbered'))).toBe('1. one\n2. two\n\n3. three');
		expect(applyTextEdit('task', setLineKind('task', 0, 4, 'checklist'))).toBe('- [ ] task');
		expect(applyTextEdit('## said', setLineKind('## said', 3, 3, 'quote'))).toBe('> said');
	});

	test('a selection that ends at the start of a line leaves that line alone', () => {
		const text = 'one\ntwo';
		expect(applyTextEdit(text, setLineKind(text, 0, 4, 'heading3'))).toBe('### one\ntwo');
	});
});

describe('blocks (Insert menu)', () => {
	test('a divider gets blank lines so it never turns the paragraph above into a heading', () => {
		const text = 'Hello\nWorld';
		const edit = insertBlockSnippet(text, 2, 2, 'divider');
		expect(applyTextEdit(text, edit)).toBe('Hello\n\n---\n\nWorld');
	});

	test('an empty caret line becomes the block; the caret lands inside a code block', () => {
		const text = 'Intro\n\n';
		const edit = insertBlockSnippet(text, 7, 7, 'code');
		const next = applyTextEdit(text, edit);
		expect(next).toBe('Intro\n\n```\n\n```\n\n');
		expect(next.slice(edit.anchor - 4, edit.anchor)).toBe('```\n');
	});

	test('the schedule table is the one the wiki toolbar inserted', () => {
		const edit = insertKind('', 0, 0, 'schedule');
		expect(applyTextEdit('', edit).trim()).toBe(SCHEDULE_TABLE);
		const table = insertKind('', 0, 0, 'table');
		const next = applyTextEdit('', table);
		expect(next.slice(table.anchor, table.head)).toBe('Column');
	});

	test('inline text replaces the selection with the caret after it', () => {
		const edit = insertInline('a b', 1, 2, '![map](u)');
		expect(applyTextEdit('a b', edit)).toBe('a![map](u)b');
		expect(edit.anchor).toBe(10);
	});
});

describe('selection bubble placement', () => {
	const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
	const size = { width: 190, height: 36 };

	test('8px below the last line, left-aligned to the selection start', () => {
		const start = { left: 300, top: 100, right: 320, bottom: 130 };
		const end = { left: 500, top: 160, right: 520, bottom: 190 };
		expect(placeSelectionBubble(start, end, viewport, size)).toEqual({ left: 300, top: 198, above: false });
	});

	test('flips above the first line when fewer than 52px remain below', () => {
		const start = { left: 300, top: 700, right: 320, bottom: 730 };
		const end = { left: 400, top: 730, right: 420, bottom: 760 };
		expect(placeSelectionBubble(start, end, viewport, size)).toEqual({ left: 300, top: 656, above: true });
	});

	test('stays inside the viewport sideways', () => {
		const start = { left: 950, top: 100, right: 960, bottom: 130 };
		expect(placeSelectionBubble(start, start, viewport, size).left).toBe(1000 - 190 - 4);
	});
});
