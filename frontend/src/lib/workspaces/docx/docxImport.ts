/**
 * A Word (.docx) file to Markdown, for the Documents editor.
 *
 * Reads the structure Word actually writes: heading and quote styles (by name, so localized and
 * inherited styles work), list numbering from numbering.xml, hyperlinks (as elements and as fields),
 * bold, italic and strikethrough, tracked insertions (deletions are dropped), and tables including
 * merged cells. Pictures, headers, footers, footnotes and comments are not imported and are named in
 * the warnings, so nothing is lost silently.
 *
 * Safety: the archive passes the same checks as the spreadsheet importer (size, entry names, ratios),
 * only XML parts are read, and the XML goes through ./xml, which has no entities or DOCTYPE support.
 * No script, macro or embedded object is ever run or opened.
 */
import JSZip from 'jszip';
import { zipLimits } from '../zipLimits';
import { escapeCellPipes } from '../../editor/tableCell';
import { elements, firstElement, parseXml, XmlError, type XmlElement } from './xml';

export interface DocxImport { markdown: string; warnings: string[]; /** The text of a leading Title paragraph, which becomes the document's name. */ title?: string }

const MAX_FILE = 12 * 1024 * 1024;

interface StyleInfo { name: string; basedOn?: string; numId?: string; ilvl?: number; bold?: boolean; italic?: boolean }

interface Context {
	rels: Map<string, string>;
	styles: Map<string, StyleInfo>;
	/** numId -> abstractNumId */
	nums: Map<string, string>;
	/** abstractNumId -> level -> 'bullet' | 'ordered' */
	formats: Map<string, Map<number, 'bullet' | 'ordered'>>;
	starts: Map<string, number>;
	/** `numId:level` -> where this list restarts (a list that starts at 3). */
	overrides: Map<string, number>;
	counters: Map<string, number[]>;
	pictures: number;
	title?: string;
}

const on = (element: XmlElement | undefined) => !!element && !['0', 'false', 'off'].includes(element.attrs['w:val'] ?? '');

function readXml(text: string | null, what: string): XmlElement | null {
	if (text === null) return null;
	try { return parseXml(text); } catch (error) {
		if (error instanceof XmlError) throw new Error(`This Word file could not be read (${what}): ${error.message}`);
		throw error;
	}
}

function parseStyles(root: XmlElement | null): Map<string, StyleInfo> {
	const styles = new Map<string, StyleInfo>();
	if (!root) return styles;
	for (const style of elements(root, 'w:style')) {
		const id = style.attrs['w:styleId'];
		if (!id) continue;
		const pPr = firstElement(style, 'w:pPr');
		const numPr = firstElement(pPr, 'w:numPr');
		const rPr = firstElement(style, 'w:rPr');
		styles.set(id, {
			name: (firstElement(style, 'w:name')?.attrs['w:val'] ?? id).toLowerCase(),
			basedOn: firstElement(style, 'w:basedOn')?.attrs['w:val'],
			numId: firstElement(numPr, 'w:numId')?.attrs['w:val'],
			ilvl: numPr && firstElement(numPr, 'w:ilvl') ? Number(firstElement(numPr, 'w:ilvl')!.attrs['w:val']) : undefined,
			bold: rPr ? on(firstElement(rPr, 'w:b')) : undefined,
			italic: rPr ? on(firstElement(rPr, 'w:i')) : undefined
		});
	}
	return styles;
}

function parseNumbering(root: XmlElement | null, ctx: Context) {
	if (!root) return;
	for (const abstract of elements(root, 'w:abstractNum')) {
		const id = abstract.attrs['w:abstractNumId'];
		const levels = new Map<number, 'bullet' | 'ordered'>();
		for (const lvl of elements(abstract, 'w:lvl')) {
			const format = firstElement(lvl, 'w:numFmt')?.attrs['w:val'] ?? 'decimal';
			levels.set(Number(lvl.attrs['w:ilvl'] ?? 0), format === 'bullet' || format === 'none' ? 'bullet' : 'ordered');
			const start = firstElement(lvl, 'w:start')?.attrs['w:val'];
			if (start && Number.isFinite(Number(start))) ctx.starts.set(`${id}:${lvl.attrs['w:ilvl'] ?? 0}`, Number(start));
		}
		ctx.formats.set(id, levels);
	}
	for (const num of elements(root, 'w:num')) {
		const abstract = firstElement(num, 'w:abstractNumId')?.attrs['w:val'];
		if (abstract !== undefined) ctx.nums.set(num.attrs['w:numId'], abstract);
		for (const override of elements(num, 'w:lvlOverride')) {
			const start = firstElement(override, 'w:startOverride')?.attrs['w:val'];
			if (start && Number.isFinite(Number(start))) ctx.overrides.set(`${num.attrs['w:numId']}:${override.attrs['w:ilvl'] ?? 0}`, Number(start));
		}
	}
}

