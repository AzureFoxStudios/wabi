/**
 * Pure helpers for the extended function set: argument counts, Excel date serials, TEXT formats,
 * wildcard matching and text-to-number parsing. Nothing here reads the workbook; failures return
 * null and the caller turns them into the explicit Excel error code.
 */

/** [min, max] argument counts for every function added beyond the original fifteen. */
export const ARITY: Record<string, [number, number]> = {
	IFERROR: [2, 2], IFNA: [2, 2], IFS: [2, 128], SWITCH: [3, 128], XOR: [1, 128],
	ISNUMBER: [1, 1], ISTEXT: [1, 1], ISBLANK: [1, 1], ISERROR: [1, 1], ISNA: [1, 1],
	INT: [1, 1], MOD: [2, 2], POWER: [2, 2], SQRT: [1, 1], ROUNDUP: [2, 2], ROUNDDOWN: [2, 2],
	CEILING: [2, 2], FLOOR: [2, 2], SIGN: [1, 1], PRODUCT: [1, 128], MEDIAN: [1, 128], MODE: [1, 128],
	STDEV: [1, 128], LARGE: [2, 2], SMALL: [2, 2], RANK: [2, 3],
	AVERAGEIF: [2, 3], SUMIFS: [3, 127], COUNTIFS: [2, 128], AVERAGEIFS: [3, 127], MAXIFS: [3, 127], MINIFS: [3, 127],
	LEFT: [1, 2], RIGHT: [1, 2], MID: [3, 3], LEN: [1, 1], TRIM: [1, 1], UPPER: [1, 1], LOWER: [1, 1], PROPER: [1, 1],
	SUBSTITUTE: [3, 4], FIND: [2, 3], SEARCH: [2, 3], TEXT: [2, 2], VALUE: [1, 1], TEXTJOIN: [3, 128], REPT: [2, 2], EXACT: [2, 2],
	TODAY: [0, 0], NOW: [0, 0], DATE: [3, 3], YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], WEEKDAY: [1, 2],
	EDATE: [2, 2], EOMONTH: [2, 2], DATEDIF: [3, 3],
	ROW: [0, 1], COLUMN: [0, 1], ROWS: [0, 1], COLUMNS: [0, 1],
	VLOOKUP: [3, 4], HLOOKUP: [3, 4], XLOOKUP: [3, 6], INDEX: [2, 3], MATCH: [2, 3]
};

/** Excel's longest cell text; longer results are #VALUE! rather than silently huge strings. */
export const MAX_TEXT = 32767;

/*
 * Dates are Excel serial numbers in the 1900 system. Excel wrongly treats 1900 as a leap year, so
 * its serial 60 is the non-existent 1900-02-29. Counting days from 1899-12-30 reproduces Excel
 * exactly for every date from 1900-03-01 (serial 61) onwards, which is also what model.ts
 * formatValue uses. Dates from 1900-01-01 to 1900-02-28 sit one day later on that count than in
 * Excel, so they are shifted down by one here (1900-01-01 is serial 1, 1900-02-28 is 59), serial
 * 60 round-trips to the fake 1900-02-29, and serial 0 is Excel's "1900-01-00".
 */
const EPOCH = Date.UTC(1899, 11, 30);
export const MAX_SERIAL = 2958465; // 9999-12-31

const utcDays = (y: number, m: number, d: number) => {
	// setUTCFullYear, because Date.UTC maps the years 0-99 onto 1900-1999.
	const t = new Date(0);
	t.setUTCFullYear(y, m - 1, d);
	return Math.round((t.getTime() - EPOCH) / 86400000);
};

export function daysInMonth(y: number, m: number) {
	const t = new Date(0);
	t.setUTCFullYear(y, m, 0);
	return t.getUTCDate();
}

/** Excel DATE: month and day may overflow; years 0-1899 count from 1900. Null is #NUM!. */
export function dateToSerial(year: number, month: number, day: number): number | null {
	let y = Math.trunc(year);
	if (y >= 0 && y < 1900) y += 1900;
	if (y < 0 || y > 9999) return null;
	const m = Math.trunc(month), d = Math.trunc(day);
	if (y === 1900 && m === 2 && d === 29) return 60;
	const days = utcDays(y, m, d);
	const serial = days < 61 ? days - 1 : days;
	return serial < 0 || serial > MAX_SERIAL ? null : serial;
}

