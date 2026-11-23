import { expect, test } from 'bun:test';
import { fillPlacements, parseClip, parseTsv, placeClip, valuesToTsv, type CellClip } from './clipboard';

const clip = (cells: string[][], origin = { r: 0, c: 0 }, cut = false): CellClip => ({ v: 1, rows: cells.length, columns: cells[0].length, cells, origin, cut });

test('text for other apps quotes anything that could run as a formula there', () => {
	const text = valuesToTsv([[{ text: '=HYPERLINK("x")', numeric: false }, { text: '-5', numeric: true }, { text: '@x', numeric: false }, { text: 'a\tb', numeric: false }]]);
	// The formula text gets an apostrophe, then its quotes are doubled and the field quoted;
	// a real number is left alone; a field holding a tab is quoted.
	expect(text).toBe('"\'=HYPERLINK(""x"")"\t-5\t\'@x\t"a\tb"');
});

test('rows and columns become newlines and tabs', () => {
	expect(valuesToTsv([[{ text: 'a', numeric: false }, { text: '1', numeric: true }], [{ text: 'b', numeric: false }, { text: '2', numeric: true }]])).toBe('a\t1\nb\t2');
});

test('tab-separated text parses, including quoted tabs, quotes and newlines', () => {
	expect(parseTsv('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']]);
	expect(parseTsv('"a\tb"\t"say ""hi"""\n"line1\nline2"\tz')).toEqual([['a\tb', 'say "hi"'], ['line1\nline2', 'z']]);
	expect(parseTsv('x\r\ny\r\n')).toEqual([['x'], ['y']]);
	expect(() => parseTsv('"open')).toThrow('unclosed quote');
});

test('a well-formed Wabi payload is accepted', () => {
	const good = clip([['1', '=A1+1'], ['x', '']], { r: 2, c: 3 }, true);
	expect(parseClip(JSON.stringify(good))).toEqual(good);
});

test('anything else is rejected, so it falls back to plain text', () => {
	const good = clip([['1']]);
	for (const bad of [
		undefined, null, '', 'not json', '[]', '{}', '"x"',
		JSON.stringify({ ...good, v: 2 }),
		JSON.stringify({ ...good, cut: 'no' }),
		JSON.stringify({ ...good, rows: 2 }),
		JSON.stringify({ ...good, columns: 0 }),
		JSON.stringify({ ...good, origin: { r: -1, c: 0 } }),
		JSON.stringify({ ...good, cells: [[1]] }),
		JSON.stringify({ ...good, cells: [['a', 'b']] }),
		JSON.stringify({ ...good, cells: [['x'.repeat(9000)]] }),
		JSON.stringify({ v: 1, rows: 100, columns: 100, cut: false, origin: { r: 0, c: 0 }, cells: Array.from({ length: 100 }, () => Array(100).fill('1')) })
	]) expect(parseClip(bad as string)).toBeNull();
});

test('a block pastes from the active cell and its formulas move with it', () => {
	const placed = placeClip(clip([['=A1+B1', '5']], { r: 0, c: 2 }), { r: 3, c: 0 }, null);
	expect(placed).toEqual([{ r: 3, c: 0, input: '=#REF!+#REF!' }, { r: 3, c: 1, input: '5' }]);
	const moved = placeClip(clip([['=A1+B1']], { r: 0, c: 2 }), { r: 4, c: 3 }, null);
	expect(moved[0].input).toBe('=B5+C5');
});

test('absolute references stay put when pasted', () => {
	expect(placeClip(clip([['=$A$1+A1']]), { r: 2, c: 1 }, null)[0].input).toBe('=$A$1+B3');
});

test('one copied cell fills the whole selection, each cell adjusting its references', () => {
	const placed = placeClip(clip([['=A1*2']]), { r: 1, c: 1 }, { r0: 1, r1: 3, c0: 1, c1: 1 });
	expect(placed.map((p) => [p.r, p.c, p.input])).toEqual([[1, 1, '=B2*2'], [2, 1, '=B3*2'], [3, 1, '=B4*2']]);
});

test('a multi-cell clip ignores the selection size and pastes as a block', () => {
	const placed = placeClip(clip([['1', '2']]), { r: 0, c: 0 }, { r0: 0, r1: 5, c0: 0, c1: 5 });
	expect(placed).toHaveLength(2);
});

test('fill copies the source down or across, shifting relative references', () => {
	const down = fillPlacements({ r: 0, c: 0, input: '=B1*2' }, [{ r: 1, c: 0 }, { r: 2, c: 0 }]);
	expect(down.map((p) => p.input)).toEqual(['=B2*2', '=B3*2']);
	const across = fillPlacements({ r: 0, c: 0, input: '=A$1+1' }, [{ r: 0, c: 1 }]);
	expect(across[0].input).toBe('=B$1+1');
	expect(fillPlacements({ r: 0, c: 0, input: 'text' }, [{ r: 1, c: 0 }])[0].input).toBe('text');
});
