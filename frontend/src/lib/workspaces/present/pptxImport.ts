/**
 * A PowerPoint (.pptx) file to editable Wabi slides.
 *
 * Each slide becomes a canvas slide whose objects can be moved, resized and edited: text boxes and
 * placeholders (a placeholder with no position of its own takes it from its layout, then its master),
 * rectangles, ellipses and lines, pictures (PNG, JPEG, WebP), tables, and the contents of groups. Text
 * keeps its words, bullets, first size, colour and alignment; one size per object is all a Wabi text
 * object has, so mixed formatting inside a box is flattened.
 *
 * Not carried over, and named in the warnings so nothing disappears silently: masters (backgrounds,
 * logos, footers), speaker notes, charts, SmartArt, video and audio, animations and transitions,
 * rotation, and pictures in other formats.
 *
 * Safety is the same as the other imports: the archive passes the size and entry checks, only XML and
 * the picture parts are read, XML goes through the entity-free reader in ../docx/xml, and nothing is
 * executed or opened. Pictures are re-rasterised by the caller's hook, which bounds their size.
 */
import JSZip from 'jszip';
import { zipLimits } from '../zipLimits';
import { elements, firstElement, parseXml, XmlError, type XmlElement } from '../docx/xml';
import { scenePalette, type SceneObject, type SceneTheme, type SlideDesign } from '../scene';

export interface ImportedSlide { title: string; body: string; layout: string; image: null; design: SlideDesign; hidden?: boolean }
export interface PptxImport { aspect: number; slides: ImportedSlide[]; warnings: string[] }
export interface PptxHooks {
	/** Turns picture bytes into a bounded `data:image/...` URL, or null when it cannot. */
	raster: (bytes: Uint8Array, mime: string, name: string) => Promise<string | null>;
	progress?: (text: string) => void;
	signal?: AbortSignal;
}

const MAX_FILE = 12 * 1024 * 1024;
const MAX_SLIDES = 200;
const MAX_OBJECTS = 64;
const EMU_PER_POINT = 12700;

