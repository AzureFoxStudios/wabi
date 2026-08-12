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
