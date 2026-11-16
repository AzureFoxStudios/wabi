import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import es from './locales/es.json';
import th from './locales/th.json';
import { SCRIPT_FONT_FILES, listLanguagePacks } from './packs';

// Coverage is read from the font files themselves (the WOFF1 builds fontsource ships beside the
// WOFF2 the packs load), not from hand-written ranges. Each file's cmap table lists the code
// points it draws; a catalog character with no glyph in the faces its language loads fails.
const NODE_MODULES = join(import.meta.dir, '../../../node_modules');
const LATIN_BASE = '@fontsource/zen-kaku-gothic-new/latin-400.css'; // ships with the app (fonts.css)
const LATIN_SERIF = '@fontsource/shippori-mincho/latin-400.css'; // serif titles, also bundled in fonts.css

/** Map a fontsource stylesheet path to its WOFF1 file: <pkg>/files/<pkg>-<subset>-<weight>-normal.woff */
function woffFor(cssPath: string): string {
	const pkgDir = join(NODE_MODULES, dirname(cssPath));
	const stem = basename(cssPath, '.css');
	return join(pkgDir, 'files', `${basename(pkgDir)}-${stem}-normal.woff`);
}

/** Code points with a glyph in a WOFF1 file (cmap formats 4 and 12). */
function glyphCodePoints(file: string): Set<number> {
	const b = readFileSync(file);
	if (b.toString('latin1', 0, 4) !== 'wOFF') throw new Error(`not a WOFF1 file: ${file}`);
	let cmap: Buffer | null = null;
	const tables = b.readUInt16BE(12);
	for (let i = 0; i < tables; i++) {
		const e = 44 + i * 20;
		if (b.toString('latin1', e, e + 4) !== 'cmap') continue;
		const off = b.readUInt32BE(e + 4), comp = b.readUInt32BE(e + 8), orig = b.readUInt32BE(e + 12);
		const raw = b.subarray(off, off + comp);
		cmap = comp < orig ? inflateSync(raw) : raw;
	}
	if (!cmap) throw new Error(`no cmap table in ${file}`);

	const cps = new Set<number>();
	const subtables = cmap.readUInt16BE(2);
	for (let s = 0; s < subtables; s++) {
		const sub = cmap.readUInt32BE(4 + s * 8 + 4);
		const format = cmap.readUInt16BE(sub);
		if (format === 4) {
			const segX2 = cmap.readUInt16BE(sub + 6);
			const endP = sub + 14, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
			for (let k = 0; k < segX2 / 2; k++) {
				const end = cmap.readUInt16BE(endP + 2 * k), start = cmap.readUInt16BE(startP + 2 * k);
				const delta = cmap.readInt16BE(deltaP + 2 * k), ro = cmap.readUInt16BE(rangeP + 2 * k);
				if (start === 0xffff) continue;
				for (let c = start; c <= end; c++) {
					let g: number;
					if (ro === 0) g = (c + delta) & 0xffff;
					else {
						g = cmap.readUInt16BE(rangeP + 2 * k + ro + 2 * (c - start));
						if (g) g = (g + delta) & 0xffff;
					}
					if (g) cps.add(c);
				}
			}
		} else if (format === 12) {
			const groups = cmap.readUInt32BE(sub + 12);
			for (let g = 0; g < groups; g++) {
				const p = sub + 16 + g * 12;
				const a = cmap.readUInt32BE(p), z = cmap.readUInt32BE(p + 4);
				for (let c = a; c <= z; c++) cps.add(c);
			}
		}
	}
	return cps;
}

function flatten(obj: unknown, out: string[] = []): string[] {
	if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
		for (const v of Object.values(obj)) flatten(v, out);
	} else if (typeof obj === 'string') {
		out.push(obj);
	}
	return out;
}

/** Non-ASCII characters in the catalog that none of the given faces draws. */
function undrawn(catalog: unknown, faces: Set<number>[]): string[] {
	const missing = new Set<string>();
	for (const ch of flatten(catalog).join('')) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) continue;
		// Symbols, arrows and emoji have no text-face glyph in any language; they render through the system font, as they do in English.
		if (/[\p{S}\p{Extended_Pictographic}]/u.test(ch)) continue;
		if (!faces.some((face) => face.has(cp))) missing.add(`${ch} U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
	}
	return [...missing];
}

const typography = readFileSync(join(import.meta.dir, '../../styles/typography.css'), 'utf8');

describe('language catalogs have glyphs in the faces they load', () => {
	test('Spanish is drawn by the bundled Latin face', () => {
		const sans = glyphCodePoints(woffFor(LATIN_BASE));
		const serif = glyphCodePoints(woffFor(LATIN_SERIF));
		expect(undrawn(es, [sans, serif])).toEqual([]);
	});

	test('Thai is drawn by the Latin face plus the Noto Thai faces the pack loads', () => {
		const thaiFiles = (SCRIPT_FONT_FILES.thai ?? []).filter((f) => f.endsWith('.css'));
		expect(thaiFiles.length).toBeGreaterThan(0);
		const thaiFaces = thaiFiles.map((f) => glyphCodePoints(woffFor(f)));
		expect(undrawn(th, [glyphCodePoints(woffFor(LATIN_BASE)), ...thaiFaces])).toEqual([]);
	});

	test('every font file a script loads exists in node_modules', () => {
		for (const files of Object.values(SCRIPT_FONT_FILES)) {
			for (const file of files ?? []) {
				expect(existsSync(join(NODE_MODULES, file)), `missing ${file}`).toBe(true);
				expect(existsSync(woffFor(file)), `missing WOFF1 for ${file}`).toBe(true);
			}
		}
	});

	test('every registered non-Latin pack has font files and a data-script rule', () => {
		for (const pack of listLanguagePacks()) {
			if (pack.script === 'latin') continue;
			expect(SCRIPT_FONT_FILES[pack.script], `no fonts for ${pack.code}`).toBeDefined();
			expect(typography.includes(`:root[data-script='${pack.script}']`), `no typography rule for ${pack.script}`).toBe(true);
		}
	});
});