/** Walks the style chain (Heading 1 based on Normal, a custom style based on Heading 1, ...). */
function chain(ctx: Context, styleId: string | undefined): StyleInfo[] {
	const out: StyleInfo[] = [];
	const seen = new Set<string>();
	let id = styleId;
	while (id && !seen.has(id) && out.length < 8) {
		seen.add(id);
		const info = ctx.styles.get(id);
		if (!info) break;
		out.push(info);
		id = info.basedOn;
	}
	return out;
}

function headingLevel(ctx: Context, styleId: string | undefined): number {
	for (const info of chain(ctx, styleId)) {
		const match = /^heading (\d)$/.exec(info.name);
		if (match) return Math.min(6, Number(match[1]));
		if (info.name === 'title') return 1;
	}
	if (styleId) { const m = /^heading(\d)$/i.exec(styleId); if (m) return Math.min(6, Number(m[1])); if (styleId.toLowerCase() === 'title') return 1; }
	return 0;
}

const styleKind = (ctx: Context, styleId: string | undefined): 'quote' | 'code' | 'normal' => {
	for (const info of chain(ctx, styleId)) {
		if (/^(intense )?quote$|block text/.test(info.name)) return 'quote';
		if (/source code|preformatted|^code$|html code/.test(info.name)) return 'code';
	}
	return 'normal';
};

interface Segment { text: string; b: boolean; i: boolean; s: boolean; code?: boolean; link?: string; newline?: boolean }

interface ParagraphResult { segments: Segment[]; plain: string }

function runFormat(ctx: Context, run: XmlElement, paragraphStyle: string | undefined) {
	const rPr = firstElement(run, 'w:rPr');
	let b = false, i = false, s = false, code = false;
	if (rPr) {
		const fonts = firstElement(rPr, 'w:rFonts');
		const family = (fonts?.attrs['w:ascii'] ?? fonts?.attrs['w:hAnsi'] ?? '').toLowerCase();
		code = /consolas|courier|menlo|monaco|lucida console|source code|dejavu sans mono|monospace/.test(family);
		b = on(firstElement(rPr, 'w:b'));
		i = on(firstElement(rPr, 'w:i'));
		s = on(firstElement(rPr, 'w:strike')) || on(firstElement(rPr, 'w:dstrike'));
		const rStyle = firstElement(rPr, 'w:rStyle')?.attrs['w:val'];
		for (const info of chain(ctx, rStyle)) {
			if (/^strong$/.test(info.name)) b = true;
			if (/^emphasis$/.test(info.name)) i = true;
			if (info.bold) b = true;
			if (info.italic) i = true;
		}
	}
	void paragraphStyle;
	return { b, i, s, code };
}

function safeLink(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const trimmed = url.trim();
	return /^(https?:|mailto:|tel:)/i.test(trimmed) ? trimmed : undefined;
}

