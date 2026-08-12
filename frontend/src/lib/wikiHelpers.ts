import type { WikiPage } from './wikiStore';

export interface WikiTreeNode {
	page: WikiPage;
	children: WikiTreeNode[];
}

export interface WikiBreadcrumb {
	pageId: string;
	title: string;
}

export interface WikiHeading {
	id: string;
	level: number;
	text: string;
}

export interface WikiSearchResult {
	page: WikiPage;
	excerpt: string;
	matchStart: number;
	matchEnd: number;
}

export interface WikiCitation {
	label: string;
	url: string;
}

function comparePages(a: WikiPage, b: WikiPage): number {
	return a.orderIndex - b.orderIndex || a.title.localeCompare(b.title) || a.pageId.localeCompare(b.pageId);
}

export function sortWikiPages(pages: WikiPage[]): WikiPage[] {
	return [...pages].filter((page) => !page.isDeleted).sort(comparePages);
}

export function buildWikiTree(pages: WikiPage[]): WikiTreeNode[] {
	const activePages = sortWikiPages(pages);
	const nodes = new Map(activePages.map((page) => [page.pageId, { page, children: [] as WikiTreeNode[] }]));
	const roots: WikiTreeNode[] = [];

	for (const node of nodes.values()) {
		const parent = node.page.parentPageId ? nodes.get(node.page.parentPageId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	return roots;
}

export function getWikiBreadcrumbs(pages: WikiPage[], pageId: string): WikiBreadcrumb[] {
	const byId = new Map(pages.filter((page) => !page.isDeleted).map((page) => [page.pageId, page]));
	const breadcrumbs: WikiBreadcrumb[] = [];
	const seen = new Set<string>();
	let current = byId.get(pageId);

	while (current && !seen.has(current.pageId)) {
		seen.add(current.pageId);
		breadcrumbs.unshift({ pageId: current.pageId, title: current.title });
		current = current.parentPageId ? byId.get(current.parentPageId) : undefined;
	}

	return breadcrumbs;
}

export function slugifyWikiTitle(title: string): string {
	return title
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim()
		.replace(/[^\p{Letter}\p{Number}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
}

export function getWikiCitation(
	serverUrl: string,
	channelId: string,
	page: Pick<WikiPage, 'pageId' | 'slug' | 'title' | 'updatedAtMicros'>
): WikiCitation {
	const origin = serverUrl.replace(/\/$/, '');
	const slug = page.slug || slugifyWikiTitle(page.title) || page.pageId;
	const url = `${origin}/wiki/${encodeURIComponent(channelId)}/${encodeURIComponent(slug)}`;
	const updatedMs = page.updatedAtMicros > 1e12 ? Math.floor(page.updatedAtMicros / 1000) : page.updatedAtMicros;
	const date = updatedMs > 0 ? new Date(updatedMs).toISOString().slice(0, 10) : 'unknown date';
	return { label: `${page.title} — Wabi, updated ${date}`, url };
}

export function extractWikiHeadings(markdown: string): WikiHeading[] {
	const usedIds = new Map<string, number>();
	const headings: WikiHeading[] = [];

	for (const line of markdown.split(/\r?\n/)) {
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		const text = match[2].replace(/[*_`]/g, '').trim();
		if (!text) continue;
		const baseId = slugifyWikiTitle(text) || 'section';
		const count = usedIds.get(baseId) ?? 0;
		usedIds.set(baseId, count + 1);
		headings.push({ id: count ? `${baseId}-${count + 1}` : baseId, level: match[1].length, text });
	}

	return headings;
}

export function searchWikiPages(pages: WikiPage[], query: string, excerptRadius = 80): WikiSearchResult[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [];

	return sortWikiPages(pages)
		.map((page) => {
			const haystack = `${page.title}\n${page.body}`;
			const matchStart = haystack.toLocaleLowerCase().indexOf(needle);
			if (matchStart < 0) return null;
			const start = Math.max(0, matchStart - excerptRadius);
			const end = Math.min(haystack.length, matchStart + needle.length + excerptRadius);
			return {
				page,
				excerpt: `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`,
				matchStart: matchStart - start + (start > 0 ? 1 : 0),
				matchEnd: matchStart - start + needle.length + (start > 0 ? 1 : 0),
			};
		})
		.filter((result): result is WikiSearchResult => result !== null);
}

export function insertWikiMarkdown(text: string, selectionStart: number, selectionEnd: number, insertion: string): {
	value: string;
	selectionStart: number;
	selectionEnd: number;
} {
	const start = Math.max(0, Math.min(selectionStart, text.length));
	const end = Math.max(start, Math.min(selectionEnd, text.length));
	const value = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
	return { value, selectionStart: start, selectionEnd: start + insertion.length };
}

export function formatWikiCitationMarkdown(citation: WikiCitation): string {
	return `[${citation.label}](${citation.url})`;
}
