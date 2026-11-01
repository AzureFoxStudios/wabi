import { describe, expect, test } from 'bun:test';
import {
	buildWikiTree,
	extractWikiHeadings,
	formatWikiCitationMarkdown,
	getWikiBreadcrumbs,
	getWikiCitation,
	insertWikiMarkdown,
	searchWikiPages,
	slugifyWikiTitle,
} from './wikiHelpers';
import type { WikiPage } from './wikiStore';
import {
	buildWikiOutline,
	currentSectionIndex,
	flattenOutline,
	hangsMarkers,
	headingAnchorIds,
	outlinePlace,
	paneHasMargin,
	shouldOpenOnlyPage,
	WIKI_MARGIN_PANE,
	showsOutline,
	treeColumnShown,
	wikiVersionNote,
} from './wikiReading';

function page(overrides: Partial<WikiPage> = {}): WikiPage {
	return {
		pageId: 'page-1',
		channelId: 'wiki-1',
		title: 'Home',
		body: 'Welcome to the wiki.',
		authorUserId: 1,
		createdAtMicros: 1_700_000_000_000,
		updatedAtMicros: 1_700_000_000_000,
		isDeleted: false,
		parentPageId: '',
		slug: '',
		orderIndex: 0,
		...overrides,
	};
}

describe('wiki helpers', () => {
	test('builds a stable nested tree and excludes deleted pages', () => {
		const roots = buildWikiTree([
			page({ pageId: 'child', title: 'Child', parentPageId: 'root', orderIndex: 2 }),
			page({ pageId: 'root', title: 'Root', orderIndex: 1 }),
			page({ pageId: 'deleted', title: 'Deleted', isDeleted: true }),
			page({ pageId: 'child-early', title: 'Early', parentPageId: 'root', orderIndex: 1 }),
		]);

		expect(roots.map((node) => node.page.pageId)).toEqual(['root']);
		expect(roots[0].children.map((node) => node.page.title)).toEqual(['Early', 'Child']);
	});

	test('returns breadcrumbs and stops safely on a cyclic parent chain', () => {
		const pages = [
			page({ pageId: 'a', title: 'A', parentPageId: 'b' }),
			page({ pageId: 'b', title: 'B', parentPageId: 'a' }),
		];

		expect(getWikiBreadcrumbs(pages, 'a')).toEqual([
			{ pageId: 'b', title: 'B' },
			{ pageId: 'a', title: 'A' },
		]);
	});

	test('creates readable slugs and stable citations', () => {
		expect(slugifyWikiTitle('  Café & Design  ')).toBe('cafe-design');
		const citation = getWikiCitation('https://wabi.example/', 'wiki channel', page({ slug: 'home', updatedAtMicros: 1_700_000_000_000 }));
		expect(citation.url).toBe('https://wabi.example/wiki/wiki%20channel/home');
		expect(formatWikiCitationMarkdown(citation)).toContain('https://wabi.example/wiki/wiki%20channel/home');
	});

	test('extracts duplicate-safe headings', () => {
		expect(extractWikiHeadings('# Intro\n\n## Details\n### Details\n')).toEqual([
		{ id: 'intro', level: 1, text: 'Intro' },
		{ id: 'details', level: 2, text: 'Details' },
		{ id: 'details-2', level: 3, text: 'Details' },
	]);
	});

	test('searches active pages and returns an excerpt', () => {
		const results = searchWikiPages([
			page({ pageId: 'match', title: 'Deployment', body: 'Deploy the server safely.' }),
			page({ pageId: 'deleted', title: 'Deployment', body: 'Deploy', isDeleted: true }),
		], 'safely');
		expect(results).toHaveLength(1);
		expect(results[0].page.pageId).toBe('match');
		expect(results[0].excerpt).toContain('safely');
	});

	test('inserts markdown at the selected range', () => {
		expect(insertWikiMarkdown('hello world', 6, 11, '**world**')).toEqual({
		value: 'hello **world**',
		selectionStart: 6,
		selectionEnd: 15,
	});
	});
});

