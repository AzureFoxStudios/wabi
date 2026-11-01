/**
 * Reading-side helpers for the wiki (design contract §8.7): the ON THIS PAGE outline, where it
 * sits, which section is current, the article's meta words, and when a wiki opens its only page.
 * Pure functions, so WikiChannel's behaviour is tested without a browser.
 */

export interface OutlineHeading {
	id: string;
	level: number;
	text: string;
}

export interface OutlineEntry {
	id: string;
	text: string;
	children: OutlineEntry[];
}

/**
 * Two tiers at most, measured from the shallowest heading on the page: a page that starts its
 * sections at `#` lists `#` and `##`; one that starts at `##` lists `##` and `###`. A deeper
 * heading before any top-tier heading is listed at the top tier.
 */
export function buildWikiOutline(headings: readonly OutlineHeading[]): OutlineEntry[] {
	const written = headings.filter((heading) => heading.text.trim());
	if (written.length === 0) return [];
	const top = Math.min(...written.map((heading) => heading.level));
	const outline: OutlineEntry[] = [];
	for (const heading of written) {
		if (heading.level > top + 1) continue;
		const entry: OutlineEntry = { id: heading.id, text: heading.text.trim(), children: [] };
		const parent = outline.at(-1);
		if (heading.level === top || !parent) outline.push(entry);
		else parent.children.push(entry);
	}
	return outline;
}

/** Every entry, top tier and sub-entries, in reading order. */
export function flattenOutline(outline: readonly OutlineEntry[]): OutlineEntry[] {
	return outline.flatMap((entry) => [entry, ...entry.children]);
}

/** The outline is worth showing from two sections up. */
export function showsOutline(outline: readonly OutlineEntry[]): boolean {
	return flattenOutline(outline).length >= 2;
}

/**
 * The current section: the last heading whose top has reached `line` (a reading line a little
 * below the top of the scroller). Before the first heading, the first one is current. `tops` are
 * the headings' offsets from the scroller's top edge, in reading order.
 */
export function currentSectionIndex(tops: readonly number[], line: number): number {
	if (tops.length === 0) return -1;
	let current = 0;
	for (let index = 0; index < tops.length; index += 1) {
		if (tops[index] <= line) current = index;
		else break;
	}
	return current;
}

export type OutlinePlace = 'margin' | 'side' | 'inline';

/**
 * The reading block (design contract §8.7, §4.2): a 720 column, and beside it, when the pane has
 * room, a margin column for ON THIS PAGE (200–240px after a 40px gap). The margin only appears
 * when the article keeps at least WIKI_READING_MIN beside it, so the outline never squeezes the
 * page narrower than the plain column would be. Widths assume the 32px stage gutter.
 */
export const WIKI_COLUMN = 720;
export const WIKI_READING_MIN = 600;
export const WIKI_MARGIN_GAP = 40;
export const WIKI_MARGIN_MIN = 200;
export const WIKI_MARGIN_MAX = 240;
const GUTTER = 32;
/** The narrowest reading pane that carries the margin column. */
export const WIKI_MARGIN_PANE = WIKI_READING_MIN + WIKI_MARGIN_GAP + WIKI_MARGIN_MIN + 2 * GUTTER;

/**
 * The pane keeps a margin column: reading (with or without an outline), Edit and New page all lay
 * out on the same block then, so the title never moves when you press Edit or open another page.
 */
export function paneHasMargin(paneWidth: number): boolean {
	return paneWidth >= WIKI_MARGIN_PANE;
}

/**
 * Where ON THIS PAGE goes. In the right margin when the pane carries the margin column (about a
 * 1250px stage beside the tree, or fullscreen reading); otherwise under the page tree while the
 * tree column shows; otherwise (phone, companion panel) as a collapsed disclosure under the
 * article meta. Never pushes the article down when it has a place beside it.
 */
export function outlinePlace(paneWidth: number, treeColumnShown: boolean): OutlinePlace {
	if (paneHasMargin(paneWidth)) return 'margin';
	if (treeColumnShown) return 'side';
	return 'inline';
}

/**
 * The writing surface's Markdown heading markers hang left of the column only where the column
 * has at least 48px of free page beside it (its 40px hang room plus air); otherwise they stay in
 * the line, so nothing reaches past the pane edge.
 */
export function hangsMarkers(paneWidth: number): boolean {
	const block = paneHasMargin(paneWidth) ? WIKI_COLUMN + WIKI_MARGIN_GAP + WIKI_MARGIN_MAX : WIKI_COLUMN;
	return (paneWidth - block) / 2 >= 48;
}

/** The tree is a column of its own from a 760px wiki; narrower, and in the panel, it stacks. */
export function treeColumnShown(wikiWidth: number, inPanel: boolean): boolean {
	return !inPanel && wikiWidth >= 760;
}

/**
 * The article meta's version words. Every saved edit keeps the page as it was before as a
 * revision, so the count of revisions is the count of edits. "Original version" until then.
 */
export function wikiVersionNote(revisionCount: number): string {
	if (revisionCount <= 0) return 'Original version';
	return revisionCount === 1 ? 'Edited once' : `Edited ${revisionCount} times`;
}

/**
 * A wiki with exactly one page opens it instead of the overview, the first time that wiki loads
 * in this view and only when nothing else is open or being written. Going back to the overview
 * from the breadcrumb afterwards stays there.
 */
export function shouldOpenOnlyPage(input: {
	pageCount: number;
	selectedPageId: string | null;
	composing: boolean;
	alreadyDecided: boolean;
}): boolean {
	return !input.alreadyDecided && input.pageCount === 1 && input.selectedPageId === null && !input.composing;
}

/**
 * Ids for the rendered headings: unique per page and per mounted wiki (center and panel). A
 * repeated title takes the next free "-2", "-3"…, checked against every id already given, so a
 * heading literally titled "Weekly rhythm 2" can never collide with the second "Weekly rhythm".
 */
export function headingAnchorIds(texts: readonly string[], prefix: string): string[] {
	const used = new Set<string>();
	return texts.map((text) => {
		const words = text
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.split(/[^\p{Letter}\p{Number}]+/u)
			.filter(Boolean);
		const base = words.join('-') || 'section';
		let candidate = base;
		for (let count = 2; used.has(candidate); count += 1) candidate = `${base}-${count}`;
		used.add(candidate);
		return `${prefix}-${candidate}`;
	});
}
