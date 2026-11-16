import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { calculate, cellKey, columnIndex, literal, parseFormula, FormulaError, FORMULA_FUNCTIONS, type CellVersion, type Scalar, type WorkbookSnapshot } from './formula';
import { FUNCTION_CATALOG } from './functionCatalog';
import { dateToSerial, serialToDate, formatText, wildcardMatch } from './formulaFunctions';
import { initialize, orderedSheets, axes, setCell, snapshot } from './model';

/** One 60 x 26 sheet; `cells` maps A1 addresses to what the user typed. */
function book(cells: Record<string, string>, rowCount = 60): WorkbookSnapshot {
	const sheet = {
		id: 's1', name: 'Sheet1',
		rows: Array.from({ length: rowCount }, (_, i) => ({ id: `r${i}`, position: i })),
		columns: Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, position: i })),
		cells: {} as Record<string, CellVersion[]>
	};
	const wb: WorkbookSnapshot = { sheets: [sheet] };
	for (const [address, input] of Object.entries(cells)) {
		const m = /^([A-Z]+)(\d+)$/.exec(address)!;
		const key = cellKey(`r${Number(m[2]) - 1}`, `c${columnIndex(m[1])}`);
		const version: CellVersion = { id: `v-${address}`, cell: key, input, parents: [] };
		if (input.startsWith('=')) {
			try { version.expression = parseFormula(input, wb, 's1'); } catch (e) { version.parseError = (e as FormulaError).code; }
		}
		sheet.cells[key] = [version];
	}
	return wb;
}
function sheet(cells: Record<string, string>, now?: Date) {
	const result = calculate(book(cells), now);
	return (address: string): Scalar | string => {
		const m = /^([A-Z]+)(\d+)$/.exec(address)!;
		const id = `s1/${cellKey(`r${Number(m[2]) - 1}`, `c${columnIndex(m[1])}`)}`;
		return result.errors[id] ?? result.values[id];
	};
}
/** Evaluates one formula in Z60-ish scratch space beside the given data (formula lives in Z1). */
const f = (formula: string, data: Record<string, string> = {}, now?: Date) => sheet({ ...data, Z1: formula.startsWith('=') ? formula : `=${formula}` }, now)('Z1');
const serial = (y: number, m: number, d: number) => dateToSerial(y, m, d)!;

describe('catalog and registry', () => {
	test('every function is in the calculator and the catalog, alphabetically', () => {
		const names = FUNCTION_CATALOG.map((i) => i.name);
		expect(names).toEqual([...names].sort());
		expect(new Set(names)).toEqual(FORMULA_FUNCTIONS);
		expect(FORMULA_FUNCTIONS.size).toBeGreaterThanOrEqual(70);
	});
	test('wrong argument counts are #ARGS!, never a guess', () => {
		expect(f('IFERROR(1)')).toBe('#ARGS!');
		expect(f('MID("abc",1)')).toBe('#ARGS!');
		expect(f('TODAY(1)')).toBe('#ARGS!');
		expect(f('IFS(TRUE,1,FALSE)')).toBe('#ARGS!');
		expect(f('SUMIFS(A1:A2,B1:B2)')).toBe('#ARGS!');
		expect(f('COUNTIFS(A1:A2,">1",B1:B2)')).toBe('#ARGS!');
	});
});

describe('logic and error handling', () => {
	test('IFERROR catches #DIV/0! and other Excel errors, otherwise passes the value through', () => {
		expect(f('IFERROR(1/0,"fallback")')).toBe('fallback');
		expect(f('IFERROR(5,1/0)')).toBe(5); // the fallback is never evaluated
		expect(f('IFERROR(SQRT(-1),-1)')).toBe(-1);
		expect(f('IFERROR(A1,"x")', { A1: '=1/0' })).toBe('x');
		expect(f('IFERROR(A1+1,"x")', { A1: '=1/0' })).toBe('x');
	});
	test('IFNA catches only #N/A', () => {
		expect(f('IFNA(MATCH(9,A1:A3,0),"none")', { A1: '1', A2: '2', A3: '3' })).toBe('none');
		expect(f('IFNA(1/0,"none")')).toBe('#DIV/0!');
	});
	test('internal errors such as cycles are not swallowed by IFERROR', () => {
		const get = sheet({ A1: '=IFERROR(B1,0)', B1: '=A1' });
		expect(get('A1')).toBe('#CYCLE!');
		expect(get('B1')).toBe('#CYCLE!');
		const calc = calculate(book({ A1: '=IFERROR(B1,0)', B1: '=A1' }));
		expect(Object.keys(calc.values)).toEqual([]);
	});
	test('IFS returns the first true branch, #N/A when none, and rejects text conditions', () => {
		expect(f('IFS(1>2,"a",2>1,"b",TRUE,"c")')).toBe('b');
		expect(f('IFS(1>2,"a")')).toBe('#N/A');
		expect(f('IFS("maybe",1)')).toBe('#VALUE!');
		expect(f('IFS(TRUE,1,1/0,2)')).toBe(1); // later branches are lazy
	});
	test('SWITCH matches text case-insensitively and supports a default', () => {
		expect(f('SWITCH("B","a",1,"b",2)')).toBe(2);
		expect(f('SWITCH(3,1,"one",2,"two","other")')).toBe('other');
		expect(f('SWITCH(3,1,"one")')).toBe('#N/A');
	});
	test('XOR counts true values and ignores text in ranges', () => {
		expect(f('XOR(TRUE,FALSE)')).toBe(true);
		expect(f('XOR(TRUE,TRUE)')).toBe(false);
		expect(f('XOR(TRUE,TRUE,TRUE)')).toBe(true);
		expect(f('XOR(A1:A3)', { A1: 'x', A2: 'true', A3: '0' })).toBe(true);
		expect(f('XOR(A1:A2)', { A1: 'x' })).toBe('#VALUE!');
	});
	test('IS functions', () => {
		const data = { A1: '5', A2: 'hi', A4: '=1/0', A5: '=NA' };
		expect(f('ISNUMBER(A1)', data)).toBe(true);
		expect(f('ISNUMBER(A2)', data)).toBe(false);
		expect(f('ISNUMBER("5")')).toBe(false);
		expect(f('ISTEXT(A2)', data)).toBe(true);
		expect(f('ISTEXT(A1)', data)).toBe(false);
		expect(f('ISBLANK(A3)', data)).toBe(true);
		expect(f('ISBLANK(A1)', data)).toBe(false);
		expect(f('ISBLANK("")')).toBe(false);
		expect(f('ISERROR(A4)', data)).toBe(true);
		expect(f('ISERROR(A1)', data)).toBe(false);
		expect(f('ISNA(MATCH(1,A1:A2,0))', { A1: '2' })).toBe(true);
		expect(f('ISNA(A4)', data)).toBe(false);
	});
});