// Contract: design spec §8.7 (wiki: tree, article 720, ON THIS PAGE outline at >=1100 stage)
// and critiques forum-wiki#3, #5, #10, #17.
describe('wiki reading', () => {
	const heading = (id: string, level: number, text = id) => ({ id, level, text });

	test('the outline keeps two tiers from the shallowest heading on the page', () => {
		const outline = buildWikiOutline([
			heading('intro', 1, 'A place to make things together'),
			heading('guide', 2, 'Our field guide'),
			heading('deep', 3, 'Too deep for the outline'),
			heading('rhythm', 2, 'Weekly rhythm'),
		]);
		expect(outline.map((entry) => entry.text)).toEqual(['A place to make things together']);
		expect(outline[0].children.map((entry) => entry.text)).toEqual(['Our field guide', 'Weekly rhythm']);
		expect(flattenOutline(outline).map((entry) => entry.id)).toEqual(['intro', 'guide', 'rhythm']);
	});

	test('a page that starts at ## lists ## and ###; a lone deeper heading is not dropped', () => {
		const outline = buildWikiOutline([heading('lead', 3), heading('a', 2), heading('a1', 3), heading('b', 2)]);
		expect(outline.map((entry) => entry.id)).toEqual(['lead', 'a', 'b']);
		expect(outline[1].children.map((entry) => entry.id)).toEqual(['a1']);
	});

	test('the outline shows from two sections up', () => {
		expect(showsOutline(buildWikiOutline([heading('only', 2)]))).toBe(false);
		expect(showsOutline(buildWikiOutline([heading('a', 2), heading('b', 2)]))).toBe(true);
		expect(showsOutline(buildWikiOutline([heading('blank', 2, '  ')]))).toBe(false);
	});

	test('ON THIS PAGE has exactly one place for each width', () => {
		// 1536 with People unpinned: a 1228px stage leaves a 958px pane beside the tree.
		expect(outlinePlace(958, true)).toBe('margin');
		// A 1100px stage leaves about 858px: the margin would squeeze the article under 600px,
		// so the outline sits under the tree and the article keeps its 720 column.
		expect(outlinePlace(858, true)).toBe('side');
		// 1536 with People pinned (the acceptance capture): a 632px pane.
		expect(outlinePlace(632, true)).toBe('side');
		expect(outlinePlace(632, false)).toBe('inline');
		expect(outlinePlace(1536, false)).toBe('margin');
		expect(treeColumnShown(852, false)).toBe(true);
		expect(treeColumnShown(700, false)).toBe(false);
		expect(treeColumnShown(1200, true)).toBe(false);
	});

	test('the margin column only exists where the article keeps 600px beside it', () => {
		// 600 article + 40 gap + 200 outline + two 32px gutters.
		expect(WIKI_MARGIN_PANE).toBe(904);
		expect(paneHasMargin(903)).toBe(false);
		expect(paneHasMargin(904)).toBe(true);
		// In a 958px pane the grid gives the article 958 - 64 - 40 - 240 = 614px: never under 600.
		expect(958 - 64 - 40 - 240).toBeGreaterThanOrEqual(600);
	});

	test('heading markers hang only where the column has 48px of free page beside it', () => {
		expect(hangsMarkers(632)).toBe(false);
		expect(hangsMarkers(816)).toBe(true);
		// The margin column puts the block at 1000px, so a 958px pane has no room to hang.
		expect(hangsMarkers(958)).toBe(false);
		expect(hangsMarkers(1096)).toBe(true);
	});

	test('the current section is the last heading that reached the reading line', () => {
		expect(currentSectionIndex([], 96)).toBe(-1);
		expect(currentSectionIndex([300, 600], 96)).toBe(0);
		expect(currentSectionIndex([-400, 40, 600], 96)).toBe(1);
		expect(currentSectionIndex([-900, -500, -100], 96)).toBe(2);
	});

	test('version words are true: no "0 revisions", one edit per revision', () => {
		expect(wikiVersionNote(0)).toBe('Original version');
		expect(wikiVersionNote(1)).toBe('Edited once');
		expect(wikiVersionNote(4)).toBe('Edited 4 times');
	});

	test('a wiki with one page opens it once, never over a draft or a chosen page', () => {
		const base = { pageCount: 1, selectedPageId: null, composing: false, alreadyDecided: false };
		expect(shouldOpenOnlyPage(base)).toBe(true);
		expect(shouldOpenOnlyPage({ ...base, pageCount: 2 })).toBe(false);
		expect(shouldOpenOnlyPage({ ...base, selectedPageId: 'p' })).toBe(false);
		expect(shouldOpenOnlyPage({ ...base, composing: true })).toBe(false);
		expect(shouldOpenOnlyPage({ ...base, alreadyDecided: true })).toBe(false);
	});

	test('heading anchors are unique per page and per mounted wiki', () => {
		expect(headingAnchorIds(['Weekly rhythm', 'Weekly rhythm', 'Café', '!!'], 'wiki-panel')).toEqual([
			'wiki-panel-weekly-rhythm',
			'wiki-panel-weekly-rhythm-2',
			'wiki-panel-cafe',
			'wiki-panel-section',
		]);
	});

	test('a heading titled like a numbered repeat never collides with the repeat (keyed outline)', () => {
		const ids = headingAnchorIds(['Weekly rhythm', 'Weekly rhythm', 'Weekly rhythm 2', 'Weekly rhythm 2'], 'p');
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(['p-weekly-rhythm', 'p-weekly-rhythm-2', 'p-weekly-rhythm-2-2', 'p-weekly-rhythm-2-3']);
		const reversed = headingAnchorIds(['Weekly rhythm 2', 'Weekly rhythm', 'Weekly rhythm'], 'p');
		expect(new Set(reversed).size).toBe(3);
	});
});