const num = (value: string | undefined, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

interface Box { x: number; y: number; cx: number; cy: number }

function boxOf(xfrm: XmlElement | undefined): Box | undefined {
	const off = firstElement(xfrm, 'a:off');
	const ext = firstElement(xfrm, 'a:ext');
	if (!off || !ext) return undefined;
	return { x: num(off.attrs.x), y: num(off.attrs.y), cx: num(ext.attrs.cx), cy: num(ext.attrs.cy) };
}

/** Maps child coordinates through a group's transform. */
type Transform = (box: Box) => Box;
const identity: Transform = (box) => box;

function groupTransform(grpSpPr: XmlElement | undefined, outer: Transform): Transform {
	const xfrm = firstElement(grpSpPr, 'a:xfrm');
	const own = boxOf(xfrm);
	const chOff = firstElement(xfrm, 'a:chOff');
	const chExt = firstElement(xfrm, 'a:chExt');
	if (!own || !chOff || !chExt || !num(chExt.attrs.cx) || !num(chExt.attrs.cy)) return outer;
	const sx = own.cx / num(chExt.attrs.cx);
	const sy = own.cy / num(chExt.attrs.cy);
	return (box) => outer({ x: own.x + (box.x - num(chOff.attrs.x)) * sx, y: own.y + (box.y - num(chOff.attrs.y)) * sy, cx: box.cx * sx, cy: box.cy * sy });
}

function normalize(path: string): string {
	const out: string[] = [];
	for (const part of path.split('/')) {
		if (part === '..') out.pop();
		else if (part !== '.' && part !== '') out.push(part);
	}
	return out.join('/');
}

async function readRels(zip: JSZip, partPath: string): Promise<Map<string, { target: string; type: string }>> {
	const dir = partPath.slice(0, partPath.lastIndexOf('/'));
	const file = partPath.slice(partPath.lastIndexOf('/') + 1);
	const raw = await zip.file(`${dir}/_rels/${file}.rels`)?.async('string');
	const rels = new Map<string, { target: string; type: string }>();
	if (!raw) return rels;
	const root = parse(raw, 'relationships');
	for (const rel of elements(root, 'Relationship')) {
		if (rel.attrs.TargetMode === 'External' || !rel.attrs.Id || !rel.attrs.Target) continue;
		rels.set(rel.attrs.Id, { target: normalize(rel.attrs.Target.startsWith('/') ? rel.attrs.Target.slice(1) : `${dir}/${rel.attrs.Target}`), type: rel.attrs.Type ?? '' });
	}
	return rels;
}

function parse(text: string, what: string): XmlElement {
	try { return parseXml(text); } catch (error) {
		if (error instanceof XmlError) throw new Error(`This PowerPoint file could not be read (${what}): ${error.message}`);
		throw error;
	}
}

interface Placeholder { type?: string; idx?: string }

function placeholderOf(sp: XmlElement): Placeholder | undefined {
	const ph = firstElement(firstElement(firstElement(sp, 'p:nvSpPr'), 'p:nvPr'), 'p:ph');
	return ph ? { type: ph.attrs.type, idx: ph.attrs.idx } : undefined;
}

/** The position a placeholder inherits: from the layout shape with the same idx or type, else from the master. */
function inheritedBox(ph: Placeholder, trees: XmlElement[]): Box | undefined {
	for (const tree of trees) {
		const spTree = firstElement(firstElement(tree, 'p:cSld'), 'p:spTree');
		if (!spTree) continue;
		const shapes = elements(spTree, 'p:sp');
		const match =
			shapes.find((sp) => { const other = placeholderOf(sp); return other && ph.idx !== undefined && other.idx === ph.idx && (other.type ?? 'body') === (ph.type ?? 'body'); }) ??
			shapes.find((sp) => { const other = placeholderOf(sp); return other && ph.type !== undefined && other.type === ph.type; }) ??
			shapes.find((sp) => { const other = placeholderOf(sp); return other && ph.idx !== undefined && other.idx === ph.idx; });
		const box = match ? boxOf(firstElement(firstElement(match, 'p:spPr'), 'a:xfrm')) : undefined;
		if (box) return box;
	}
	return undefined;
}

const hex = (value: string | undefined) => (value && /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined);

function solidColor(node: XmlElement | undefined): string | undefined {
	const fill = firstElement(node, 'a:solidFill');
	return hex(firstElement(fill, 'a:srgbClr')?.attrs.val);
}

interface TextInfo { text: string; fontPt?: number; color?: string; align: SceneObject['align'] }

function readText(txBody: XmlElement | undefined, bodyPlaceholder: boolean): TextInfo {
	const lines: string[] = [];
	let fontPt: number | undefined;
	let color: string | undefined;
	let align: SceneObject['align'] | undefined;
	const counters: number[] = [];
	for (const p of elements(txBody, 'a:p')) {
		const pPr = firstElement(p, 'a:pPr');
		const level = clamp(num(pPr?.attrs.lvl), 0, 8);
		const algn = pPr?.attrs.algn;
		if (!align && algn) align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left';
		let text = '';
		for (const child of elements(p)) {
			if (child.name === 'a:r' || child.name === 'a:fld') {
				const rPr = firstElement(child, 'a:rPr');
				if (fontPt === undefined && rPr?.attrs.sz) fontPt = num(rPr.attrs.sz) / 100;
				if (color === undefined) color = solidColor(rPr);
				text += elements(child, 'a:t').map((t) => t.children.filter((c): c is string => typeof c === 'string').join('')).join('');
			} else if (child.name === 'a:br') text += '\n';
		}
		if (text.trim() === '' && !text.includes('\n')) { lines.push(''); continue; }
		let prefix = '';
		if (!firstElement(pPr, 'a:buNone')) {
			if (firstElement(pPr, 'a:buAutoNum')) { counters[level] = (counters[level] ?? 0) + 1; counters.length = level + 1; prefix = `${counters[level]}. `; }
			else if (firstElement(pPr, 'a:buChar') || bodyPlaceholder) { prefix = '• '; counters.length = 0; }
		}
		lines.push('  '.repeat(level) + prefix + text);
	}
	return { text: lines.join('\n').replace(/^\n+|\n+$/g, ''), fontPt, color, align: align ?? 'left' };
}

function tableText(tbl: XmlElement): string {
	const rows: string[] = [];
	for (const tr of elements(tbl, 'a:tr').slice(0, 20)) {
		const cells = elements(tr, 'a:tc').slice(0, 8).map((tc) =>
			elements(firstElement(tc, 'a:txBody'), 'a:p')
				.map((p) => elements(p, 'a:r').map((r) => elements(r, 'a:t').map((t) => t.children.filter((c): c is string => typeof c === 'string').join('')).join('')).join(''))
				.join(' ')
				.replace(/[\t\n]/g, ' ')
				.trim());
		rows.push(cells.join('\t'));
	}
	return rows.join('\n');
}

const luminance = (color: string) => { const n = parseInt(color.slice(1), 16); return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
const id = () => crypto.randomUUID();

interface SlideContext {
	zip: JSZip;
	rels: Map<string, { target: string; type: string }>;
	inherit: XmlElement[];
	slideWidthPt: number;
	theme: SceneTheme;
	z: number;
	skipped: { pictures: number; charts: number; media: number; limit: boolean };
	hooks: PptxHooks;
	slideW: number;
	slideH: number;
}

function fit(box: Box, ctx: SlideContext) {
	const x = clamp(box.x / ctx.slideW, 0, 0.98);
	const y = clamp(box.y / ctx.slideH, 0, 0.98);
	const w = clamp(box.cx / ctx.slideW, 0.02, 1 - x);
	const h = clamp(box.cy / ctx.slideH, 0.02, 1 - y);
	return { x, y, w, h };
}

function base(kind: SceneObject['kind'], box: Box, ctx: SlideContext, over: Partial<SceneObject> = {}): SceneObject {
	const palette = scenePalette[ctx.theme];
	return { id: id(), kind, ...fit(box, ctx), z: ctx.z++, text: '', image: null, fill: 'transparent', color: palette.foreground, fontSize: 24, align: 'left', fit: 'contain', cropX: 0.5, cropY: 0.5, ...over };
}

async function readShapes(parent: XmlElement, transform: Transform, ctx: SlideContext, out: SceneObject[]): Promise<void> {
	for (const node of elements(parent)) {
		ctx.hooks.signal?.throwIfAborted();
		if (out.length >= MAX_OBJECTS) { ctx.skipped.limit = true; return; }
		if (node.name === 'p:grpSp') { await readShapes(node, groupTransform(firstElement(node, 'p:grpSpPr'), transform), ctx, out); continue; }
		if (node.name === 'p:sp') {
			const spPr = firstElement(node, 'p:spPr');
			const ph = placeholderOf(node);
			let box = boxOf(firstElement(spPr, 'a:xfrm'));
			if (!box && ph) box = inheritedBox(ph, ctx.inherit);
			if (!box) continue;
			box = transform(box);
			const geometry = firstElement(firstElement(spPr, 'a:prstGeom'), 'a:avLst') ? firstElement(spPr, 'a:prstGeom')?.attrs.prst : firstElement(spPr, 'a:prstGeom')?.attrs.prst;
			const fill = solidColor(spPr);
			const lineColor = solidColor(firstElement(spPr, 'a:ln'));
			const bodyLike = !!ph && (ph.type === undefined || ph.type === 'body' || ph.type === 'obj') && ph.idx !== undefined && ph.idx !== '0';
			const info = readText(firstElement(node, 'p:txBody'), bodyLike);
			if (geometry && /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(geometry)) {
				out.push(base('line', box, ctx, { color: lineColor ?? scenePalette[ctx.theme].foreground }));
				continue;
			}
			if (fill) out.push(base(geometry === 'ellipse' ? 'ellipse' : 'rect', box, ctx, { fill }));
			if (info.text.trim()) {
				const pt = info.fontPt ?? (ph?.type === 'title' || ph?.type === 'ctrTitle' ? 40 : bodyLike ? 24 : 18);
				out.push(base('text', box, ctx, { text: info.text.slice(0, 6000), color: info.color ?? scenePalette[ctx.theme].foreground, fontSize: clamp(Math.round((pt / ctx.slideWidthPt) * 1000), 12, 72), align: info.align }));
			}
			continue;
		}
		if (node.name === 'p:pic') {
			const blip = firstElement(firstElement(node, 'p:blipFill'), 'a:blip');
			const box = boxOf(firstElement(firstElement(node, 'p:spPr'), 'a:xfrm'));
			const rel = blip ? ctx.rels.get(blip.attrs['r:embed'] ?? '') : undefined;
			if (!box || !rel) { ctx.skipped.pictures++; continue; }
			const mime = /\.png$/i.test(rel.target) ? 'image/png' : /\.jpe?g$/i.test(rel.target) ? 'image/jpeg' : /\.webp$/i.test(rel.target) ? 'image/webp' : '';
			const bytes = mime ? await ctx.zip.file(rel.target)?.async('uint8array') : undefined;
			const data = bytes ? await ctx.hooks.raster(bytes, mime, rel.target.split('/').pop() ?? 'image') : null;
			if (!data) { ctx.skipped.pictures++; continue; }
			const descr = firstElement(firstElement(node, 'p:nvPicPr'), 'p:cNvPr')?.attrs.descr ?? '';
			out.push(base('image', transform(box), ctx, { image: data, text: descr.slice(0, 300) }));
			continue;
		}
		if (node.name === 'p:graphicFrame') {
			const box = boxOf(firstElement(node, 'p:xfrm'));
			const data = firstElement(firstElement(node, 'a:graphic'), 'a:graphicData');
			const tbl = firstElement(data, 'a:tbl');
			if (tbl && box) {
				const text = tableText(tbl);
				if (text.trim()) out.push(base('table', transform(box), ctx, { text, fontSize: 20 }));
			} else if (/chart/i.test(data?.attrs.uri ?? '')) ctx.skipped.charts++;
			else ctx.skipped.media++;
			continue;
		}
	}
}

export async function pptxToSlides(buffer: ArrayBuffer, hooks: PptxHooks): Promise<PptxImport> {
	if (buffer.byteLength > MAX_FILE) throw new Error('Presentation import is limited to 12 MB.');
	zipLimits(buffer);
	let zip: JSZip;
	try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('This is not a valid PowerPoint (.pptx) file.'); }
	const presentationText = await zip.file('ppt/presentation.xml')?.async('string');
	if (!presentationText) throw new Error('This is not a PowerPoint presentation (.pptx).');
	const presentation = parse(presentationText, 'presentation');
	if (presentation.name !== 'p:presentation') throw new Error('This is not a PowerPoint presentation (.pptx).');

	const size = firstElement(presentation, 'p:sldSz');
	const slideW = num(size?.attrs.cx, 9144000) || 9144000;
	const slideH = num(size?.attrs.cy, 6858000) || 6858000;
	const rels = await readRels(zip, 'ppt/presentation.xml');
	const order = elements(firstElement(presentation, 'p:sldIdLst'), 'p:sldId').map((s) => rels.get(s.attrs['r:id'] ?? '')?.target).filter((t): t is string => !!t);
	if (!order.length) throw new Error('This presentation has no slides.');

	const warnings: string[] = [];
	const slides: ImportedSlide[] = [];
	const totals = { pictures: 0, charts: 0, media: 0, limit: false };
	let notes = false, timing = false;
	for (const [index, path] of order.slice(0, MAX_SLIDES).entries()) {
		hooks.signal?.throwIfAborted();
		hooks.progress?.(`Reading slide ${index + 1} of ${Math.min(order.length, MAX_SLIDES)}`);
		const text = await zip.file(path)?.async('string');
		if (!text) continue;
		const slide = parse(text, `slide ${index + 1}`);
		const slideRels = await readRels(zip, path);
		const inherit: XmlElement[] = [];
		const layoutRel = [...slideRels.values()].find((r) => /\/slideLayout$/.test(r.type));
		if (layoutRel) {
			const layoutText = await zip.file(layoutRel.target)?.async('string');
			if (layoutText) {
				inherit.push(parse(layoutText, 'layout'));
				const masterRel = [...(await readRels(zip, layoutRel.target)).values()].find((r) => /\/slideMaster$/.test(r.type));
				const masterText = masterRel ? await zip.file(masterRel.target)?.async('string') : undefined;
				if (masterText) inherit.push(parse(masterText, 'master'));
			}
		}
		const background = solidColor(firstElement(firstElement(firstElement(slide, 'p:cSld'), 'p:bg'), 'p:bgPr'));
		const theme: SceneTheme = background && luminance(background) < 0.35 ? 'night' : 'paper';
		const ctx: SlideContext = { zip, rels: slideRels, inherit, slideWidthPt: slideW / EMU_PER_POINT, theme, z: 1, skipped: { pictures: 0, charts: 0, media: 0, limit: false }, hooks, slideW, slideH };
		const objects: SceneObject[] = [];
		const tree = firstElement(firstElement(slide, 'p:cSld'), 'p:spTree');
		if (tree) await readShapes(tree, identity, ctx, objects);
		totals.pictures += ctx.skipped.pictures; totals.charts += ctx.skipped.charts; totals.media += ctx.skipped.media; totals.limit ||= ctx.skipped.limit;
		if ([...slideRels.values()].some((r) => /\/notesSlide$/.test(r.type))) notes = true;
		if (firstElement(slide, 'p:timing') || firstElement(slide, 'p:transition')) timing = true;
		const title = objects.find((o) => o.kind === 'text')?.text.split('\n')[0].trim().slice(0, 80) || `Slide ${index + 1}`;
		slides.push({ title, body: '', layout: 'canvas', image: null, hidden: slide.attrs.show === '0', design: { theme, objects } });
	}
	if (order.length > MAX_SLIDES) warnings.push(`Only the first ${MAX_SLIDES} slides were imported.`);
	if (totals.limit) warnings.push(`Slides with more than ${MAX_OBJECTS} objects were cut short.`);
	if (totals.pictures) warnings.push(`${totals.pictures} picture${totals.pictures === 1 ? '' : 's'} could not be imported (unsupported format, or too large).`);
	if (totals.charts) warnings.push(`${totals.charts} chart${totals.charts === 1 ? '' : 's'} were not imported.`);
	if (totals.media) warnings.push(`${totals.media} other embedded item${totals.media === 1 ? '' : 's'} (SmartArt, media, objects) were not imported.`);
	if (notes) warnings.push('Speaker notes were not imported.');
	if (timing) warnings.push('Animations and transitions were not imported.');
	warnings.push('Slide masters (backgrounds, logos, footers) are not imported; each slide keeps its own content.');
	return { aspect: slideW / slideH, slides, warnings };
}
