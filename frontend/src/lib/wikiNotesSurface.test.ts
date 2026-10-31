import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Contract: design spec §8.7 (wiki tree, 720 article, ON THIS PAGE, Notes in center stage),
// §7.15 (selection bubble, no shadow), §2 (rules not boxes, ink primary, words over glyphs),
// §5.2 (selection grammar, High Contrast rings), §9.3 (locality once per screen) and critiques
// forum-wiki#3, #5, #10, #11, #12, #16, #17. Sources are read as text so a regression fails
// without a browser. Comments are removed by scanning, never by a regex replace.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const wikiCss = read('../styles/components/wiki.css');
const panelCss = read('../styles/surfaces/panel.css');
const readingCss = read('../styles/surfaces/reading.css');
const channel = read('./components/WikiChannel.svelte');
const tree = read('./components/WikiPageTree.svelte');
const notes = read('./components/NotesWorkspace.svelte');
const writer = read('./components/WritingEditor.svelte');

function withoutComments(source: string, open = '/*', close = '*/'): string {
	let out = '';
	let index = 0;
	while (index < source.length) {
		const start = source.indexOf(open, index);
		if (start < 0) {
			out += source.slice(index);
			break;
		}
		out += source.slice(index, start);
		const end = source.indexOf(close, start + open.length);
		index = end < 0 ? source.length : end + close.length;
	}
	return out;
}

/** The markup part of a Svelte file: no script, no style, no comments. */
function markup(source: string): string {
	let out = withoutComments(source, '<script', '</script>');
	out = withoutComments(out, '<style', '</style>');
	return withoutComments(out, '<!--', '-->');
}

/** The <style> block of a Svelte file, without comments. */
function styles(source: string): string {
	const start = source.indexOf('<style>');
	const end = source.indexOf('</style>', start);
	return start < 0 ? '' : withoutComments(source.slice(start, end));
}

/** The text from a block's HELD FOR marker to the next HELD FOR marker (or the end). */
function heldBlock(css: string, owner: string): string {
	const start = css.indexOf(`HELD FOR ${owner}`);
	if (start < 0) return '';
	const next = css.indexOf('HELD FOR ', start + 9);
	return css.slice(start, next < 0 ? css.length : next);
}

const LEGACY_TOKENS = ['--text-link', '--accent-subtle', '--border-focus', '--status-danger', '--accent-primary', '--surface-', '--text-primary', '--font-size-', '--font-weight-', '--line-height-', '--space-', '--radius-full', '--duration-', '--opacity-', '--color-warning', '--accent-warning'];