describe('math', () => {
	test('INT floors, including negatives', () => {
		expect(f('INT(3.9)')).toBe(3);
		expect(f('INT(-3.1)')).toBe(-4);
		expect(f('INT("7.5")')).toBe(7);
		expect(f('INT("abc")')).toBe('#VALUE!');
	});
	test('MOD takes the sign of the divisor', () => {
		expect(f('MOD(10,3)')).toBe(1);
		expect(f('MOD(-3,2)')).toBe(1);
		expect(f('MOD(3,-2)')).toBe(-1);
		expect(f('MOD(5,0)')).toBe('#DIV/0!');
	});
	test('POWER and SQRT errors', () => {
		expect(f('POWER(2,10)')).toBe(1024);
		expect(f('POWER(0,0)')).toBe('#NUM!');
		expect(f('POWER(0,-1)')).toBe('#DIV/0!');
		expect(f('POWER(-8,0.5)')).toBe('#NUM!');
		expect(f('SQRT(16)')).toBe(4);
		expect(f('SQRT(-1)')).toBe('#NUM!');
	});
	test('ROUNDUP and ROUNDDOWN go away from and toward zero', () => {
		expect(f('ROUNDUP(3.2,0)')).toBe(4);
		expect(f('ROUNDUP(-3.2,0)')).toBe(-4);
		expect(f('ROUNDDOWN(3.99,1)')).toBe(3.9);
		expect(f('ROUNDDOWN(-3.99,1)')).toBe(-3.9);
		expect(f('ROUNDUP(1234,-2)')).toBe(1300);
		expect(f('ROUNDDOWN(1299,-2)')).toBe(1200);
		expect(f('ROUNDUP(1.1*3,1)')).toBe(3.3); // 3.3000000000000003 in binary floating point
	});
	test('CEILING and FLOOR use the significance sign rules', () => {
		expect(f('CEILING(2.5,1)')).toBe(3);
		expect(f('CEILING(-2.5,2)')).toBe(-2);
		expect(f('CEILING(-2.5,-2)')).toBe(-4);
		expect(f('CEILING(2.5,-1)')).toBe('#NUM!');
		expect(f('CEILING(4.2,0)')).toBe(0);
		expect(f('FLOOR(2.5,1)')).toBe(2);
		expect(f('FLOOR(-2.5,2)')).toBe(-4);
		expect(f('FLOOR(-2.5,-2)')).toBe(-2);
		expect(f('FLOOR(3,0)')).toBe('#DIV/0!');
		expect(f('CEILING(0.3,0.1)')).toBe(0.3);
	});
	test('SIGN', () => {
		expect([f('SIGN(-4)'), f('SIGN(0)'), f('SIGN(9)')]).toEqual([-1, 0, 1]);
	});
	test('PRODUCT ignores text and blanks in ranges but coerces direct arguments', () => {
		expect(f('PRODUCT(A1:A4)', { A1: '2', A2: 'x', A4: '5' })).toBe(10);
		expect(f('PRODUCT(2,"3",TRUE)')).toBe(6);
		expect(f('PRODUCT(2,"x")')).toBe('#VALUE!');
		expect(f('PRODUCT(A1:A2)', { A1: 'x' })).toBe(0);
	});
	test('MEDIAN', () => {
		expect(f('MEDIAN(A1:A3)', { A1: '3', A2: '1', A3: '2' })).toBe(2);
		expect(f('MEDIAN(1,2,3,4)')).toBe(2.5);
		expect(f('MEDIAN(A1:A2)', { A1: 'x' })).toBe('#NUM!');
	});
	test('MODE returns the first most frequent value, #N/A with no repeats', () => {
		expect(f('MODE(1,2,2,3,3)')).toBe(2);
		expect(f('MODE(A1:A4)', { A1: '5', A2: '7', A3: '7', A4: '5' })).toBe(5);
		expect(f('MODE(1,2,3)')).toBe('#N/A');
	});
	test('STDEV is the sample deviation', () => {
		expect(f('STDEV(2,4,4,4,5,5,7,9)')).toBeCloseTo(2.138089935, 8);
		expect(f('STDEV(5)')).toBe('#DIV/0!');
		expect(f('STDEV(A1:A3)', { A1: '1', A2: '3', A3: 'x' })).toBeCloseTo(1.414213562, 8);
	});
	test('LARGE and SMALL', () => {
		const d = { A1: '10', A2: '30', A3: '20', A4: 'x' };
		expect(f('LARGE(A1:A4,1)', d)).toBe(30);
		expect(f('LARGE(A1:A4,3)', d)).toBe(10);
		expect(f('SMALL(A1:A4,1)', d)).toBe(10);
		expect(f('SMALL(A1:A4,2)', d)).toBe(20);
		expect(f('LARGE(A1:A4,4)', d)).toBe('#NUM!');
		expect(f('SMALL(A1:A4,0)', d)).toBe('#NUM!');
	});
	test('RANK descending by default, ascending with a non-zero order, ties share a rank', () => {
		const d = { A1: '7', A2: '3.5', A3: '3.5', A4: '1' };
		expect(f('RANK(7,A1:A4)', d)).toBe(1);
		expect(f('RANK(3.5,A1:A4)', d)).toBe(2);
		expect(f('RANK(1,A1:A4)', d)).toBe(4);
		expect(f('RANK(7,A1:A4,1)', d)).toBe(4);
		expect(f('RANK(3.5,A1:A4,1)', d)).toBe(2);
		expect(f('RANK(99,A1:A4)', d)).toBe('#N/A');
		expect(f('RANK(7,5)')).toBe('#VALUE!');
	});
});

