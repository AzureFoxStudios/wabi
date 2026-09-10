import { describe, expect, test } from 'bun:test';
import { clampReaderProgress, findReaderMatches, readerPageMetrics } from './readerDocumentTools';

describe('reader search', () => {
	test('empty queries do not allocate highlights', () => {
		expect(findReaderMatches('A long document', '   ')).toEqual([]);
	});
	test('searches punctuation literally, not as a regex', () => {
		const text = 'a+b (draft) [x] .* a+b';
		expect(findReaderMatches(text, 'a+b')).toEqual([{ start: 0, end: 3 }, { start: 19, end: 22 }]);
		expect(findReaderMatches(text, '[x]')).toEqual([{ start: 12, end: 15 }]);
		expect(findReaderMatches(text, '.*')).toEqual([{ start: 16, end: 18 }]);
	});
	test('case insensitive matches retain original string offsets', () => {
		expect(findReaderMatches('Torin meets TORIN.', 'torin')).toEqual([{ start: 0, end: 5 }, { start: 12, end: 17 }]);
	});
	test('Unicode before a match does not corrupt offsets', () => {
		const text = 'İ 📖 Chapter two';
		const start = text.indexOf('Chapter');
		expect(findReaderMatches(text, 'chapter')).toEqual([{ start, end: start + 7 }]);
	});
	test('supports Thai text and astral characters', () => {
		expect(findReaderMatches('อ่านหนังสือ อ่านหนังสือ', 'หนังสือ')).toHaveLength(2);
		expect(findReaderMatches('📖 📖', '📖')).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
	});
	test('caps work on very long books without truncating source text', () => {
		const source = 'passage '.repeat(20000);
		expect(findReaderMatches(source, 'passage')).toHaveLength(1000);
		expect(findReaderMatches(source, 'passage', 3)).toHaveLength(3);
		expect(source.length).toBe(160000);
	});
	test('does not make overlapping matches', () => {
		expect(findReaderMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
	});
	test('zero match budget is respected', () => {
		expect(findReaderMatches('text', 'text', 0)).toEqual([]);
	});
});

describe('reader progress and real reflowed page counts', () => {
	test('clamps malformed progress', () => {
		expect(clampReaderProgress(NaN)).toBe(0);
		expect(clampReaderProgress(Infinity)).toBe(0);
		expect(clampReaderProgress(-1)).toBe(0);
		expect(clampReaderProgress(2)).toBe(1);
		expect(clampReaderProgress(0.42)).toBe(0.42);
	});
	test('handles empty and hidden viewports', () => {
		expect(readerPageMetrics(0, 0, 0)).toEqual({ current: 1, total: 1 });
		expect(readerPageMetrics(0, 0, 800)).toEqual({ current: 1, total: 1 });
	});
	test('one viewport is one page', () => {
		expect(readerPageMetrics(0, 800, 800)).toEqual({ current: 1, total: 1 });
	});
	test('exact page boundaries do not create phantom pages', () => {
		expect(readerPageMetrics(800, 2400, 800)).toEqual({ current: 2, total: 3 });
		expect(readerPageMetrics(1600, 2400, 800)).toEqual({ current: 3, total: 3 });
	});
	test('fractional layout rounding is tolerated', () => {
		expect(readerPageMetrics(799.9, 2400.4, 800)).toEqual({ current: 2, total: 3 });
	});
	test('overscroll stays inside the document', () => {
		expect(readerPageMetrics(-80, 2400, 800)).toEqual({ current: 1, total: 3 });
		expect(readerPageMetrics(3000, 2400, 800)).toEqual({ current: 3, total: 3 });
	});
});
