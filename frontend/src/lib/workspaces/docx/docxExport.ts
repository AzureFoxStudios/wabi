/**
 * Markdown to a Word (.docx) file.
 *
 * Headings, paragraphs, bold, italic, strikethrough, inline code, links, bulleted, numbered and task
 * lists (nested), quotes, code blocks, rules and tables become the Word things a person would expect;
 * images become a "[Image: …]" note because the document has no embedded pictures. The package is
 * built as plain strings (`buildDocxParts`, testable without zipping) and then zipped with the jszip
 * the app already uses. Nothing here reads a file or the network.
 */
import JSZip from 'jszip';
import { marked, type Token, type Tokens } from 'marked';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const xml = (text: string) =>
	text
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

/** Repeats until nothing changes, so removing one tag cannot leave another assembled from its neighbours. */
function stripTags(html: string): string {
	let text = html, before: string;
	do { before = text; text = text.replace(/<[^>]*>/g, ''); } while (text !== before);
	return text;
}

/** Markdown character references in text (&amp; and friends) become the characters they stand for. */
function decodeEntities(text: string): string {
	if (!text.includes('&')) return text;
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/g, (all, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
		}
		return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[body] ?? all;
	});
}

/** Only links that go somewhere safe are kept as links. */
function safeUrl(href: string): string | null {
	const url = href.trim();
	return /^(https?:|mailto:|tel:)/i.test(url) ? url : null;
}

interface Fmt { b?: boolean; i?: boolean; s?: boolean; code?: boolean; link?: boolean }

interface Ctx {
	links: Map<string, string>;
	/** One numbering instance per ordered list, so each starts at its own number. */
	ordered: { id: number; start: number }[];
	nextRel: number;
}

function rel(ctx: Ctx, url: string): string {
	let id = ctx.links.get(url);
	if (!id) { id = `rId${ctx.nextRel++}`; ctx.links.set(url, id); }
	return id;
}