export interface Ymd { y: number; m: number; d: number }

export function serialToDate(serial: number): Ymd | null {
	const s = Math.floor(serial);
	if (!(s >= 0) || s > MAX_SERIAL) return null;
	if (s === 0) return { y: 1900, m: 1, d: 0 };
	if (s === 60) return { y: 1900, m: 2, d: 29 };
	const t = new Date(EPOCH + (s < 60 ? s + 1 : s) * 86400000);
	return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday. Serial 1 is a "Sunday" in Excel, so the quirk falls out naturally. */
export const weekdayIndex = (serial: number) => (((Math.floor(serial) - 1) % 7) + 7) % 7;

/** WEEKDAY return types 1, 2, 3 and 11-17. Null for an unknown type. */
export function weekday(serial: number, type: number): number | null {
	const i = weekdayIndex(serial);
	if (type === 1) return i + 1;
	if (type === 2) return ((i + 6) % 7) + 1;
	if (type === 3) return (i + 6) % 7;
	if (type >= 11 && type <= 17) return ((i - (type === 17 ? 0 : type - 10) + 7) % 7) + 1;
	return null;
}

export function shiftMonths(serial: number, months: number, endOfMonth: boolean): number | null {
	const from = serialToDate(serial);
	if (!from) return null;
	if (!endOfMonth && months === 0) return Math.floor(serial);
	const total = from.y * 12 + (from.m - 1) + months;
	const y = Math.floor(total / 12), m = total - y * 12 + 1;
	if (y < 1900 || y > 9999) return null;
	const last = daysInMonth(y, m);
	return dateToSerial(y, m, endOfMonth ? last : Math.min(from.d, last));
}

/** DATEDIF units Y, M, D, MD, YM, YD for start <= end serials. Null is #NUM!. */
export function dateDif(start: number, end: number, unit: string): number | null {
	const a = serialToDate(start), b = serialToDate(end);
	if (!a || !b || start > end) return null;
	switch (unit.toUpperCase()) {
		case 'Y': return b.y - a.y - (b.m < a.m || (b.m === a.m && b.d < a.d) ? 1 : 0);
		case 'M': return (b.y - a.y) * 12 + b.m - a.m - (b.d < a.d ? 1 : 0);
		case 'D': return Math.floor(end) - Math.floor(start);
		case 'MD': {
			if (b.d >= a.d) return b.d - a.d;
			const pm = b.m === 1 ? 12 : b.m - 1, py = b.m === 1 ? b.y - 1 : b.y;
			return b.d + daysInMonth(py, pm) - a.d;
		}
		case 'YM': return (((b.m - a.m - (b.d < a.d ? 1 : 0)) % 12) + 12) % 12;
		case 'YD': {
			let anchor = dateToSerial(b.y, a.m, a.d);
			if (anchor !== null && anchor > Math.floor(end)) anchor = dateToSerial(b.y - 1, a.m, a.d);
			return anchor === null ? null : Math.floor(end) - anchor;
		}
		default: return null;
	}
}

/** Strict yyyy-mm-dd, the one date text accepted by VALUE and the date functions. */
export function parseIsoDate(text: string): number | null {
	const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
	if (!m) return null;
	const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
	if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
	return dateToSerial(y, mo, d);
}

/** Text to number for VALUE: plain numbers, 1,234.5, $ amounts, percents and ISO dates. */
export function parseNumberText(text: string): number | null {
	const t = text.trim();
	if (t === '') return null;
	if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
	const m = /^([+-]?)\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)$/.exec(t);
	if (m) {
		const n = Number(m[2].replaceAll(',', '') + (m[3] ?? ''));
		return (m[1] === '-' ? -1 : 1) * (m[4] ? n / 100 : n);
	}
	return parseIsoDate(t);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function roundHalfAway(value: number, digits: number) {
	const abs = Math.abs(value), text = String(abs);
	if (text.includes('e')) return Number(abs.toFixed(digits));
	return Number(Math.round(Number(`${text}e${digits}`)) + `e-${digits}`);
}

function formatNumber(n: number, format: string): string | null {
	const m = /^(#,##0|0+)(?:\.(0+))?(%?)$/.exec(format);
	if (!m) return null;
	if (!(Math.abs(n) < 1e21)) return null;
	const decimals = m[2]?.length ?? 0;
	const rounded = roundHalfAway(m[3] ? n * 100 : n, decimals);
	let [whole, fraction = ''] = rounded.toFixed(decimals).split('.');
	whole = whole.padStart(m[1] === '#,##0' ? 1 : m[1].length, '0');
	if (m[1] === '#,##0') whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return (n < 0 && rounded !== 0 ? '-' : '') + whole + (decimals ? `.${fraction}` : '') + m[3];
}

function formatDate(serial: number, format: string): string | null {
	const date = serialToDate(serial);
	if (!date || serial < 0) return null;
	const pattern = /yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|[-/., ]/y;
	const lower = format.toLowerCase();
	let at = 0, out = '', hasCode = false;
	while (at < lower.length) {
		pattern.lastIndex = at;
		const m = pattern.exec(lower);
		if (!m) return null;
		const code = m[0];
		at += code.length;
		if (/[a-z]/.test(code)) hasCode = true;
		const wd = DAYS[weekdayIndex(serial)];
		switch (code) {
			case 'yyyy': out += String(date.y).padStart(4, '0'); break;
			case 'yy': out += String(date.y % 100).padStart(2, '0'); break;
			case 'mmmm': out += MONTHS[date.m - 1]; break;
			case 'mmm': out += MONTHS[date.m - 1].slice(0, 3); break;
			case 'mm': out += String(date.m).padStart(2, '0'); break;
			case 'm': out += date.m; break;
			case 'dddd': out += wd; break;
			case 'ddd': out += wd.slice(0, 3); break;
			case 'dd': out += String(date.d).padStart(2, '0'); break;
			case 'd': out += date.d; break;
			default: out += code;
		}
	}
	return hasCode ? out : null;
}

/**
 * TEXT for a number: 0, 0.00, #,##0, #,##0.00, 0%, 0.0% style codes (any count of zeros), General,
 * and date codes built from yyyy yy mmmm mmm mm m dddd ddd dd d with - / , . and space.
 * Anything else (times, sections, literals, colors) is null, which the caller reports as #VALUE!.
 */
export function formatText(n: number, format: string): string | null {
	if (format.toLowerCase() === 'general') return String(n);
	return formatNumber(n, format) ?? formatDate(n, format);
}

interface Piece { star: boolean; any: boolean; ch: string }

function pieces(pattern: string): Piece[] {
	const out: Piece[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '~' && i + 1 < pattern.length) out.push({ star: false, any: false, ch: pattern[++i] });
		else if (c === '*') out.push({ star: true, any: false, ch: '' });
		else out.push({ star: false, any: c === '?', ch: c });
	}
	return out;
}

export const hasWildcard = (pattern: string) => /[*?~]/.test(pattern);

/** Iterative * ? ~ matcher (polynomial, no regex backtracking). Callers lower-case both sides. */
export function wildcardMatch(pattern: string, text: string, prefixOnly = false): boolean {
	const p = pieces(pattern);
	if (prefixOnly) p.push({ star: true, any: false, ch: '' });
	let pi = 0, ti = 0, starAt = -1, mark = 0;
	while (ti < text.length) {
		const piece = p[pi];
		if (piece && !piece.star && (piece.any || piece.ch === text[ti])) { pi++; ti++; }
		else if (piece?.star) { starAt = pi++; mark = ti; }
		else if (starAt >= 0) { pi = starAt + 1; ti = ++mark; }
		else return false;
	}
	while (p[pi]?.star) pi++;
	return pi === p.length;
}

/** First 0-based index >= from where the wildcard pattern matches the start of the rest of text, or -1. */
export function wildcardFind(pattern: string, text: string, from: number, tick: () => void): number {
	for (let i = from; i <= text.length; i++) {
		tick();
		if (wildcardMatch(pattern, text.slice(i), true)) return i;
	}
	return -1;
}
