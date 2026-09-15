import { describe, expect, test } from 'bun:test';
import { normalizeNoteTitle, parseNoteLinks, renameNoteLinks } from './links';

const titles = (text: string) => parseNoteLinks(text).map((link) => link.title);

describe('notebook title normalization', () => {
	test('normalizes Unicode compatibility forms, spacing and case without changing accents', () => {
		expect(normalizeNoteTitle('  ＷＡＢＩ\u00a0  Café\t plan  ')).toBe('wabi café plan');
		expect(normalizeNoteTitle('Cafe\u0301')).toBe(normalizeNoteTitle('CAFÉ'));
		expect(normalizeNoteTitle(' \n\t ')).toBe('');
	});
});

describe('notebook wiki links', () => {
	test('returns exact UTF-16 offsets, display spelling and optional explicit label', () => {
		const text = '🪴 [[  Café plan ]] and [[Next|read more]]!';
		const links = parseNoteLinks(text);
		expect(links).toEqual([
			{ from: 3, to: 19, title: 'Café plan', normalizedTitle: 'café plan' },
			{ from: 24, to: 42, title: 'Next', label: 'read more', normalizedTitle: 'next' }
		]);
		expect(links.map((link) => text.slice(link.from, link.to))).toEqual(['[[  Café plan ]]', '[[Next|read more]]']);
	});

	test('ignores blank, unfinished and multiline targets', () => {
		expect(titles('[[ ]] [[|alias]] [[unfinished\n[[Across\nlines]] [[Good]]')).toEqual(['Good']);
	});

	test('keeps literal labels without interpreting their content as new links', () => {
		expect(parseNoteLinks('[[A|label | with pipe]] [[B|]]').map((link) => link.label)).toEqual(['label | with pipe', '']);
	});

	test('respects odd/even backslash escaping at opening and closing delimiters', () => {
		expect(titles(String.raw`\[[Hidden]] \\[[Visible]] [[Also hidden\]] [[Last]]`)).toEqual(['Visible', 'Last']);
	});

	test('excludes inline code with exact-length backtick delimiters, including multiline spans', () => {
		expect(titles('`[[Code]]` ``some ` [[More code]]`` [[Outside]]\n`across\n[[Lines]]` [[After]]')).toEqual(['Outside', 'After']);
	});

	test('unmatched or escaped backticks do not swallow links', () => {
		expect(titles('a ` unmatched [[Visible]]')).toEqual(['Visible']);
		expect(titles('\\` [[Visible]]')).toEqual(['Visible']);
	});

	test('excludes fenced code, accepts longer matching close and ignores shorter or opposite markers', () => {
		const text = '[[Before]]\n````md\n[[Code]]\n```\n[[Still code]]\n~~~~\n[[Also code]]\n`````\n[[After]]';
		expect(titles(text)).toEqual(['Before', 'After']);
	});

	test('handles tilde fences, CRLF and indented or quoted/list fences', () => {
		expect(titles('[[A]]\r\n  ~~~ md\r\n[[Hidden]]\r\n  ~~~\r\n[[B]]')).toEqual(['A', 'B']);
		expect(titles('> ```md\n> [[Hidden]]\n> ```\n[[C]]')).toEqual(['C']);
		expect(titles('- ```md\n  [[Hidden]]\n  ```\n[[D]]')).toEqual(['D']);
	});

	test('an unclosed fence hides the remaining code; inline code cannot cross a fence', () => {
		expect(titles('[[Before]]\n~~~\n[[Hidden]]')).toEqual(['Before']);
		expect(titles('` unmatched [[Visible]]\n```\nclosing ` [[Hidden]]\n```\n[[After]]')).toEqual(['Visible', 'After']);
	});

	test('excludes HTML comments, attributes, nested bodies and custom elements', () => {
		const text = '[[Before]] <!-- [[Comment]] --> <div data-note="[[Attribute]]">\n<span>[[Body]]</span><div>[[Nested]]</div></div> [[After]] <note-card>[[Custom]]</note-card>';
		expect(titles(text)).toEqual(['Before', 'After']);
	});

	test('handles quoted greater-than signs, multiline HTML and case-insensitive closing tags', () => {
		expect(titles('<SPAN title="a > [[Attribute]]"\n data-x=">">[[Body]]</span> [[Outside]]')).toEqual(['Outside']);
	});

	test('void and self-closing HTML do not swallow following prose', () => {
		expect(titles('<img alt="[[Hidden]]"> [[A]] <x-note value="[[Hidden]]"/> [[B]] <br> [[C]]')).toEqual(['A', 'B', 'C']);
	});

	test('excludes raw directives and unfinished HTML', () => {
		expect(titles('<![CDATA[[[Hidden]]]]> [[A]] <?target [[Hidden]]?> [[B]] <!DOCTYPE html> [[C]]')).toEqual(['A', 'B', 'C']);
		expect(titles('[[Before]] <!-- [[Hidden]]')).toEqual(['Before']);
		expect(titles('[[Before]] <div> [[Hidden]]')).toEqual(['Before']);
		expect(titles('[[Before]] <span title="[[Hidden]]')).toEqual(['Before']);
	});

	test('plain less-than comparisons are not HTML elements', () => {
		expect(titles('1 < 2: [[Math]]; <https://example.com> [[Web]]')).toEqual(['Math', 'Web']);
	});

	test('raw-text HTML ignores tag-shaped text and autolink destinations are excluded', () => {
		expect(titles('<script>const x = "<script>[[Hidden]]";</script> [[A]] <style>/* <style> [[Hidden]] */</style> [[B]]')).toEqual(['A', 'B']);
		expect(titles('<https://example.com/[[Hidden]]> [[Visible]]')).toEqual(['Visible']);
	});
});

describe('transactional rename text helper', () => {
	test('updates all normalized targets, preserves aliases and leaves excluded text byte-for-byte', () => {
		const before = '[[ＣＡＦÉ|Read café]] + [[ cafe\u0301 ]]\r\n`[[Café]]`\r\n<div>[[Café]]</div> [[Other]]';
		expect(renameNoteLinks(before, 'café', 'New plan')).toBe('[[New plan|Read café]] + [[New plan]]\r\n`[[Café]]`\r\n<div>[[Café]]</div> [[Other]]');
	});

	test('preserves explicit empty aliases and supports repeated different-length replacements', () => {
		expect(renameNoteLinks('[[A|]] [[A]] [[A|word]]', 'a', 'Longer title')).toBe('[[Longer title|]] [[Longer title]] [[Longer title|word]]');
	});

	test('rejects destination titles that would create broken syntax', () => {
		for (const title of ['', '  ', 'A|B', 'A\nB', '[A]', 'A\rB']) {
			expect(() => renameNoteLinks('[[A]]', 'a', title)).toThrow('Invalid note link title');
		}
	});
});