describe('conditional aggregation', () => {
	const d = { A1: 'x', A2: 'y', A3: 'x', A4: 'x', B1: '10', B2: '20', B3: '30', B4: 'n/a', C1: '1', C2: '1', C3: '2', C4: '2' };
	test('AVERAGEIF averages only matching numbers, #DIV/0! when none match', () => {
		expect(f('AVERAGEIF(A1:A4,"x",B1:B4)', d)).toBe(20); // the text "n/a" is ignored
		expect(f('AVERAGEIF(C1:C4,">1")', d)).toBe(2);
		expect(f('AVERAGEIF(A1:A4,"z",B1:B4)', d)).toBe('#DIV/0!');
		expect(f('AVERAGEIF(A1:A4,"x",B1:B3)', d)).toBe('#VALUE!');
	});
	test('SUMIFS and COUNTIFS need every criterion, over two ranges', () => {
		expect(f('SUMIFS(B1:B4,A1:A4,"x",C1:C4,2)', d)).toBe(30);
		expect(f('SUMIFS(B1:B4,A1:A4,"x")', d)).toBe(40);
		expect(f('COUNTIFS(A1:A4,"x",C1:C4,2)', d)).toBe(2);
		expect(f('COUNTIFS(C1:C4,">=1",C1:C4,"<2")', d)).toBe(2);
		expect(f('COUNTIFS(A1:A4,"x",C1:C3,2)', d)).toBe('#VALUE!');
	});
	test('AVERAGEIFS, MAXIFS and MINIFS', () => {
		expect(f('AVERAGEIFS(B1:B4,A1:A4,"x",C1:C4,1)', d)).toBe(10);
		expect(f('AVERAGEIFS(B1:B4,A1:A4,"q")', d)).toBe('#DIV/0!');
		expect(f('MAXIFS(B1:B4,A1:A4,"x")', d)).toBe(30);
		expect(f('MINIFS(B1:B4,A1:A4,"x")', d)).toBe(10);
		expect(f('MAXIFS(B1:B4,A1:A4,"q")', d)).toBe(0);
	});
	test('numeric criteria over a text cell stay an explicit error, exactly like COUNTIF', () => {
		// Known gap against Excel (which skips text): the shared criterion rule raises #VALUE!.
		expect(f('COUNTIF(B1:B4,">5")', d)).toBe('#VALUE!');
		expect(f('COUNTIFS(B1:B4,">5")', d)).toBe('#VALUE!');
		expect(f('COUNTIFS(B1:B3,">5")', d)).toBe(3);
	});
});

