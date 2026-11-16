import { describe, expect, test } from 'bun:test';
import { htmlToMarkdown, type PasteNode } from './writingPaste';

const t = (text: string): PasteNode => ({ tag: '#text', text });
const e = (tag: string, children: (PasteNode | string)[] = [], attrs: Record<string, string> = {}): PasteNode => ({
	tag,
	attrs,
	children: children.map((child) => (typeof child === 'string' ? t(child) : child))
});
const md = (...nodes: (PasteNode | string)[]) => htmlToMarkdown(e('body', nodes));

describe('html to markdown', () => {
	test('inline marks, with edge spaces kept outside', () => {
		expect(md(e('p', ['a ', e('b', ['bold ']), e('i', ['it']), ' ', e('s', ['x'])])).markdown).toBe('a **bold** *it* ~~x~~');
	});
	test('Google Docs: a wrapper bold with normal weight is not bold; spans carry weight and style', () => {
		expect(md(e('b', [e('span', ['plain ']), e('span', ['b'], { style: 'font-weight:700' })], { style: 'font-weight:normal' })).markdown).toBe('plain **b**');
		expect(md(e('span', ['it'], { style: 'font-style: italic' })).markdown).toBe('*it*');
	});
	test('headings 1-3, links, line breaks', () => {
		expect(md(e('h1', ['One']), e('h3', [e('b', ['Three'])]), e('p', ['see ', e('a', ['site'], { href: 'https://x.dev/a b' }), e('br'), 'next'])).markdown).toBe(
			'# One\n\n### Three\n\nsee [site](https://x.dev/a%20b)  \nnext'
		);
	});
	test('unsafe links keep their text only', () => {
		const out = md(e('p', [e('a', ['click'], { href: 'javascript:alert(1)' }), ' ', e('a', ['d'], { href: 'data:text/html,x' })]));
		expect(out.markdown).toBe('click d');
		expect(out.formatted).toBe(false);
	});
	test('scripts and styles are dropped content-wise by fromDom; unknown elements keep their text', () => {
		expect(md(e('p', [e('font', ['kept ']), e('o:p', ['too'])])).markdown).toBe('kept too');
	});
	test('bulleted, numbered and nested lists', () => {
		const list = e('ul', [e('li', ['a', e('ol', [e('li', ['one']), e('li', ['two'])])]), e('li', [e('p', ['b'])])]);
		expect(md(list).markdown).toBe('- a\n  1. one\n  2. two\n- b');
		expect(md(e('ol', [e('li', ['x']), e('li', ['y'])], { start: '3' })).markdown).toBe('3. x\n4. y');
	});
	test('Word lists (mso-list paragraphs) nest by level', () => {
		const item = (level: number, bullet: string, text: string) =>
			e('p', [e('span', [bullet], { style: 'mso-list:Ignore' }), text], { class: 'MsoListParagraph', style: `mso-list:l0 level${level} lfo1` });
		expect(md(item(1, '·', 'a'), item(2, 'o', 'b'), item(1, '·', 'c')).markdown).toBe('- a\n  - b\n- c');
		expect(md(item(1, '1.', 'a'), item(1, '2.', 'b')).markdown).toBe('1. a\n2. b');
	});
	test('simple tables become Markdown tables', () => {
		const table = e('table', [e('tbody', [e('tr', [e('th', ['A']), e('th', ['B'])]), e('tr', [e('td', ['1 | 2']), e('td', ['x'])])])]);
		expect(md(table).markdown).toBe('| A | B |\n| --- | --- |\n| 1 \\| 2 | x |');
	});
	test('quotes, code and rules', () => {
		expect(md(e('blockquote', [e('p', ['q'])]), e('pre', ['a\n  b\n']), e('hr')).markdown).toBe('> q\n\n```\na\n  b\n```\n\n---');
		expect(md(e('p', ['use ', e('code', ['x()'])])).markdown).toBe('use `x()`');
	});
	test('markdown characters in plain text are escaped; snake_case is left alone', () => {
		expect(md(e('p', ['a*b snake_case [x] 1 < 2'])).markdown).toBe('a\\*b snake_case \\[x\\] 1 < 2');
		expect(md(e('p', ['# not a heading'])).markdown).toBe('\\# not a heading');
		expect(md(e('p', ['1. not a list'])).markdown).toBe('1\\. not a list');
	});
	test('formatting-free html says so (plain text will do)', () => {
		expect(md(e('div', [e('span', ['just text'])])).formatted).toBe(false);
		expect(md(e('div', [e('span', ['just text'])])).markdown).toBe('just text');
		expect(md(e('p', ['a']), e('p', ['b'])).markdown).toBe('a\n\nb');
	});
});