function run(text: string, fmt: Fmt): string {
	if (!text) return '';
	const props =
		(fmt.link ? '<w:rStyle w:val="Hyperlink"/>' : '') +
		(fmt.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '') +
		(fmt.b ? '<w:b/>' : '') +
		(fmt.i ? '<w:i/>' : '') +
		(fmt.s ? '<w:strike/>' : '');
	return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function inline(tokens: Token[] | undefined, fmt: Fmt, ctx: Ctx): string {
	let out = '';
	for (const token of tokens ?? []) {
		switch (token.type) {
			case 'text': {
				const text = token as Tokens.Text;
				out += text.tokens ? inline(text.tokens, fmt, ctx) : run(decodeEntities(text.text).replace(/\s*\n\s*/g, ' '), fmt);
				break;
			}
			case 'escape': out += run((token as Tokens.Escape).text, fmt); break;
			case 'strong': out += inline((token as Tokens.Strong).tokens, { ...fmt, b: true }, ctx); break;
			case 'em': out += inline((token as Tokens.Em).tokens, { ...fmt, i: true }, ctx); break;
			case 'del': out += inline((token as Tokens.Del).tokens, { ...fmt, s: true }, ctx); break;
			case 'codespan': out += run(decodeEntities((token as Tokens.Codespan).text), { ...fmt, code: true }); break;
			case 'br': out += '<w:r><w:br/></w:r>'; break;
			case 'link': {
				const link = token as Tokens.Link;
				const url = safeUrl(link.href);
				out += url
					? `<w:hyperlink r:id="${rel(ctx, url)}" w:history="1">${inline(link.tokens, { ...fmt, link: true }, ctx)}</w:hyperlink>`
					: inline(link.tokens, fmt, ctx);
				break;
			}
			case 'image': out += run(`[Image: ${(token as Tokens.Image).text || 'image'}]`, fmt); break;
			case 'html': out += run(stripTags((token as Tokens.HTML).text), fmt); break;
			default: {
				const loose = token as { text?: string; raw?: string };
				out += run(decodeEntities(loose.text ?? loose.raw ?? ''), fmt);
			}
		}
	}
	return out;
}

const paragraph = (content: string, style?: string, extra = '') =>
	`<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''}${content}</w:p>`;

function listItems(list: Tokens.List, level: number, ctx: Ctx): string {
	let numId = 1;
	if (list.ordered) {
		numId = ctx.ordered.length + 2;
		ctx.ordered.push({ id: numId, start: typeof list.start === 'number' ? list.start : 1 });
	}
	const ilvl = Math.min(level, 8);
	let out = '';
	for (const item of list.items) {
		let first = true;
		const task = item.task ? run(item.checked ? '☑ ' : '☐ ', {}) : '';
		for (const block of item.tokens as Token[]) {
			if (block.type === 'text' || block.type === 'paragraph') {
				const tokens = (block as Tokens.Text).tokens;
				const content = inline(tokens, {}, ctx);
				if (first) {
					out += paragraph(task + content, 'ListParagraph', `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
					first = false;
				} else {
					out += paragraph(content, 'ListParagraph', `<w:ind w:left="${720 * (ilvl + 2)}"/>`);
				}
			} else if (block.type === 'list') {
				out += listItems(block as Tokens.List, level + 1, ctx);
			} else {
				out += blocks([block], ctx);
			}
		}
	}
	return out;
}

function table(token: Tokens.Table, ctx: Ctx): string {
	const columns = Math.max(1, token.header.length);
	const width = Math.floor(9026 / columns);
	const align = (index: number) => {
		const a = token.align[index];
		return a === 'center' || a === 'right' ? `<w:jc w:val="${a}"/>` : '';
	};
	const cell = (cellToken: Tokens.TableCell, index: number, header: boolean) =>
		`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraph(inline(cellToken.tokens, header ? { b: true } : {}, ctx), undefined, align(index))}</w:tc>`;
	const rowXml = (cells: Tokens.TableCell[], header: boolean) =>
		`<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: columns }, (_, i) => cell(cells[i] ?? ({ tokens: [] } as unknown as Tokens.TableCell), i, header)).join('')}</w:tr>`;
	return (
		`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0"/></w:tblPr>` +
		`<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>` +
		rowXml(token.header, true) +
		token.rows.map((row) => rowXml(row, false)).join('') +
		`</w:tbl>` +
		// Word wants a paragraph after a table.
		paragraph('')
	);
}

function blocks(tokens: Token[], ctx: Ctx, style?: string): string {
	let out = '';
	for (const token of tokens) {
		switch (token.type) {
			case 'heading': {
				const heading = token as Tokens.Heading;
				out += paragraph(inline(heading.tokens, {}, ctx), `Heading${Math.min(6, Math.max(1, heading.depth))}`);
				break;
			}
			case 'paragraph':
			case 'text': out += paragraph(inline((token as Tokens.Paragraph).tokens, {}, ctx), style); break;
			case 'list': out += listItems(token as Tokens.List, 0, ctx); break;
			case 'blockquote': out += blocks((token as Tokens.Blockquote).tokens, ctx, 'Quote'); break;
			case 'code':
				for (const line of decodeEntities((token as Tokens.Code).text).split('\n'))
					out += paragraph(line ? `<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>` : '', 'Code');
				break;
			case 'hr': out += paragraph('', undefined, '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr>'); break;
			case 'table': out += table(token as Tokens.Table, ctx); break;
			case 'html': {
				const text = stripTags((token as Tokens.HTML).text).trim();
				if (text) out += paragraph(run(text, {}), style);
				break;
			}
			default: break; // space and anything unknown
		}
	}
	return out;
}

const numberingLevel = (kind: 'bullet' | 'ordered', i: number) => {
	const left = 720 * (i + 1);
	if (kind === 'bullet') {
		const glyph = ['•', '◦', '▪'][i % 3];
		return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${glyph}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;
	}
	const fmt = ['decimal', 'lowerLetter', 'lowerRoman'][i % 3];
	return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;
};

function numberingXml(ctx: Ctx): string {
	const levels = (kind: 'bullet' | 'ordered') => Array.from({ length: 9 }, (_, i) => numberingLevel(kind, i)).join('');
	return (
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}">` +
		`<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum>` +
		`<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('ordered')}</w:abstractNum>` +
		`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
		ctx.ordered.map((list) => `<w:num w:numId="${list.id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${list.start}"/></w:lvlOverride></w:num>`).join('') +
		`</w:numbering>`
	);
}

const headingStyle = (n: number, size: number) =>
	`<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">` +
	`<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
	`<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
	`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
	`<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
	`<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>` +
	[1, 2, 3, 4, 5, 6].map((n) => headingStyle(n, [40, 32, 28, 26, 24, 22][n - 1])).join('') +
	`<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>` +
	`<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
	`<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>` +
	`</w:styles>`;

/** Every file of the package, as text, keyed by its path inside the zip. */
export function buildDocxParts(markdown: string, title: string): Record<string, string> {
	const ctx: Ctx = { links: new Map(), ordered: [], nextRel: 3 };
	const body = blocks(marked.lexer(markdown), ctx);
	const heading = title.trim() ? paragraph(run(title.trim(), {}), 'Title') : '';
	const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
	const links = [...ctx.links].map(([url, id]) => `<Relationship Id="${id}" Type="${REL_TYPE}/hyperlink" Target="${xml(url)}" TargetMode="External"/>`).join('');
	return {
		'[Content_Types].xml':
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
			`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
			`<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
			`<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
			`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
		'_rels/.rels':
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="word/document.xml"/>` +
			`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
		'docProps/core.xml':
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
			`<dc:title>${xml(title)}</dc:title><dc:creator>Wabi</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`,
		'word/_rels/document.xml.rels':
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="${REL_TYPE}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL_TYPE}/numbering" Target="numbering.xml"/>${links}</Relationships>`,
		'word/styles.xml': STYLES,
		'word/numbering.xml': numberingXml(ctx),
		'word/document.xml':
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${heading}${body}` +
			`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
	};
}

export async function markdownToDocx(markdown: string, title: string): Promise<Blob> {
	const zip = new JSZip();
	// The content types part comes first, as Word writes it.
	// No folder entries: an Office package lists parts only.
	for (const [path, content] of Object.entries(buildDocxParts(markdown, title))) zip.file(path, content, { createFolders: false });
	return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: DOCX_MIME });
}