describe('text', () => {
	test('LEFT, RIGHT and MID', () => {
		expect(f('LEFT("Spreadsheet",6)')).toBe('Spread');
		expect(f('LEFT("abc")')).toBe('a');
		expect(f('LEFT("abc",10)')).toBe('abc');
		expect(f('LEFT("abc",-1)')).toBe('#VALUE!');
		expect(f('RIGHT("Spreadsheet",5)')).toBe('sheet');
		expect(f('RIGHT("abc",0)')).toBe('');
		expect(f('RIGHT(12345,2)')).toBe('45');
		expect(f('MID("Spreadsheet",7,5)')).toBe('sheet');
		expect(f('MID("abc",2,99)')).toBe('bc');
		expect(f('MID("abc",5,2)')).toBe('');
		expect(f('MID("abc",0,2)')).toBe('#VALUE!');
	});
	test('LEN counts numbers by their text, blanks as zero', () => {
		expect(f('LEN("hello")')).toBe(5);
		expect(f('LEN(12.5)')).toBe(4);
		expect(f('LEN(A1)')).toBe(0);
	});
	test('TRIM collapses interior spaces; case functions', () => {
		expect(f('TRIM("  a   b  ")')).toBe('a b');
		expect(f('UPPER("abC")')).toBe('ABC');
		expect(f('LOWER("AbC")')).toBe('abc');
		expect(f('PROPER("hello wORLD-foo 2cats it\'s")')).toBe("Hello World-Foo 2Cats It'S");
	});
	test('SUBSTITUTE is case-sensitive, with an optional instance', () => {
		expect(f('SUBSTITUTE("banana","a","o")')).toBe('bonono');
		expect(f('SUBSTITUTE("banana","a","o",2)')).toBe('banona');
		expect(f('SUBSTITUTE("banana","A","o")')).toBe('banana');
		expect(f('SUBSTITUTE("banana","a","o",9)')).toBe('banana');
		expect(f('SUBSTITUTE("banana","","o")')).toBe('banana');
		expect(f('SUBSTITUTE("banana","a","o",0)')).toBe('#VALUE!');
	});
	test('FIND is case-sensitive and SEARCH is not and takes wildcards', () => {
		expect(f('FIND("b","abcb")')).toBe(2);
		expect(f('FIND("b","abcb",3)')).toBe(4);
		expect(f('FIND("B","abcb")')).toBe('#VALUE!');
		expect(f('FIND("z","abc")')).toBe('#VALUE!');
		expect(f('FIND("a","abc",0)')).toBe('#VALUE!');
		expect(f('SEARCH("B","abcb")')).toBe(2);
		expect(f('SEARCH("c?","abcb")')).toBe(3);
		expect(f('SEARCH("a*c","xxabbbc")')).toBe(3);
		expect(f('SEARCH("~?","what?")')).toBe(5);
		expect(f('SEARCH("z","abc")')).toBe('#VALUE!');
	});
	test('TEXT number formats', () => {
		expect(f('TEXT(1234.5,"0")')).toBe('1235');
		expect(f('TEXT(1234.5,"0.00")')).toBe('1234.50');
		expect(f('TEXT(1234.5,"#,##0")')).toBe('1,235');
		expect(f('TEXT(1234567.891,"#,##0.00")')).toBe('1,234,567.89');
		expect(f('TEXT(0.256,"0%")')).toBe('26%');
		expect(f('TEXT(0.2564,"0.0%")')).toBe('25.6%');
		expect(f('TEXT(-1234.5,"#,##0.00")')).toBe('-1,234.50');
		expect(f('TEXT(1.005,"0.00")')).toBe('1.01'); // half rounds away from zero, as in Excel
		expect(f('TEXT(5,"000")')).toBe('005');
		expect(f('TEXT("abc","0")')).toBe('abc');
		expect(f('TEXT(A1,"0.0")')).toBe('0.0');
	});
	test('TEXT date formats use Excel serials', () => {
		const d = { A1: String(serial(2024, 3, 5)) };
		expect(f('TEXT(A1,"yyyy-mm-dd")', d)).toBe('2024-03-05');
		expect(f('TEXT(A1,"dd/mm/yyyy")', d)).toBe('05/03/2024');
		expect(f('TEXT(A1,"mmm d, yyyy")', d)).toBe('Mar 5, 2024');
		expect(f('TEXT(A1,"mmmm d yy")', d)).toBe('March 5 24');
		expect(f('TEXT(A1,"ddd")', d)).toBe('Tue');
		expect(f('TEXT(45292,"yyyy-mm-dd")')).toBe('2024-01-01');
		expect(f('TEXT(59,"yyyy-mm-dd")')).toBe('1900-02-28');
		expect(f('TEXT(60,"yyyy-mm-dd")')).toBe('1900-02-29'); // Excel's phantom day
		expect(f('TEXT(61,"yyyy-mm-dd")')).toBe('1900-03-01');
		expect(f('TEXT(-1,"yyyy-mm-dd")')).toBe('#VALUE!');
	});
	test('TEXT with an unknown format code is #VALUE!', () => {
		expect(f('TEXT(1,"hh:mm")')).toBe('#VALUE!');
		expect(f('TEXT(1,"0.0.0")')).toBe('#VALUE!');
		expect(f('TEXT(1,"abc")')).toBe('#VALUE!');
		expect(f('TEXT(1,"")')).toBe('#VALUE!');
	});
	test('VALUE parses numbers, thousands, percents and ISO dates; rejects the rest', () => {
		expect(f('VALUE("12.5")')).toBe(12.5);
		expect(f('VALUE(" 1,234.5 ")')).toBe(1234.5);
		expect(f('VALUE("$10")')).toBe(10);
		expect(f('VALUE("50%")')).toBe(0.5);
		expect(f('VALUE("-3e2")')).toBe(-300);
		expect(f('VALUE("2024-01-01")')).toBe(45292);
		expect(f('VALUE(7)')).toBe(7);
		expect(f('VALUE("abc")')).toBe('#VALUE!');
		expect(f('VALUE("")')).toBe('#VALUE!');
		expect(f('VALUE("1,2")')).toBe('#VALUE!');
		expect(f('VALUE(TRUE)')).toBe('#VALUE!');
	});
	test('TEXTJOIN with and without skipping empties', () => {
		const d = { A1: 'a', A3: 'c', A4: '2' };
		expect(f('TEXTJOIN(", ",TRUE,A1:A4)', d)).toBe('a, c, 2');
		expect(f('TEXTJOIN("-",FALSE,A1:A4)', d)).toBe('a--c-2');
		expect(f('TEXTJOIN("",TRUE,"x","y")')).toBe('xy');
		expect(f('TEXTJOIN(",","maybe","x")')).toBe('#VALUE!');
	});
	test('REPT and EXACT, with the result length capped like Excel', () => {
		expect(f('REPT("ab",3)')).toBe('ababab');
		expect(f('REPT("ab",0)')).toBe('');
		expect(f('REPT("ab",-1)')).toBe('#VALUE!');
		expect(f('REPT("abcdefghij",4000)')).toBe('#VALUE!');
		expect(f('EXACT("a","a")')).toBe(true);
		expect(f('EXACT("a","A")')).toBe(false);
		expect(f('EXACT(1,"1")')).toBe(true);
	});
});

