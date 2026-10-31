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

/**
 * The only !important allowed: the documented phone rule that keeps a title field at its title
 * size against mobile.css's `input { font-size: 16px !important }` (never under 16px).
 */
const TITLE_FIELD_IMPORTANT = /font-size: max\(16px, var\(--(?:wiki|note)-title-fs\)\) !important;/g;

function expectRolesOnly(css: string, label: string) {
	expect(css, `${label}: raw hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	expect(css, `${label}: rgb()`).not.toMatch(/\brgba?\(/);
	expect(css, `${label}: named white/black`).not.toMatch(/:\s*(white|black)\b/);
	for (const token of LEGACY_TOKENS) expect(css.includes(`var(${token}`), `${label}: ${token}`).toBe(false);
	expect(css, `${label}: transition: all`).not.toMatch(/transition:\s*all\b/);
	expect(css.split(TITLE_FIELD_IMPORTANT).join(''), `${label}: !important`).not.toContain('!important');
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
		// One reading block: the breadcrumb line and the page share its width and left edge.
		expect(css).toMatch(/\.wiki-page \{[^}]*max-width: var\(--wiki-block\)[^}]*margin: 0 auto/);
		expect(css).toMatch(/\.wiki-crumbs-inner \{[^}]*max-width: var\(--wiki-block\)[^}]*margin: 0 auto/);
		// The margin column: never an empty 1fr before the article (forum-wiki#3, two left edges).
		expect(css).toMatch(/\.wiki-content-pane\.is-wide \.wiki-page \{[^}]*grid-template-columns: minmax\(0, 720px\) minmax\(200px, 240px\)/);
		expect(css).not.toMatch(/minmax\(0, 1fr\) minmax\(0, 720px\)/);
		expect(css).toMatch(/\.wiki-content-pane\.is-wide \{[^}]*--wiki-block: 1000px/);
		expect(css).toMatch(/\.wiki-body \{[^}]*grid-template-columns: clamp\(220px, 22%, 280px\) minmax\(0, 1fr\)/);
		expect(css).toContain('@container wiki (max-width: 759.98px)');
		// The companion fix: the content pane never forces a 62vh minimum inside the panel host.
		expect(css).not.toContain('62vh');
	});

	test('center stage restates the title and the demoted # after headings.css, through the title variables', () => {
		const held = withoutComments(heldBlock(readingCss, 'w1-wiki-notes'));
		const block = held.slice(0, held.indexOf(':root .forum-channel'));
		expect(block).toContain(':root .wiki-channel .wiki-article h1.wiki-article-title');
		expect(block).toContain('font: 600 var(--wiki-title-fs) / var(--wiki-title-lh) var(--w-serif)');
		// No tier of its own: a container rule here once outranked the panel's 24/30 title.
		expect(block).not.toContain('@container');
		expect(block).toMatch(/:root \.wiki-channel \.wiki-prose h1 \{[^}]*calc\(22px/);
	});

	test('the title tiers: 34/40 on desktop (a 632px pane included), 28/34 on phones, 24/30 in the panel', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/\.wiki-channel \{[^}]*--wiki-title-fs: calc\(34px \* var\(--w-fs\)\);[^}]*--wiki-title-lh: calc\(40px/);
		// The narrow tier starts under 560px, so the pinned 1536 pane (632px) keeps 34/40 and the
		// shell's 32/24/16 gutter (no 16px gutter on desktop).
		expect(css).toContain('@container wiki-page (max-width: 559.98px)');
		expect(css).not.toContain('639.98px');
		expect(css).not.toMatch(/--wiki-gutter: 16px;[^}]*\}\s*\.wiki-article/);
		expect(css).toMatch(/\.wiki-channel\.in-panel \.wiki-page \{[^}]*--wiki-title-fs: calc\(24px/);
		expect(css).toMatch(/\.wiki-title-input \{[^}]*font: 600 var\(--wiki-title-fs\) \/ var\(--wiki-title-lh\)/);
		// Phones: mobile.css forces inputs to 16px; the title field keeps its title size.
		expect(css).toMatch(/@media \(max-width: 768px\) \{\s*\.wiki-channel \.wiki-title-input \{\s*font-size: max\(16px, var\(--wiki-title-fs\)\) !important;/);
		expect(withoutComments(heldBlock(panelCss, 'w1-wiki-notes'))).toContain('font: 600 var(--wiki-title-fs) / var(--wiki-title-lh) var(--w-serif)');
	});

	test('the prose keeps the one style: only # steps down to the H2 size', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/\.wiki-article \.w-prose h1 \{[^}]*calc\(22px/);
		expect(css).not.toMatch(/^\.wiki-article \.w-prose h2 \{/m);
		expect(css).not.toMatch(/^\.wiki-article \.w-prose h3 \{/m);
		expect(css).toMatch(/--writing-h2: calc\(22px/);
		expect(css).toMatch(/--writing-h3: calc\(18px/);
	});

	test('phones: the writing row wraps its tools onto a second line instead of cutting off the primary', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/@container wiki-page \(max-width: 599\.98px\) \{\s*\.wiki-crumbs-row--writing \.wiki-crumbs-inner \{[^}]*flex-wrap: wrap/);
		expect(css).toMatch(/\.wiki-crumbs-row--writing \.wiki-write-actions \{[^}]*flex: 1 1 100%;[^}]*flex-wrap: wrap/);
		// The way back to the overview stays: only the parents between step out.
		expect(css).toContain('.wiki-crumbs li:not(:first-child, :last-child)');
		expect(css).not.toContain('.wiki-crumbs li:not(:last-child)');
	});

	test('touch: icon-only actions are 44 wide, crumb words stay centred, rows hold the 44px seg keys', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.wiki-channel \{[^}]*--wiki-icon-btn: 44px;[^}]*--wiki-crumbs-h: 52px;/);
		expect(css).toMatch(/button\.wiki-crumb \{\s*min-height: 44px;\s*padding-block: 13px;/);
		expect(css).not.toMatch(/\.wiki-crumb \{\s*min-height: 44px;\s*\}/);
		expect(css).not.toMatch(/\.wiki-edit-btn \{[^}]*width: 32px/);
	});

	test('focus is an outline on the title field itself, never a box-shadow or :has()', () => {
		const css = withoutComments(wikiCss);
		expect(css).toMatch(/\.wiki-title-input:focus-visible \{[^}]*outline: 2px solid var\(--w-accent\)/);
		expect(css).not.toMatch(/:has\(\.wiki-title-input:focus-visible\)/);
		expect(css).not.toMatch(/box-shadow: 0 1px 0 var\(--w-accent\)/);
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

	test('the wiki loads before its store aliases run, so the first load shows the load line and skeleton', async () => {
		// Regression: `$: isLoading = $wikiLoadingStore` ran before the statement that calls
		// loadWiki() in the same update and kept `false` (a legacy `$:` runs once per update), so a
		// slow first load showed "No pages yet". Checked on the compiled component.
		const { compile } = await import('svelte/compiler');
		const code = compile(channel, { filename: 'WikiChannel.svelte', generate: 'client' }).js.code;
		const statements = code.split('$.legacy_pre_effect(').slice(1);
		const at = (needle: string) => statements.findIndex((statement) => statement.slice(0, 600).includes(needle));
		const load = at('loadWiki(');
		expect(load).toBeGreaterThanOrEqual(0);
		for (const alias of ['$.set(isLoading, $wikiLoadingStore())', '$.set(allPages, $wikiPagesStore())', '$.set(error, $wikiErrorStore())']) {
			expect(at(alias), alias).toBeGreaterThan(load);
		}
		expect(at('$.set(allRevisions, $wikiRevisionsStore())')).toBeGreaterThan(at('loadRevisions('));
	});

	test('loading, empty and error are each said once, in the pane', () => {
		expect(html).toContain('{#if isLoading && allPages.length === 0}');
		expect(html).toContain('<Skeleton');
		expect(html).toContain('<LoadLine active={isLoading}');
		// The tree no longer repeats the pane's "No pages yet" or load error.
		expect(html).not.toContain('emptyStateLabel=');
		expect(markup(tree)).not.toContain("'No pages yet.'");
		// A failed reload over pages already shown is said on the overview too.
		const overview = html.slice(html.indexOf('{:else if allPages.length === 0}'), html.indexOf('wiki-start-title'));
		expect(overview).toContain('Part of this wiki could not be loaded');
	});

	test('the overview keeps the tree (New page, search) where it stacks', () => {
		const start = channel.indexOf('function goToOverview()');
		const body = channel.slice(start, channel.indexOf('function handleEdit()', start));
		expect(body).toContain('showTreeOnMobile = true;');
	});

	test('unsaved writing is confirmed in the confirm dialog, never window.confirm', () => {
		expect(channel).not.toContain('window.confirm');
		expect(notes).not.toContain('window.confirm');
		expect(channel).toContain("confirm: 'Discard changes', danger: true");
		expect(notes).toContain("confirm: 'Delete note', danger: true");
	});

	test('placeholders name the scope, never a syntax manual; unsaved has a warn mark', () => {
		expect(channel).not.toContain('## starts a heading');
		expect(notes).not.toContain('Type [[ to link a note');
		expect(html).toContain('<span class="w-dot w-dot--warn" aria-hidden="true"></span>');
	});
});

describe('NotesWorkspace in center stage (§8.7, forum-wiki#16)', () => {
	const html = markup(notes);
	const page = html.slice(0, html.indexOf('{#if settingsOpen}'));

	test('one creation control: row A on center stage, the list tools only where there is no row A', () => {
		expect(notes).toContain("setStageHeader(HEADER_OWNER, { view: 'notes'");
		// Row A belongs to the center-stage instance only, never to one in the companion panel.
		expect(notes).toContain("node.closest('.right-panel, .right-panel-zone') === null");
		expect(notes).not.toContain('untrack(() => showHeader && !compact)');
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

	test('notices never show a raw Error.message; the failure is only logged', () => {
		expect(notes).not.toMatch(/\.message\b/);
		expect(page).toContain('<Notice title={error} error={errorDetail}');
		expect(notes).toContain('noteProblem(failure,');
	});

	test('the head keeps its air: the margin reset has zero weight', () => {
		const css = styles(notes);
		expect(css).toContain('.notes-workspace :where(h3, h4, p) { margin: 0; }');
		expect(css).toMatch(/\.note-meta \{[^}]*margin-top: 10px;[^}]*margin-bottom: 24px;/);
	});

	test('the list column is on the page plane, like the wiki tree; the splitter focus is an outline', () => {
		const css = styles(notes);
		expect(css).toMatch(/\.note-list \{[^}]*background: var\(--w-bg\);/);
		expect(css).not.toMatch(/\.note-splitter[^{]*\{[^}]*box-shadow/);
		expect(css).toMatch(/\.note-splitter:focus-visible \{[^}]*outline: 2px solid var\(--w-accent\)/);
	});

	test('phones: the note title keeps its size against mobile.css, and touch rows hold the seg', () => {
		const css = styles(notes);
		expect(css).toMatch(/@media \(max-width: 768px\) \{\s*\.note-heading \{ font-size: max\(16px, var\(--note-title-fs\)\) !important; \}/);
		expect(css).toMatch(/\.note-tools, \.compact \.note-tools \{ height: auto; min-height: 52px; \}/);
	});

	test('locality is said once (row A); the empty editor does not repeat it', () => {
		expect(page).not.toContain('stays in this browser');
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

describe('wiki and notes: declined links and focus after navigation', () => {
	test('declining the discard also declines a pending deep link, so it never opens later on its own', () => {
		expect(channel).toContain('function afterDiscard(leave: () => void, onDecline?: () => void): boolean {');
		expect(channel).toMatch(/if \(!discard\) \{\s*onDecline\?\.\(\);\s*return;\s*\}/);
		// The deep-link handoff passes a decline handler that clears the same pending link.
		expect(channel).toMatch(/afterDiscard\(\s*\(\) => \{ openPage\(hit\); if \(peekPendingNav\(\) === pending\) clearPendingNav\(\); \},[\s\S]{0,200}?\(\) => \{ if \(peekPendingNav\(\) === pending\) clearPendingNav\(\); \}\)/);
	});

	test('leaving for the overview moves focus to its heading, not <body>', () => {
		expect(channel).toMatch(/<h1 class="wiki-start-title"[^>]*tabindex="-1"[^>]*bind:this=\{startTitleEl\}/);
		expect(channel).toContain('void tick().then(() => { if (mounted) startTitleEl?.focus(); });');
	});

	test('New note focuses and selects the new title once the field is enabled again', () => {
		expect(notes).toContain('bind:this={headingEl}');
		const create = notes.slice(notes.indexOf('async function createNote()'), notes.indexOf('async function changeNote('));
		// The focus comes after `finally { busy = false; }`: the title field is disabled while busy.
		expect(create.indexOf('finally { busy = false; }')).toBeGreaterThan(0);
		expect(create.indexOf('headingEl?.focus();')).toBeGreaterThan(create.indexOf('finally { busy = false; }'));
		expect(create).toContain('headingEl?.select();');
	});
});