function readParagraph(ctx: Context, p: XmlElement, styleId: string | undefined): ParagraphResult {
	const segments: Segment[] = [];
	const fields: { instr: string; inResult: boolean; url?: string }[] = [];
	const add = (text: string, format: { b: boolean; i: boolean; s: boolean; code?: boolean }, link?: string, newline = false) => {
		if (text === '' && !newline) return;
		segments.push({ text, ...format, link, newline });
	};
	const visit = (node: XmlElement, link: string | undefined) => {
		for (const child of elements(node)) {
			switch (child.name) {
				case 'w:r': readRun(child, link); break;
				case 'w:hyperlink': {
					const target = child.attrs['r:id'] ? ctx.rels.get(child.attrs['r:id']) : undefined;
					visit(child, safeLink(target) ?? link);
					break;
				}
				case 'w:fldSimple': {
					const url = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(child.attrs['w:instr'] ?? '')?.[1];
					visit(child, safeLink(url) ?? link);
					break;
				}
				case 'w:ins': case 'w:smartTag': case 'w:sdt': case 'w:sdtContent': case 'w:moveTo': case 'w:customXml': visit(child, link); break;
				default: break; // w:del and w:moveFrom (deleted text), bookmarks, proofing marks
			}
		}
	};
	const readRun = (run: XmlElement, link: string | undefined) => {
		const format = runFormat(ctx, run, styleId);
		const top = fields[fields.length - 1];
		for (const part of elements(run)) {
			switch (part.name) {
				case 'w:fldChar': {
					const kind = part.attrs['w:fldCharType'];
					if (kind === 'begin') fields.push({ instr: '', inResult: false });
					else if (kind === 'separate' && top) {
						top.inResult = true;
						top.url = safeLink(/^\s*HYPERLINK\s+"([^"]+)"/i.exec(top.instr)?.[1]);
					} else if (kind === 'end') fields.pop();
					break;
				}
				case 'w:instrText': if (top && !top.inResult) top.instr += part.children.filter((c): c is string => typeof c === 'string').join(''); break;
				case 'w:t': case 'w:delText': {
					if (part.name === 'w:delText') break;
					if (top && !top.inResult) break; // the field's instruction, not its result
					const text = part.children.filter((c): c is string => typeof c === 'string').join('');
					add(text, format, link ?? (top?.inResult ? top.url : undefined));
					break;
				}
				case 'w:tab': add(' ', format, link); break;
				case 'w:noBreakHyphen': add('-', format, link); break;
				case 'w:br': if (part.attrs['w:type'] !== 'page' && part.attrs['w:type'] !== 'column') add('', format, link, true); break;
				case 'w:cr': add('', format, link, true); break;
				case 'w:drawing': case 'w:pict': case 'w:object': ctx.pictures++; break;
				default: break;
			}
		}
	};
	visit(p, undefined);
	return { segments, plain: segments.map((s) => (s.newline ? '\n' : s.text)).join('') };
}