describe('dates', () => {
	test('serial numbers match Excel across the 1900 leap-year quirk', () => {
		expect(f('DATE(2024,1,1)')).toBe(45292);
		expect(f('DATE(1900,1,1)')).toBe(1);
		expect(f('DATE(1900,2,28)')).toBe(59);
		expect(f('DATE(1900,2,29)')).toBe(60);
		expect(f('DATE(1900,3,1)')).toBe(61);
		expect(f('DATE(2000,2,29)')).toBe(36585);
		expect(f('DATE(2023,13,1)')).toBe(f('DATE(2024,1,1)'));
		expect(f('DATE(2024,3,0)')).toBe(f('DATE(2024,2,29)'));
		expect(f('DATE(99,1,1)')).toBe(f('DATE(1999,1,1)'));
		expect(f('DATE(10000,1,1)')).toBe('#NUM!');
		expect(f('DATE(-1,1,1)')).toBe('#NUM!');
		expect(f('DATE(1899,12,31)')).toBe(serial(3799, 12, 31)); // years below 1900 count from 1900
		expect(serialToDate(60)).toEqual({ y: 1900, m: 2, d: 29 });
		expect(serialToDate(61)).toEqual({ y: 1900, m: 3, d: 1 });
		expect(serialToDate(59)).toEqual({ y: 1900, m: 2, d: 28 });
	});
	test('YEAR, MONTH and DAY around 1900-03-01 and on leap days', () => {
		expect([f('YEAR(60)'), f('MONTH(60)'), f('DAY(60)')]).toEqual([1900, 2, 29]);
		expect([f('YEAR(61)'), f('MONTH(61)'), f('DAY(61)')]).toEqual([1900, 3, 1]);
		expect([f('YEAR(59)'), f('MONTH(59)'), f('DAY(59)')]).toEqual([1900, 2, 28]);
		expect([f('YEAR(1)'), f('MONTH(1)'), f('DAY(1)')]).toEqual([1900, 1, 1]);
		expect([f('YEAR(36585)'), f('MONTH(36585)'), f('DAY(36585)')]).toEqual([2000, 2, 29]);
		expect(f('DAY(DATE(2100,2,28)+1)')).toBe(1); // 2100 is not a leap year
		expect(f('MONTH(DATE(2100,2,28)+1)')).toBe(3);
		expect(f('YEAR(45292.75)')).toBe(2024); // time of day ignored
		expect(f('YEAR("2024-06-30")')).toBe(2024);
		expect(f('YEAR(-1)')).toBe('#NUM!');
		expect(f('YEAR("junk")')).toBe('#VALUE!');
		expect(f('YEAR(3000000)')).toBe('#NUM!');
	});
	test('WEEKDAY return types', () => {
		const d = serial(2024, 1, 7); // a Sunday
		expect(f(`WEEKDAY(${d})`)).toBe(1);
		expect(f(`WEEKDAY(${d},2)`)).toBe(7);
		expect(f(`WEEKDAY(${d},3)`)).toBe(6);
		expect(f(`WEEKDAY(${d + 1},2)`)).toBe(1);
		expect(f(`WEEKDAY(${d + 1},11)`)).toBe(1);
		expect(f(`WEEKDAY(${d + 1},12)`)).toBe(7);
		expect(f(`WEEKDAY(${d},17)`)).toBe(1);
		expect(f(`WEEKDAY(${d},9)`)).toBe('#NUM!');
		expect(f('WEEKDAY(61)')).toBe(5); // 1900-03-01 was a Thursday
	});
	test('EDATE clamps to the end of shorter months', () => {
		expect(f('EDATE(DATE(2024,1,31),1)')).toBe(serial(2024, 2, 29));
		expect(f('EDATE(DATE(2023,1,31),1)')).toBe(serial(2023, 2, 28));
		expect(f('EDATE(DATE(2024,3,15),-3)')).toBe(serial(2023, 12, 15));
		expect(f('EDATE(DATE(2024,3,15),12.9)')).toBe(serial(2025, 3, 15));
		expect(f('EDATE(DATE(2024,3,15),0)')).toBe(serial(2024, 3, 15));
		expect(f('EDATE(61,-100)')).toBe('#NUM!');
	});
	test('EOMONTH, including leap years and year ends', () => {
		expect(f('EOMONTH(DATE(2024,1,31),1)')).toBe(serial(2024, 2, 29));
		expect(f('EOMONTH(DATE(2023,1,15),1)')).toBe(serial(2023, 2, 28));
		expect(f('EOMONTH(DATE(2024,1,15),0)')).toBe(serial(2024, 1, 31));
		expect(f('EOMONTH(DATE(2024,11,15),2)')).toBe(serial(2025, 1, 31));
		expect(f('EOMONTH(DATE(2024,1,15),-1)')).toBe(serial(2023, 12, 31));
		expect(f('EOMONTH(DATE(2100,1,1),1)')).toBe(serial(2100, 2, 28));
		expect(f('EOMONTH(DATE(2000,1,1),1)')).toBe(serial(2000, 2, 29));
	});
	test('DATEDIF units', () => {
		const a = 'DATE(2020,1,31)', b = 'DATE(2024,3,15)';
		expect(f(`DATEDIF(${a},${b},"Y")`)).toBe(4);
		expect(f(`DATEDIF(${a},${b},"M")`)).toBe(49);
		expect(f(`DATEDIF(${a},${b},"D")`)).toBe(serial(2024, 3, 15) - serial(2020, 1, 31));
		expect(f(`DATEDIF(${a},${b},"YM")`)).toBe(1);
		expect(f(`DATEDIF(${a},${b},"MD")`)).toBe(15 + 29 - 31); // days of Feb 2024 borrowed
		expect(f(`DATEDIF(${a},${b},"YD")`)).toBe(serial(2024, 3, 15) - serial(2024, 1, 31));
		expect(f(`DATEDIF(${b},${a},"Y")`)).toBe('#NUM!');
		expect(f(`DATEDIF(${a},${b},"Q")`)).toBe('#NUM!');
	});
	test('TODAY and NOW read the clock once per calculation', () => {
		const clock = new Date(2024, 1, 29, 18, 0, 0); // local time: 2024-02-29 18:00
		expect(f('TODAY()', {}, clock)).toBe(serial(2024, 2, 29));
		expect(f('NOW()', {}, clock)).toBeCloseTo(serial(2024, 2, 29) + 0.75, 10);
		expect(f('NOW()-TODAY()', {}, clock)).toBeCloseTo(0.75, 10);
		const live = f('TODAY()') as number;
		expect(Number.isInteger(live)).toBe(true);
		expect(live).toBeGreaterThan(45000);
	});
});

