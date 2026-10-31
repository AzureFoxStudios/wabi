import { describe, expect, test } from 'bun:test';
import { currentHeading, documentFacts, documentHeadings, documentOutline, startedLine, wordCount } from './documentPage';

// The Documents page's CONTENTS, FACTS and meta line (design contract §8.8).

const DOC = [
	'Eight stories and a map.',
	'',
	'## The places',
	'1. **The bench** — Amara',
	'',
	'```',
	'## not a heading (code)',
	'```',
	'',
	'### A [linked](https://wabi.example) `detail`',
	'',
	'## Before Monday',
	'- [ ] Draft one page each'
].join('\n');

describe('CONTENTS', () => {
	const headings = documentHeadings(DOC, 'markdown');
	test('lists Markdown headings with their line offsets, never ones inside fenced code', () => {
		expect(headings.map((heading) => heading.text)).toEqual(['The places', 'A linked detail', 'Before Monday']);
		for (const heading of headings) expect(DOC.slice(heading.offset).startsWith('#')).toBe(true);
	});
	test('has no headings for plain text, HTML or code documents', () => {
		expect(documentHeadings('## Looks like one', 'text')).toEqual([]);
		expect(documentHeadings('## Looks like one', 'code')).toEqual([]);
	});
	test('nests the second tier under the first (ids are offsets)', () => {
		const outline = documentOutline(headings);
		expect(outline.map((entry) => entry.text)).toEqual(['The places', 'Before Monday']);
		expect(outline[0].children.map((entry) => entry.text)).toEqual(['A linked detail']);
		expect(outline[0].id).toBe(String(headings[0].offset));
	});
	test('the current section is the last heading at or above the caret; above them all is the title', () => {
		expect(currentHeading(headings, 0)).toBe(-1);
		expect(currentHeading(headings, headings[0].offset)).toBe(0);
		expect(currentHeading(headings, DOC.indexOf('Draft'))).toBe(2);
	});
});

describe('FACTS', () => {
	const now = new Date(2026, 8, 21, 10, 0).getTime();
	test('count words as a reader does (Markdown markers are not words)', () => {
		expect(wordCount('## The places\n- [ ] Draft one page')).toBe(5);
		expect(wordCount("Nora's café, 2 min — ok")).toBe(5);
	});
	test('reading time rounds to minutes and an empty page reads "—", never "0 min"', () => {
		expect(documentFacts('', 'markdown', now, now, 'en-GB').reading).toBe('—');
		expect(documentFacts('word '.repeat(460), 'markdown', now, now, 'en-GB').reading).toBe('2 min');
		expect(documentFacts('one', 'markdown', now, now, 'en-GB').reading).toBe('1 min');
	});
	test('edited today is a time, another day a date; the format is a word', () => {
		const today = documentFacts('x', 'markdown', new Date(2026, 8, 21, 9, 41).getTime(), now, 'en-GB');
		expect(today.edited).toBe('09:41');
		expect(today.format).toBe('Markdown');
		const before = documentFacts('x', 'text', new Date(2026, 8, 19, 9, 41).getTime(), now, 'en-GB');
		expect(before.edited).toBe('19 Sept');
		expect(before.format).toBe('Plain text');
	});
});

describe('meta line', () => {
	test('"Started" with the weekday and date; the year only when it is another year', () => {
		const now = new Date(2026, 8, 21).getTime();
		expect(startedLine(new Date(2026, 8, 19).getTime(), now, 'en-GB')).toBe('Started Saturday 19 September');
		expect(startedLine(new Date(2025, 8, 19).getTime(), now, 'en-GB')).toBe('Started Friday 19 September 2025');
	});
});
