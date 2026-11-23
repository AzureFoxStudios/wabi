import { expect, test } from 'bun:test';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { pptxToSlides, type PptxHooks } from './pptxImport';
import { cleanDesign } from '../scene';

// A 1x1 PNG, so the picture path has real bytes to read.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const hooks = (seen: string[] = []): PptxHooks => ({ raster: async (_bytes, mime, name) => { seen.push(`${mime}:${name}`); return 'data:image/png;base64,iVBORw0KGgo='; } });

async function write(build: (pptx: PptxGenJS) => void): Promise<ArrayBuffer> {
	const pptx = new PptxGenJS();
	pptx.layout = 'LAYOUT_16x9';
	build(pptx);
	return (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
}

test('a real PPTX writer file: text, shapes, a table and a picture become editable objects', async () => {
	const seen: string[] = [];
	const buffer = await write((pptx) => {
		const slide = pptx.addSlide();
		slide.addText('Quarterly review', { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 40, bold: true, color: '203040', align: 'center' });
		slide.addText([{ text: 'Revenue is up', options: { bullet: true, breakLine: true } }, { text: 'Costs are flat', options: { bullet: true } }], { x: 0.7, y: 1.8, w: 8, h: 2, fontSize: 24 });
		slide.addShape(pptx.ShapeType.rect, { x: 1, y: 4, w: 2, h: 1, fill: { color: 'CC3300' } });
		slide.addShape(pptx.ShapeType.ellipse, { x: 4, y: 4, w: 2, h: 1, fill: { color: '0033CC' } });
		slide.addTable([[{ text: 'Region' }, { text: 'Sales' }], [{ text: 'North' }, { text: '12' }]], { x: 6.5, y: 4, w: 3, h: 1 });
		slide.addImage({ data: 'data:image/png;base64,' + btoa(String.fromCharCode(...PNG)), x: 7, y: 0.1, w: 0.5, h: 0.5, altText: 'A logo' });
		const second = pptx.addSlide();
		second.addText('Second slide', { x: 1, y: 1, w: 8, h: 1, fontSize: 32 });
	});
	const result = await pptxToSlides(buffer, hooks(seen));
	expect(result.slides).toHaveLength(2);
	expect(result.aspect).toBeCloseTo(16 / 9, 2);
	const [first, second] = result.slides;
	for (const slide of result.slides) expect(() => cleanDesign(slide.design)).not.toThrow(); // every object passes the app's own validation
	const kinds = first.design.objects.map((o) => o.kind);
	expect(kinds).toContain('text');
	expect(kinds).toContain('rect');
	expect(kinds).toContain('ellipse');
	expect(kinds).toContain('table');
	expect(kinds).toContain('image');
	const title = first.design.objects.find((o) => o.text === 'Quarterly review')!;
	expect(title.align).toBe('center');
	expect(title.color).toBe('#203040');
	expect(title.x).toBeCloseTo(0.05, 1);
	expect(title.w).toBeCloseTo(0.9, 1);
	const body = first.design.objects.find((o) => o.text.includes('Revenue is up'))!;
	expect(body.text).toBe('• Revenue is up\n• Costs are flat');
	expect(first.design.objects.find((o) => o.kind === 'rect')!.fill).toBe('#CC3300');
	expect(first.design.objects.find((o) => o.kind === 'table')!.text).toBe('Region\tSales\nNorth\t12');
	expect(first.design.objects.find((o) => o.kind === 'image')!.text).toBe('A logo');
	expect(seen).toHaveLength(1);
	expect(first.title).toBe('Quarterly review');
	expect(second.title).toBe('Second slide');
	expect(result.warnings.some((w) => w.includes('masters'))).toBe(true);
});

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (items: [string, string, string][]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const tx = (text: string, attrs = '') => `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr ${attrs}/><a:t>${text}</a:t></a:r></a:p></p:txBody>`;
const xfrm = (x: number, y: number, cx: number, cy: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const sp = (id: number, ph: string, spPr: string, body: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr>${body}</p:sp>`;
// `extra` goes inside the slide's common data (a background); `tail` after it, where timing and transitions live.
const slideXml = (shapes: string, extra = '', attrs = '', tail = '') => `<p:sld ${NS} ${attrs}><p:cSld>${extra}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes}</p:spTree></p:cSld>${tail}</p:sld>`;

async function handmade(slides: string[], extra: Record<string, string> = {}, size = '<p:sldSz cx="9144000" cy="6858000"/>'): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>${size}</p:presentation>`);
	zip.file('ppt/_rels/presentation.xml.rels', rels(slides.map((_, i) => [`rId${i + 1}`, 'slide', `slides/slide${i + 1}.xml`])));
	slides.forEach((xml, i) => {
		zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
		zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
	});
	zip.file('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sp(2, '<p:ph type="body" idx="1"/>', '', '')}</p:spTree></p:cSld></p:sldLayout>`);
	zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
	zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sp(2, '<p:ph type="title"/>', xfrm(914400, 457200, 7315200, 1143000), '')}${sp(3, '<p:ph type="body" idx="1"/>', xfrm(914400, 1828800, 7315200, 3657600), '')}</p:spTree></p:cSld></p:sldMaster>`);
	for (const [path, content] of Object.entries(extra)) zip.file(path, content);
	return zip.generateAsync({ type: 'arraybuffer' });
}

test('a placeholder with no position takes it from its layout, then its master', async () => {
	const result = await pptxToSlides(await handmade([slideXml(sp(2, '<p:ph type="title"/>', '', tx('Inherited title', 'sz="4000"')) + sp(3, '<p:ph type="body" idx="1"/>', '', tx('Inherited body')))]), hooks());
	const [title, body] = result.slides[0].design.objects;
	expect(title.text).toBe('Inherited title');
	// the master put the title at 914400/9144000 = 10% across, 457200/6858000 = about 6.7% down
	expect(title.x).toBeCloseTo(0.1, 2);
	expect(title.y).toBeCloseTo(457200 / 6858000, 3);
	expect(title.w).toBeCloseTo(0.8, 2);
	expect(title.fontSize).toBe(Math.round((40 / (9144000 / 12700)) * 1000)); // 40pt on a 720pt wide slide
	expect(body.text).toBe('• Inherited body'); // body placeholders keep their implied bullet
	expect(body.y).toBeCloseTo(0.267, 2);
});

test('group transforms place their children, and shapes past the edge are kept inside', async () => {
	const group = `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="4572000" y="0"/><a:ext cx="4572000" cy="3429000"/><a:chOff x="0" y="0"/><a:chExt cx="9144000" cy="6858000"/></a:xfrm></p:grpSpPr>${sp(5, '', xfrm(0, 0, 9144000, 6858000) + '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="112233"/></a:solidFill>', '')}</p:grpSp>`;
	const spill = sp(6, '', xfrm(8500000, 6000000, 3000000, 3000000) + '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="445566"/></a:solidFill>', '');
	const result = await pptxToSlides(await handmade([slideXml(group + spill)]), hooks());
	const [inGroup, outside] = result.slides[0].design.objects;
	expect(inGroup.x).toBeCloseTo(0.5, 3);
	expect(inGroup.w).toBeCloseTo(0.5, 3);
	expect(inGroup.h).toBeCloseTo(0.5, 3);
	expect(outside.x + outside.w).toBeLessThanOrEqual(1.000001);
	expect(outside.y + outside.h).toBeLessThanOrEqual(1.000001);
	expect(() => cleanDesign(result.slides[0].design)).not.toThrow();
});

test('hidden slides, dark backgrounds and the shape and aspect basics', async () => {
	const dark = slideXml(sp(2, '', xfrm(0, 0, 1000000, 1000000) + '<a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>', ''), '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="101820"/></a:solidFill></p:bgPr></p:bg>', 'show="0"');
	const result = await pptxToSlides(await handmade([dark, slideXml('')], {}, '<p:sldSz cx="12192000" cy="6858000"/>'), hooks());
	expect(result.slides[0].hidden).toBe(true);
	expect(result.slides[0].design.theme).toBe('night');
	expect(result.slides[0].design.objects[0].kind).toBe('ellipse');
	expect(result.slides[1].hidden).toBe(false);
	expect(result.slides[1].design.objects).toEqual([]);
	expect(result.slides[1].title).toBe('Slide 2');
	expect(result.aspect).toBeCloseTo(16 / 9, 3);
});

test('what is not carried over is named: notes, animations, charts and unsupported pictures', async () => {
	const pic = (rid: string) => `<p:pic><p:nvPicPr><p:cNvPr id="9" name="p" descr="d"/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr>${xfrm(0, 0, 1000000, 1000000)}</p:spPr></p:pic>`;
	const chart = `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`;
	const zipped = await handmade([slideXml(pic('rId2') + chart, '', '', '<p:timing/>')], {
		'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/image1.emf'], ['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
		'ppt/media/image1.emf': 'not an image we read'
	});
	const result = await pptxToSlides(zipped, hooks());
	expect(result.slides[0].design.objects).toEqual([]);
	expect(result.warnings).toContain('1 picture could not be imported (unsupported format, or too large).');
	expect(result.warnings).toContain('1 chart were not imported.');
	expect(result.warnings).toContain('Speaker notes were not imported.');
	expect(result.warnings).toContain('Animations and transitions were not imported.');
});

test('limits: at most 64 objects a slide and 200 slides, said out loud', async () => {
	const many = slideXml(Array.from({ length: 80 }, (_, i) => sp(i + 2, '', xfrm(100000 * (i % 10), 100000 * Math.floor(i / 10), 90000, 90000) + '<a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill>', '')).join(''));
	const limited = await pptxToSlides(await handmade([many]), hooks());
	expect(limited.slides[0].design.objects).toHaveLength(64);
	expect(limited.warnings).toContain('Slides with more than 64 objects were cut short.');
	const lots = await pptxToSlides(await handmade(Array.from({ length: 201 }, () => slideXml(''))), hooks());
	expect(lots.slides).toHaveLength(200);
	expect(lots.warnings).toContain('Only the first 200 slides were imported.');
});

test('hostile or broken files fail with a plain sentence, and a cancelled import stops', async () => {
	const bad = (presentation: string) => { const zip = new JSZip(); zip.file('ppt/presentation.xml', presentation); return zip.generateAsync({ type: 'arraybuffer' }); };
	await expect(pptxToSlides(await bad(`<!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]><p:presentation ${NS}/>`), hooks())).rejects.toThrow('could not be read');
	await expect(pptxToSlides(await bad('<p:presentation'), hooks())).rejects.toThrow('could not be read');
	await expect(pptxToSlides(await bad('<root/>'), hooks())).rejects.toThrow('not a PowerPoint presentation');
	await expect(pptxToSlides(await bad(`<p:presentation ${NS}/>`), hooks())).rejects.toThrow('no slides');
	await expect(pptxToSlides(await new JSZip().file('x.txt', 'hi').generateAsync({ type: 'arraybuffer' }), hooks())).rejects.toThrow('not a PowerPoint');
	await expect(pptxToSlides(new TextEncoder().encode('plainly not a zip').buffer as ArrayBuffer, hooks())).rejects.toThrow();
	await expect(pptxToSlides(new ArrayBuffer(13 * 1024 * 1024), hooks())).rejects.toThrow('12 MB');
	const controller = new AbortController();
	controller.abort();
	await expect(pptxToSlides(await handmade([slideXml('')]), { ...hooks(), signal: controller.signal })).rejects.toThrow();
});