describe('position', () => {
	test('ROW and COLUMN with no argument refer to the formula cell', () => {
		const get = sheet({ C5: '=ROW()', D7: '=COLUMN()', A1: '=ROW()+COLUMN()', B2: '=ROW(F9)', B3: '=COLUMN(F9)' });
		expect(get('C5')).toBe(5);
		expect(get('D7')).toBe(4);
		expect(get('A1')).toBe(2);
		expect(get('B2')).toBe(9);
		expect(get('B3')).toBe(6);
	});
	test('ROW and COLUMN of a range give its top-left position and never read its cells', () => {
		expect(f('ROW(B3:D9)')).toBe(3);
		expect(f('COLUMN(B3:D9)')).toBe(2);
		expect(sheet({ A1: '=ROW(A1)' })('A1')).toBe(1); // not a cycle
		expect(f('ROW(5)')).toBe('#VALUE!');
	});
	test('ROW follows the formula when evaluated through another cell', () => {
		expect(sheet({ B4: '=ROW()', A1: '=B4*10' })('A1')).toBe(40);
	});
	test('ROWS and COLUMNS', () => {
		expect(f('ROWS(A1:C5)')).toBe(5);
		expect(f('COLUMNS(A1:C5)')).toBe(3);
		expect(f('ROWS(C5:A1)')).toBe(5);
		expect(f('ROWS(A1)')).toBe(1);
		expect(f('COLUMNS("x")')).toBe('#VALUE!');
		expect(f('ROWS(A1:A100000)', {})).toBe('#REF!'); // beyond this sheet, still explicit
	});
});