function expectRolesOnly(css: string, label: string) {
	expect(css, `${label}: raw hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	expect(css, `${label}: rgb()`).not.toMatch(/\brgba?\(/);
	expect(css, `${label}: named white/black`).not.toMatch(/:\s*(white|black)\b/);
	for (const token of LEGACY_TOKENS) expect(css.includes(`var(${token}`), `${label}: ${token}`).toBe(false);
	expect(css, `${label}: transition: all`).not.toMatch(/transition:\s*all\b/);
	expect(css, `${label}: !important`).not.toContain('!important');
}

describe('wiki.css and the HELD blocks draw only with roles and tokens', () => {
	test('no raw colors, legacy tokens, transition: all or !important', () => {
		expectRolesOnly(withoutComments(wikiCss), 'wiki.css');
		expectRolesOnly(withoutComments(heldBlock(panelCss, 'w1-wiki-notes')), 'panel.css block');
		expectRolesOnly(withoutComments(heldBlock(readingCss, 'w1-wiki-notes')), 'reading.css block');
		expectRolesOnly(styles(notes), 'NotesWorkspace styles');
		expectRolesOnly(styles(writer), 'WritingEditor styles');
	});

	test('no left bars or accent selection fills (§5.2)', () => {
		for (const [label, css] of [['wiki.css', withoutComments(wikiCss)], ['notes', styles(notes)], ['panel block', withoutComments(heldBlock(panelCss, 'w1-wiki-notes'))]] as const) {
			expect(css, `${label}: border-left bar`).not.toMatch(/border-left:\s*[23]px/);
			expect(css, `${label}: accent-soft selection`).not.toMatch(/selected[^{]*\{[^}]*accent-soft/);
		}
		expect(markup(notes)).not.toContain('border-left-color');
	});

	test('the tree selection is the selection grammar and rings in High Contrast', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/\.wiki-tree-item\.active > \.wiki-tree-row \{[^}]*background: var\(--w-raise\)/);
		expect(css).toMatch(/:root\[data-char='contrast'\] \.wiki-tree-item\.active > \.wiki-tree-row \{[^}]*inset 0 0 0 1px var\(--w-line-strong\)/);
		expect(css).toMatch(/:root\[data-char='contrast'\] \.wiki-tree-row:hover \{[^}]*inset 0 0 0 1px var\(--w-line-strong\)/);
	});

	test('the page is one 720 column with the outline in the right margin; the tree stacks under 760', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/\.wiki-page \{[^}]*grid-template-columns: minmax\(0, 720px\)/);
		expect(css).toMatch(/\.wiki-page\.has-margin \{[^}]*minmax\(0, 1fr\) minmax\(0, 720px\) minmax\(200px, 1fr\)/);
		expect(css).toMatch(/\.wiki-body \{[^}]*grid-template-columns: clamp\(220px, 22%, 280px\) minmax\(0, 1fr\)/);
		expect(css).toContain('@container wiki (max-width: 759.98px)');
		// The companion fix: the content pane never forces a 62vh minimum inside the panel host.
		expect(css).not.toContain('62vh');
	});

	test('center stage restates the 34/40 title and the demoted prose headings after headings.css', () => {
		const block = withoutComments(heldBlock(readingCss, 'w1-wiki-notes'));
		expect(block).toContain(':root .wiki-channel .wiki-article h1.wiki-article-title');
		expect(block).toContain('calc(34px * var(--w-fs, 1)) / calc(40px * var(--w-fs, 1))');
		expect(block).toMatch(/:root \.wiki-channel \.wiki-prose h1 \{[^}]*calc\(22px/);
	});
});

describe('WikiPageTree (§8.7, forum-wiki#5, #17)', () => {
	const html = markup(tree);

	test('a WAI-ARIA tree: treeitems with level, expanded and selected, one tab stop', () => {
		expect(html).toContain('role="tree"');
		expect(html).toContain('role="treeitem"');
		expect(html).toContain('role="group"');
		expect(html).toContain('aria-level={level}');
		expect(html).toContain('aria-expanded={parent ? open : undefined}');
		expect(html).toContain('aria-selected={active}');
		expect(html).toContain('tabindex={pageId === tabStop ? 0 : -1}');
		for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) expect(tree).toContain(`'${key}'`);
	});

	test('no page glyph, no NEW badge, no text-glyph chevrons', () => {
		expect(tree).not.toContain('▱');
		expect(tree).not.toContain('▾');
		expect(tree).not.toContain('new-badge');
		expect(tree).not.toContain('isNewPage');
		expect(html).toContain('<Icon name="chevRight"');
	});

	test('PAGES kicker, the one "New page" (ink primary, quiet in the panel) and a chrome search field', () => {
		expect(html).toContain("$_('wiki.pages')");
		expect(html).toContain("$_('wiki.new_page')");
		expect(html).toContain('class:w-btn--primary={!quiet}');
		expect(html).toContain('class:w-btn--quiet={quiet}');
		expect(html).toContain('class="w-field w-field--chrome wiki-tree-search"');
		expect(html).not.toContain('+ New');
	});
});

describe('WikiChannel (§8.7, forum-wiki#3, #10, #11, #12)', () => {
	const html = markup(channel);

	test('the wiki chrome lives in the tree: no toolbar row, no refresh glyph, no second primary style', () => {
		expect(channel).not.toContain('SurfaceToolbar');
		expect(channel).not.toContain('↻');
		expect(channel).not.toContain('+ New Page');
		expect(channel).not.toContain('&#10005;');
		expect(html).not.toContain('surface-pill');
	});

	test('one left edge: title, meta and .w-prose share the article column; the outline is .w-outline', () => {
		expect(html).toContain('<article class="wiki-article"');
		expect(html).toContain('<h1 class="wiki-article-title"');
		expect(html).toContain('class="w-prose wiki-prose"');
		expect(html).toContain('class="w-outline wiki-outline"');
		expect(html).toContain("aria-current={currentOutlineId === entry.id ? 'location' : undefined}");
		expect(html).not.toContain('wiki-table-of-contents');
	});

	test('true labels: "Original version" or the edit count, never "0 revisions"', () => {
		expect(channel).not.toContain('revision{displayRevisionCount');
		expect(html).toContain('wikiVersionNote(');
	});

	test('editing and new pages use the writing surface with Insert, Write | Preview and one primary', () => {
		expect(html).toContain('<WritingEditor');
		expect(html).toContain('class="w-btn w-btn--primary"');
		expect(html).toContain('label="Insert"');
		expect(html).toContain('aria-label="Writing mode"');
		expect(channel).not.toContain('wiki-editor-toolbar');
		expect(channel).not.toContain('<textarea');
		// The Schedule table keeps its place, in the Insert menu.
		expect(read('./editor/writingMarkdown.ts')).toContain("{ kind: 'schedule', label: 'Schedule table' }");
	});

	test('while a page is written the tree steps its New page back, so the page owns the one primary', () => {
		expect(html).toContain('quiet={inPanel || editMode || showNewPage}');
	});
});

describe('NotesWorkspace in center stage (§8.7, forum-wiki#16)', () => {
	const html = markup(notes);
	const page = html.slice(0, html.indexOf('{#if settingsOpen}'));

	test('one creation control: row A on center stage, the list tools only where there is no row A', () => {
		expect(notes).toContain("setStageHeader(HEADER_OWNER, { view: 'notes'");
		expect(notes).toContain("scope: $_('locality.only_you_device')");
		expect(notes).toContain("id: 'new-note'");
		expect(page).toContain('{#if !ownsHeader}');
		expect(page).not.toContain('Create your first note');
		expect(page.match(/onclick=\{createNote\}/g)?.length ?? 0).toBe(1);
	});

	test('Note actions is a ⋯ menu: no <details>, no native select in the notebook chrome', () => {
		expect(page).not.toContain('<details');
		expect(page).not.toContain('<select');
		expect(page).toContain("label={$_('panels.note_actions')}");
		expect(page).toContain('<Icon name="more" />');
	});

	test('Ink shows inside the note only when it has a drawing layer', () => {
		expect(page).toContain('{#if hasDrawing || inkOpen}');
		expect(notes).toContain("label: 'Add a drawing'");
		expect(page).not.toContain('note-ink-tools');
	});

	test('the writing surface, a serif title, and the save word without the locality', () => {
		expect(page).toContain('<WritingEditor');
		expect(page).toContain('class="note-heading"');
		expect(page).toContain('data-status={$draftStore.status}');
		expect(notes).not.toContain("'Saved on this device'");
	});

	test('icons come from the registry', () => {
		expect(page).not.toMatch(/<svg[\s>]/);
		expect(page).not.toMatch(/>\+</);
	});
});

describe('WritingEditor: the selection bubble (§7.15)', () => {
	test('a kit .w-tool--bubble toolbar with no shadow', () => {
		const html = markup(writer);
		expect(html).toContain('class="w-tool w-tool--bubble writing-bubble"');
		expect(html).toContain('role="toolbar"');
		expect(html).toContain('aria-label="Format selection"');
		expect(styles(writer)).not.toMatch(/\.writing-bubble[^{]*\{[^}]*box-shadow/);
		for (const key of ['Bold', 'Italic', 'Strikethrough', 'Link', 'Inline code']) expect(writer).toContain(`label: '${key}'`);
	});
});
