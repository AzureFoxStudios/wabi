/**
 * The Documents page's reading aids (design contract §8.8): CONTENTS (the document's headings,
 * two tiers under its title), FACTS (Words, Reading, Edited, Format) and the meta line's
 * "Started …" date. Pure functions over the document's text, so the page is tested without a
 * browser. Headings inside fenced code are not headings.
 */
import { buildWikiOutline, type OutlineEntry } from '$lib/wikiReading';

export interface DocumentHeading {
	/** Where the heading's line starts in the text (the outline jumps here). */
	offset: number;
	level: number;
	text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** The Markdown headings of `text`, in reading order; none for other formats. */
export function documentHeadings(text: string, format: string): DocumentHeading[] {
	if (format !== 'markdown') return [];
	const headings: DocumentHeading[] = [];
	let fence: string | null = null;
	let offset = 0;
	for (const line of text.split('\n')) {
		const fenceMatch = FENCE.exec(line);
		if (fence !== null) {
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
		} else if (fenceMatch) {
			fence = fenceMatch[1];
		} else {
			const match = HEADING.exec(line);
			const words = match ? stripInline(match[2]) : '';
			if (match && words) headings.push({ offset, level: match[1].length, text: words });
		}
		offset += line.length + 1;
	}
	return headings;
}

/** Heading words without their inline markers (`**`, `_`, backticks, link syntax). */
function stripInline(words: string): string {
	let text = words;
	let previous = '';
	// One pattern per pass, repeated until the text stops changing (nested links unwrap too).
	while (text !== previous) {
		previous = text;
		text = text.replace(/\[([^\]\n]*)\]\([^)\s]*\)/, '$1');
	}
	return text.split('').filter((char) => char !== '*' && char !== '_' && char !== '`').join('').trim();
}

/** The outline below the title: two tiers at most, ids are the headings' offsets. */
export function documentOutline(headings: readonly DocumentHeading[]): OutlineEntry[] {
	return buildWikiOutline(headings.map((heading) => ({ id: String(heading.offset), level: heading.level, text: heading.text })));
}

/** The heading the caret is under: the last one starting at or before it (-1: above them all). */
export function currentHeading(headings: readonly DocumentHeading[], caret: number): number {
	let current = -1;
	for (let index = 0; index < headings.length; index += 1) {
		if (headings[index].offset <= caret) current = index;
		else break;
	}
	return current;
}

/** Words as a reader counts them: runs of letters or digits (Markdown markers are not words). */
export function wordCount(text: string): number {
	return text.match(/[\p{Letter}\p{Number}][\p{Letter}\p{Number}'’-]*/gu)?.length ?? 0;
}

const FORMAT_WORDS: Readonly<Record<string, string>> = { markdown: 'Markdown', text: 'Plain text', html: 'HTML', code: 'Code' };

export interface DocumentFacts {
	words: string;
	reading: string;
	edited: string;
	format: string;
}

/**
 * FACTS: Words, Reading (about 230 words a minute), Edited (a time today, else a date) and
 * Format. An empty document reads "—", never "0 min".
 */
export function documentFacts(text: string, format: string, editedAt: number, now: number = Date.now(), locale?: string): DocumentFacts {
	const words = wordCount(text);
	const edited = new Date(editedAt);
	const sameDay = edited.toDateString() === new Date(now).toDateString();
	return {
		words: new Intl.NumberFormat(locale).format(words),
		reading: words === 0 ? '—' : `${Math.max(1, Math.round(words / 230))} min`,
		edited: sameDay
			? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(edited)
			: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(edited),
		format: FORMAT_WORDS[format] ?? format
	};
}

/** "Started Saturday 19 September" (with the year when it is not this year). */
export function startedLine(createdAt: number, now: number = Date.now(), locale?: string): string {
	const date = new Date(createdAt);
	const thisYear = date.getFullYear() === new Date(now).getFullYear();
	const words = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', ...(thisYear ? {} : { year: 'numeric' }) }).format(date);
	return `Started ${words.replaceAll(',', '')}`;
}