describe('lookup', () => {
	const table = { A1: '10', B1: 'ten', C1: '100', A2: '20', B2: 'twenty', C2: '200', A3: '30', B3: 'thirty', C3: '300' };
	test('VLOOKUP exact match', () => {
		expect(f('VLOOKUP(20,A1:C3,2,FALSE)', table)).toBe('twenty');
		expect(f('VLOOKUP(30,A1:C3,3,0)', table)).toBe(300);
		expect(f('VLOOKUP(25,A1:C3,2,FALSE)', table)).toBe('#N/A');
		expect(f('VLOOKUP(20,A1:C3,4,FALSE)', table)).toBe('#REF!');
		expect(f('VLOOKUP(20,A1:C3,0,FALSE)', table)).toBe('#VALUE!');
		expect(f('VLOOKUP("20",A1:C3,2,FALSE)', table)).toBe('#N/A'); // text never equals a number
	});
	test('VLOOKUP exact match is case-insensitive and supports wildcards for text', () => {
		const names = { A1: 'Apple', B1: '1', A2: 'Banana', B2: '2' };
		expect(f('VLOOKUP("banana",A1:B2,2,FALSE)', names)).toBe(2);
		expect(f('VLOOKUP("b*",A1:B2,2,FALSE)', names)).toBe(2);
		expect(f('VLOOKUP("?pple",A1:B2,2,FALSE)', names)).toBe(1);
	});
	test('VLOOKUP approximate match takes the largest value not above the target', () => {
		expect(f('VLOOKUP(25,A1:C3,2)', table)).toBe('twenty');
		expect(f('VLOOKUP(25,A1:C3,2,TRUE)', table)).toBe('twenty');
		expect(f('VLOOKUP(30,A1:C3,2)', table)).toBe('thirty');
		expect(f('VLOOKUP(999,A1:C3,2)', table)).toBe('thirty');
		expect(f('VLOOKUP(10,A1:C3,2)', table)).toBe('ten');
		expect(f('VLOOKUP(5,A1:C3,2)', table)).toBe('#N/A');
	});
	test('VLOOKUP grade table, the classic approximate use', () => {
		const grades = { A1: '0', B1: 'F', A2: '60', B2: 'D', A3: '70', B3: 'C', A4: '80', B4: 'B', A5: '90', B5: 'A' };
		expect(f('VLOOKUP(85,A1:B5,2,TRUE)', grades)).toBe('B');
		expect(f('VLOOKUP(60,A1:B5,2,TRUE)', grades)).toBe('D');
		expect(f('VLOOKUP(59.9,A1:B5,2,TRUE)', grades)).toBe('F');
	});
	test('HLOOKUP', () => {
		const d = { A1: '1', B1: '2', C1: '3', A2: 'one', B2: 'two', C2: 'three' };
		expect(f('HLOOKUP(2,A1:C2,2,FALSE)', d)).toBe('two');
		expect(f('HLOOKUP(2.5,A1:C2,2)', d)).toBe('two');
		expect(f('HLOOKUP(9,A1:C2,2,FALSE)', d)).toBe('#N/A');
		expect(f('HLOOKUP(2,A1:C2,3,FALSE)', d)).toBe('#REF!');
	});
	test('MATCH exact, ascending and descending', () => {
		const asc = { A1: '10', A2: '20', A3: '30' }, desc = { A1: '30', A2: '20', A3: '10' };
		expect(f('MATCH(20,A1:A3,0)', asc)).toBe(2);
		expect(f('MATCH(25,A1:A3,0)', asc)).toBe('#N/A');
		expect(f('MATCH(25,A1:A3,1)', asc)).toBe(2);
		expect(f('MATCH(25,A1:A3)', asc)).toBe(2);
		expect(f('MATCH(5,A1:A3,1)', asc)).toBe('#N/A');
		expect(f('MATCH(25,A1:A3,-1)', desc)).toBe(1);
		expect(f('MATCH("b",A1:C1,0)', { A1: 'a', B1: 'B', C1: 'c' })).toBe(2);
		expect(f('MATCH(1,A1:B2,0)', { A1: '1' })).toBe('#N/A'); // not a single row or column
	});
	test('INDEX picks by position, including whole rows and columns', () => {
		expect(f('INDEX(A1:C3,2,2)', table)).toBe('twenty');
		expect(f('INDEX(A1:C3,3,3)', table)).toBe(300);
		expect(f('INDEX(A1:A3,2)', table)).toBe(20);
		expect(f('INDEX(A1:C1,2)', table)).toBe('ten');
		expect(f('SUM(INDEX(A1:C3,0,3))', table)).toBe(600);
		expect(f('SUM(INDEX(A1:C3,2,0))', { ...table, B2: '5' })).toBe(225);
		expect(f('INDEX(A1:C3,4,1)', table)).toBe('#REF!');
		expect(f('INDEX(A1:C3,1,9)', table)).toBe('#REF!');
		expect(f('INDEX(A1:C3,-1,1)', table)).toBe('#VALUE!');
		expect(f('INDEX(A1:C3,2)', table)).toBe('#VALUE!'); // a whole row cannot sit in one cell
		expect(f('INDEX(A1:C3,MATCH(30,A1:A3,0),2)', table)).toBe('thirty');
	});
	test('XLOOKUP exact, not found, and if_not_found', () => {
		expect(f('XLOOKUP(20,A1:A3,B1:B3)', table)).toBe('twenty');
		expect(f('XLOOKUP(25,A1:A3,B1:B3)', table)).toBe('#N/A');
		expect(f('XLOOKUP(25,A1:A3,B1:B3,"none")', table)).toBe('none');
		expect(f('XLOOKUP(20,A1:A3,B1:B3,1/0)', table)).toBe('twenty'); // lazy
		expect(f('XLOOKUP(25,A1:A3,B1:B3,1/0)', table)).toBe('#DIV/0!');
		expect(f('XLOOKUP(20,A1:A3,B1:B2)', table)).toBe('#VALUE!');
		expect(f('XLOOKUP(20,A1:B3,B1:B3)', table)).toBe('#VALUE!');
	});
	test('XLOOKUP match modes and search direction', () => {
		const t = { A1: '30', B1: 'c', A2: '10', B2: 'a', A3: '20', B3: 'b', A4: '20', B4: 'b2' };
		expect(f('XLOOKUP(25,A1:A4,B1:B4,"none",-1)', t)).toBe('b'); // exact or next smaller, unsorted
		expect(f('XLOOKUP(25,A1:A4,B1:B4,"none",1)', t)).toBe('c');
		expect(f('XLOOKUP(5,A1:A4,B1:B4,"none",-1)', t)).toBe('none');
		expect(f('XLOOKUP(20,A1:A4,B1:B4,"none",-1)', t)).toBe('b');
		expect(f('XLOOKUP(20,A1:A4,B1:B4)', t)).toBe('b');
		expect(f('XLOOKUP(20,A1:A4,B1:B4,"none",0,-1)', t)).toBe('b2');
		expect(f('XLOOKUP("B*",B1:B4,A1:A4,"none",2)', t)).toBe(20);
		expect(f('XLOOKUP("b*",B1:B4,A1:A4,"none",2)', t)).toBe(20);
		expect(f('XLOOKUP("b*",B1:B4,A1:A4,"none",0)', t)).toBe('none'); // no wildcards in mode 0
		expect(f('XLOOKUP(20,A1:A4,B1:B4,"none",3)', t)).toBe('#VALUE!');
		expect(f('XLOOKUP(20,A1:A4,B1:B4,"none",0,2)', t)).toBe('#VALUE!');
	});
	test('XLOOKUP across a row and returning a whole row', () => {
		const d = { A1: 'x', B1: 'y', C1: 'z', A2: '1', B2: '2', C2: '3' };
		expect(f('XLOOKUP("y",A1:C1,A2:C2)', d)).toBe(2);
		expect(f('SUM(XLOOKUP("y",A1:A2,A1:C2,0))', { A1: 'x', A2: 'y', B1: '1', B2: '5', C1: '1', C2: '6' })).toBe(11);
	});
});