const escapeInline = (text: string) => text.replace(/([\\`*_[\]<])/g, '\\$1');

function escapeLineStart(text: string): string {
	if (/^#{1,6}(\s|$)/.test(text)) return '\\' + text;
	if (/^([-+]\s|>|-{3,}\s*$|={3,}\s*$)/.test(text)) return '\\' + text;
	return text.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3');
}

function renderSegments(segments: Segment[], options: { noEmphasis?: boolean; noBold?: boolean } = {}): string {
	// Merge neighbours that look the same, so "**a****b**" never appears.
	const merged: Segment[] = [];
	for (const segment of segments) {
		const last = merged[merged.length - 1];
		if (last && !segment.newline && !last.newline && last.b === segment.b && last.i === segment.i && last.s === segment.s && !!last.code === !!segment.code && last.link === segment.link) last.text += segment.text;
		else merged.push({ ...segment });
	}
	let out = '';
	for (const segment of merged) {
		if (segment.newline) { out += '  \n'; continue; }
		const body = segment.text;
		if (body.trim() === '') { out += body; continue; }
		const lead = /^\s*/.exec(body)![0];
		const trail = /\s*$/.exec(body)![0];
		const inner = body.slice(lead.length, body.length - trail.length);
		let core: string;
		if (segment.code) {
			// Inline code is taken literally, with a longer fence when it holds a backtick.
			const fence = inner.includes('`') ? '``' : '`';
			core = `${fence}${inner.startsWith('`') || inner.endsWith('`') ? ` ${inner} ` : inner}${fence}`;
		} else core = escapeInline(inner);
		if (!options.noEmphasis && !segment.code) {
			if (segment.s) core = `~~${core}~~`;
			if (segment.b && segment.i && !options.noBold) core = `***${core}***`;
			else if (segment.b && !options.noBold) core = `**${core}**`;
			else if (segment.b && segment.i) core = `*${core}*`;
			else if (segment.i) core = `*${core}*`;
		}
		if (segment.link) core = `[${core}](${segment.link.replace(/\)/g, '%29').replace(/\s/g, '%20')})`;
		out += lead + core + trail;
	}
	return out;
}

interface Block { kind: 'heading' | 'paragraph' | 'quote' | 'code' | 'list' | 'table'; lines: string[]; group?: string }

function cellText(ctx: Context, cell: XmlElement, header = false): string {
	const parts: string[] = [];
	for (const child of elements(cell)) {
		if (child.name === 'w:p') {
			const result = readParagraph(ctx, child, firstElement(firstElement(child, 'w:pPr'), 'w:pStyle')?.attrs['w:val']);
			const text = renderSegments(result.segments.map((s) => (s.newline ? { ...s, newline: false, text: ' ' } : s)), { noBold: header });
			if (text.trim()) parts.push(text.trim());
		} else if (child.name === 'w:tbl') parts.push(...elements(child, 'w:tr').flatMap((row) => elements(row, 'w:tc').map((c) => cellText(ctx, c))).filter(Boolean));
	}
	return escapeCellPipes(parts.join(' '));
}

function readTable(ctx: Context, table: XmlElement): Block | null {
	const rows: string[][] = [];
	for (const row of elements(table, 'w:tr')) {
		const cells: string[] = [];
		for (const cell of elements(row, 'w:tc')) {
			const tcPr = firstElement(cell, 'w:tcPr');
			const span = Math.min(32, Math.max(1, Number(firstElement(tcPr, 'w:gridSpan')?.attrs['w:val'] ?? 1) || 1));
			const merged = firstElement(tcPr, 'w:vMerge');
			const continued = !!merged && merged.attrs['w:val'] !== 'restart';
			cells.push(continued ? '' : cellText(ctx, cell, rows.length === 0));
			for (let i = 1; i < span; i++) cells.push('');
		}
		if (cells.length) rows.push(cells);
	}
	if (!rows.length) return null;
	const width = Math.min(64, Math.max(...rows.map((r) => r.length)));
	const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
	return { kind: 'table', lines: [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1, 5000).map(line)] };
}

function listInfo(ctx: Context, styleId: string | undefined, pPr: XmlElement | undefined): { numId: string; level: number } | null {
	const direct = firstElement(pPr, 'w:numPr');
	let numId = firstElement(direct, 'w:numId')?.attrs['w:val'];
	let level = direct && firstElement(direct, 'w:ilvl') ? Number(firstElement(direct, 'w:ilvl')!.attrs['w:val']) : undefined;
	if (numId === undefined || level === undefined) {
		for (const info of chain(ctx, styleId)) {
			if (numId === undefined && info.numId !== undefined) numId = info.numId;
			if (level === undefined && info.ilvl !== undefined) level = info.ilvl;
		}
	}
	if (numId === undefined || numId === '0') return null;
	return { numId, level: Math.max(0, Math.min(8, Number.isFinite(level) ? (level as number) : 0)) };
}

function convertBody(ctx: Context, body: XmlElement): string {
	const blocks: Block[] = [];
	const widths = new Map<string, number[]>();
	const visit = (parent: XmlElement) => {
		for (const child of elements(parent)) {
			if (child.name === 'w:sdt') { const content = firstElement(child, 'w:sdtContent'); if (content) visit(content); continue; }
			if (child.name === 'w:tbl') { const table = readTable(ctx, child); if (table) blocks.push(table); continue; }
			if (child.name !== 'w:p') continue;
			const pPr = firstElement(child, 'w:pPr');
			const styleId = firstElement(pPr, 'w:pStyle')?.attrs['w:val'];
			const result = readParagraph(ctx, child, styleId);
			if (result.plain.trim() === '') continue;
			// A leading Title paragraph names the document; it is not repeated as a heading in the text.
			if (ctx.title === undefined && blocks.length === 0 && chain(ctx, styleId).some((info) => info.name === 'title')) { ctx.title = result.plain.replace(/\s+/g, ' ').trim().slice(0, 200); continue; }
			const level = headingLevel(ctx, styleId);
			if (level) {
				blocks.push({ kind: 'heading', lines: [`${'#'.repeat(level)} ${renderSegments(result.segments, { noEmphasis: true }).replace(/\s*\n\s*/g, ' ').trim()}`] });
				continue;
			}
			const kind = styleKind(ctx, styleId);
			if (kind === 'code') { blocks.push({ kind: 'code', lines: result.plain.split('\n') }); continue; }
			const list = listInfo(ctx, styleId, pPr);
			const text = renderSegments(result.segments).trim();
			if (list) {
				const abstract = ctx.nums.get(list.numId);
				const format = (abstract !== undefined ? ctx.formats.get(abstract)?.get(list.level) : undefined) ?? 'bullet';
				const counters = ctx.counters.get(list.numId) ?? [];
				let marker = '-';
				if (format === 'ordered') {
					const start = ctx.overrides.get(`${list.numId}:${list.level}`) ?? ctx.starts.get(`${abstract}:${list.level}`) ?? 1;
					counters[list.level] = (counters[list.level] ?? start - 1) + 1;
					marker = `${counters[list.level]}.`;
				}
				counters.length = list.level + 1;
				ctx.counters.set(list.numId, counters);
				const own = widths.get(list.numId) ?? [];
				own[list.level] = marker.length + 1;
				own.length = list.level + 1;
				widths.set(list.numId, own);
				const indent = ' '.repeat(own.slice(0, list.level).reduce((sum, w) => sum + (w ?? 2), 0));
				// A Word checkbox glyph at the start of an item is a Markdown task.
				const task = /^([☑☐])\s*/.exec(text);
				const item = task ? `[${task[1] === '☑' ? 'x' : ' '}] ${text.slice(task[0].length)}` : text;
				blocks.push({ kind: 'list', group: list.numId, lines: [`${indent}${marker} ${item.replace(/\n/g, '\n' + indent + ' '.repeat(marker.length + 1))}`] });
				continue;
			}
			if (kind === 'quote') { blocks.push({ kind: 'quote', lines: text.split('\n').map((line) => `> ${line.trim()}`) }); continue; }
			blocks.push({ kind: 'paragraph', lines: [escapeLineStart(text)] });
		}
	};
	visit(body);
	// Join: lists stay tight, code lines group into one fence, everything else is a paragraph apart.
	const out: string[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.kind === 'code') {
			const lines = [...block.lines];
			while (blocks[i + 1]?.kind === 'code') lines.push(...blocks[++i].lines);
			out.push('```\n' + lines.join('\n') + '\n```');
		} else if (block.kind === 'list') {
			const lines = [...block.lines];
			while (blocks[i + 1]?.kind === 'list' && blocks[i + 1].group === block.group) lines.push(...blocks[++i].lines);
			out.push(lines.join('\n'));
		} else if (block.kind === 'quote') {
			const lines = [...block.lines];
			while (blocks[i + 1]?.kind === 'quote') lines.push('>', ...blocks[++i].lines);
			out.push(lines.join('\n'));
		} else out.push(block.lines.join('\n'));
	}
	return out.join('\n\n') + (out.length ? '\n' : '');
}

export async function docxToMarkdown(buffer: ArrayBuffer): Promise<DocxImport> {
	if (buffer.byteLength > MAX_FILE) throw new Error('Word files are limited to 12 MB.');
	zipLimits(buffer);
	let zip: JSZip;
	try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('This is not a valid Word (.docx) file.'); }
	const text = async (path: string) => (await zip.file(path)?.async('string')) ?? null;
	const main = readXml(await text('word/document.xml'), 'document');
	if (!main || main.name !== 'w:document') throw new Error('This is not a Word document (.docx).');
	const body = firstElement(main, 'w:body');
	if (!body) throw new Error('This Word document has no content.');

	const ctx: Context = { rels: new Map(), styles: new Map(), nums: new Map(), formats: new Map(), starts: new Map(), overrides: new Map(), counters: new Map(), pictures: 0 };
	const relRoot = readXml(await text('word/_rels/document.xml.rels'), 'relationships');
	if (relRoot) for (const rel of elements(relRoot, 'Relationship')) if (rel.attrs.Id && rel.attrs.Target) ctx.rels.set(rel.attrs.Id, rel.attrs.Target);
	ctx.styles = parseStyles(readXml(await text('word/styles.xml'), 'styles'));
	parseNumbering(readXml(await text('word/numbering.xml'), 'numbering'), ctx);

	const markdown = convertBody(ctx, body);
	const warnings: string[] = [];
	if (ctx.pictures) warnings.push(`${ctx.pictures} picture${ctx.pictures === 1 ? ' was' : 's were'} not imported.`);
	if (zip.file('word/comments.xml')) warnings.push('Comments were not imported.');
	if (zip.file('word/footnotes.xml') || zip.file('word/endnotes.xml')) warnings.push('Footnotes and endnotes were not imported.');
	if (!markdown.trim()) warnings.push('No text was found in this document.');
	return { markdown, warnings, title: ctx.title };
}