describe('existing behavior is unchanged', () => {
	test('range functions still receive flat values', () => {
		const d = { A1: '1', A2: '2', B1: '3', B2: '4' };
		expect(f('SUM(A1:B2)', d)).toBe(10);
		expect(f('COUNT(A1:B2)', d)).toBe(4);
		expect(f('MAX(A1:B2)', d)).toBe(4);
		expect(f('SUMIF(A1:B2,">1")', d)).toBe(9);
		expect(f('COUNTIF(A1:B2,">1")', d)).toBe(3);
		expect(f('A1:B2')).toBe('#VALUE!');
	});
	test('unknown functions are still #UNSUPPORTED!', () => {
		expect(f('WEBSERVICE("x")')).toBe('#UNSUPPORTED!');
		expect(f('XLOOKUPX(1)')).toBe('#UNSUPPORTED!');
	});
	test('the operation budget still bounds the new functions', () => {
		const cells: Record<string, string> = {};
		for (let i = 1; i <= 3000; i++) { cells[`A${i}`] = String(i); cells[`B${i}`] = '=MATCH(A' + i + ',$A$1:$A$3000,0)'; }
		const result = calculate(book(cells, 3001));
		expect(Object.values(result.errors)).toContain('#LIMIT!'); // 3000 scans of 3000 cells is over budget
		expect(Object.values(result.errors).every((code) => code === '#LIMIT!')).toBe(true);
		const small: Record<string, string> = {};
		for (let i = 1; i <= 100; i++) { small[`A${i}`] = String(i); small[`B${i}`] = `=MATCH(A${i},$A$1:$A$100,0)`; }
		const ok = calculate(book(small, 101));
		expect(ok.errors).toEqual({});
	});
	test('literal parts of results stay deterministic apart from the clock', () => {
		const data = { A1: '3', A2: '1', A3: '2' };
		expect(f('MEDIAN(A1:A3)', data)).toBe(f('MEDIAN(A1:A3)', data));
	});
});

describe('through the workbook model', () => {
	test('functions work from typed cell input, and unsupported names stay errors', () => {
		const doc = new Y.Doc();
		initialize(doc.getMap('data'));
		const data = doc.getMap('data'), { id, value } = orderedSheets(data)[0], rows = axes(value, 'rows'), cols = axes(value, 'columns');
		const put = (r: number, c: number, text: string) => setCell(data, id, rows[r].id, cols[c].id, text, 'test');
		put(0, 0, '10'); put(1, 0, '20'); put(2, 0, '30');
		put(0, 1, '=VLOOKUP(25,A1:A3,1)');
		put(1, 1, '=IFERROR(1/0,"ok")&TEXT(0.5,"0%")');
		put(2, 1, '=ROW()*100+COLUMN()');
		put(3, 1, '=NOSUCHFUNCTION(1)');
		put(4, 1, '=SUMIFS(A1:A3,A1:A3,">10")');
		put(5, 1, '=SQRT(A1:A2)');
		const calc = calculate(snapshot(data));
		const at = (r: number) => { const key = `${id}/${cellKey(rows[r].id, cols[1].id)}`; return calc.errors[key] ?? calc.values[key]; };
		expect(at(0)).toBe(20);
		expect(at(1)).toBe('ok50%');
		expect(at(2)).toBe(302);
		expect(at(3)).toBe('#UNSUPPORTED!');
		expect(at(4)).toBe(50);
		expect(at(5)).toBe('#VALUE!');
		doc.destroy();
	});
});

describe('helpers', () => {
	test('formatText and wildcardMatch edge cases', () => {
		expect(formatText(0, '0.00')).toBe('0.00');
		expect(formatText(-0.001, '0.00')).toBe('0.00');
		expect(formatText(1e21, '0')).toBeNull(); // too large to print exactly: an explicit error
		expect(wildcardMatch('a*b*c', 'aXXbYYc')).toBe(true);
		expect(wildcardMatch('a*b*c', 'aXXbYY')).toBe(false);
		expect(wildcardMatch('a?c', 'ac')).toBe(false);
		expect(wildcardMatch('*', '')).toBe(true);
		expect(wildcardMatch('~*', '*')).toBe(true);
		expect(wildcardMatch('*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
		expect(literal('x')).toBe('x');
	});
});
