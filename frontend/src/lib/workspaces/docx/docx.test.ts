import { expect, test } from 'bun:test';
import JSZip from 'jszip';
import { buildDocxParts, markdownToDocx } from './docxExport';
import { docxToMarkdown } from './docxImport';
import { elements, firstElement, parseXml, textOf } from './xml';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const buffer = async (blob: Blob) => blob.arrayBuffer();

async function makeDocx(parts: Record<string, string>): Promise<ArrayBuffer> {
	const zip = new JSZip();
	for (const [path, content] of Object.entries(parts)) zip.file(path, content);
	return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
const doc = (body: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const p = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

const SAMPLE = `# Plan

Some **bold**, *italic*, ~~gone~~ and \`code\` with a [link](https://example.org/a?b=1&c=2) & an ampersand.

- first
  - nested
- [x] done
- [ ] todo

3. three
4. four

> quoted words

\`\`\`
let x = 1 < 2;
\`\`\`

---

| Name | Qty |
| --- | ---: |
| apples | 3 |
| **pears** | 4 |
`;

test('every part of an exported file is well-formed XML, and the package hangs together', async () => {
	const parts = buildDocxParts(SAMPLE, 'My plan');
	for (const [path, content] of Object.entries(parts)) expect(() => parseXml(content), path).not.toThrow();
	for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) expect(parts[required]).toBeDefined();
	// each Override and each internal relationship points at a part that exists
	for (const override of elements(parseXml(parts['[Content_Types].xml']), 'Override')) expect(parts[override.attrs.PartName.slice(1)], override.attrs.PartName).toBeDefined();
	for (const rel of elements(parseXml(parts['word/_rels/document.xml.rels']), 'Relationship'))
		if (rel.attrs.TargetMode !== 'External') expect(parts['word/' + rel.attrs.Target], rel.attrs.Target).toBeDefined();
	// every relationship id used in the document is declared
	const declared = new Set(elements(parseXml(parts['word/_rels/document.xml.rels']), 'Relationship').map((r) => r.attrs.Id));
	for (const used of parts['word/document.xml'].matchAll(/r:id="(rId\d+)"/g)) expect(declared.has(used[1])).toBe(true);
	// every style the document names is defined
	const styleIds = new Set(elements(parseXml(parts['word/styles.xml']), 'w:style').map((s) => s.attrs['w:styleId']));
	for (const used of parts['word/document.xml'].matchAll(/<w:pStyle w:val="([^"]+)"/g)) expect(styleIds.has(used[1]), used[1]).toBe(true);
	// the heading carries the title; the document ends with its section properties
	expect(parts['word/document.xml']).toContain('<w:pStyle w:val="Title"/>');
	expect(parts['word/document.xml'].endsWith('</w:sectPr></w:body></w:document>')).toBe(true);
});

test('the zip is a real package that opens again', async () => {
	const blob = await markdownToDocx(SAMPLE, 'My plan');
	expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
	const zip = await JSZip.loadAsync(await buffer(blob));
	expect(Object.keys(zip.files)).toContain('word/document.xml');
	expect(Object.keys(zip.files)[0]).toBe('[Content_Types].xml');
	// parts only, no folder entries
	expect(Object.keys(zip.files).filter((name) => name.endsWith('/'))).toEqual([]);
});

test('text is escaped, control characters are removed, and unsafe links are not links', () => {
	const parts = buildDocxParts('a < b & c > d "q" \u0001 [x](javascript:alert(1)) [ok](mailto:a@b.c)', 'T & <U>');
	expect(() => parseXml(parts['word/document.xml'])).not.toThrow();
	expect(parts['word/document.xml']).not.toContain('\u0001');
	expect(parts['word/document.xml']).toContain('a &lt; b &amp; c &gt; d');
	expect(parts['word/_rels/document.xml.rels']).not.toContain('javascript');
	expect(parts['word/_rels/document.xml.rels']).toContain('mailto:a@b.c');
	expect(parts['docProps/core.xml']).toContain('T &amp; &lt;U&gt;');
});

test('lists number independently and tasks keep their state', () => {
	const parts = buildDocxParts('1. a\n2. b\n\ntext\n\n7. c\n', 'T');
	const numbering = parts['word/numbering.xml'];
	expect(numbering).toContain('<w:startOverride w:val="1"/>');
	expect(numbering).toContain('<w:startOverride w:val="7"/>');
	expect(buildDocxParts('- [x] done\n- [ ] todo', 'T')['word/document.xml']).toMatch(/☑ [\s\S]*☐ /);
});

test('round trip: what goes into Word comes back as the same Markdown', async () => {
	const back = (await docxToMarkdown(await buffer(await markdownToDocx(SAMPLE, 'My plan')))).markdown;
	expect(back).not.toContain('# My plan'); // the Title paragraph names the document instead
	expect((await docxToMarkdown(await buffer(await markdownToDocx(SAMPLE, 'My plan')))).title).toBe('My plan');
	expect(back).toContain('**bold**');
	expect(back).toContain('*italic*');
	expect(back).toContain('~~gone~~');
	expect(back).toContain('[link](https://example.org/a?b=1&c=2)');
	expect(back).toContain('& an ampersand');
	expect(back).toContain('- first\n  - nested');
	expect(back).toContain('3. three\n4. four'); // the list keeps its own starting number
	expect(back).toContain('- [x] done\n- [ ] todo\n\n3. three'); // tasks survive; a different list is a new block
	expect(back).toContain('`code`'); // inline code keeps its backticks
	expect(back).toContain('> quoted words');
	expect(back).toContain('```\nlet x = 1 < 2;\n```');
	expect(back).toContain('| Name | Qty |'); // a header row is not double-bolded
	expect(back).toContain('| apples | 3 |');
});

test('a Word-style file: localized heading style, inherited style, numbering, field link, tracked change, merged cell', async () => {
	const styles = `<w:styles ${W}>
		<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style>
		<w:style w:type="paragraph" w:styleId="MonTitre"><w:name w:val="My Heading"/><w:basedOn w:val="Titre1"/></w:style>
		<w:style w:type="paragraph" w:styleId="Citation"><w:name w:val="Quote"/></w:style>
		<w:style w:type="paragraph" w:styleId="ListeNum"><w:name w:val="List Number"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
	</w:styles>`;
	const numbering = `<w:numbering ${W}>
		<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
		<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
		<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
	</w:numbering>`;
	const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="x/hyperlink" Target="https://example.org/" TargetMode="External"/><Relationship Id="rId8" Type="x/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`;
	const bullet = (text: string, level: number) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
	const body =
		p('Welcome', 'MonTitre') +
		// bold split across runs must merge into one span, with the space kept outside
		`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>world</w:t></w:r><w:r><w:t xml:space="preserve"> plain </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>soft</w:t></w:r></w:p>` +
		`<w:p><w:hyperlink r:id="rId9"><w:r><w:t>Site</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rId8"><w:r><w:t>Bad</w:t></w:r></w:hyperlink></w:p>` +
		`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://field.example/" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Field link</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
		`<w:p><w:r><w:t xml:space="preserve">kept </w:t></w:r><w:ins><w:r><w:t>added</w:t></w:r></w:ins><w:del><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>` +
		bullet('one', 0) + bullet('two', 0) + bullet('sub', 1) +
		p('First', 'ListeNum') + p('Second', 'ListeNum') +
		p('A famous line', 'Citation') +
		p('- looks like a list', undefined) +
		`<w:p><w:r><w:t>line one</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>line two</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>` +
		`<w:p><w:r><w:drawing/></w:r></w:p>` +
		`<w:sdt><w:sdtContent>${p('inside a content control')}</w:sdtContent></w:sdt>` +
		`<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('Head')}</w:tc></w:tr><w:tr><w:tc>${p('a | b')}</w:tc><w:tc>${p('c')}</w:tc></w:tr></w:tbl>`;
	const result = await docxToMarkdown(await makeDocx({ 'word/document.xml': doc(body), 'word/styles.xml': styles, 'word/numbering.xml': numbering, 'word/_rels/document.xml.rels': rels, 'word/comments.xml': '<c/>' }));
	const md = result.markdown;
	expect(md).toContain('# Welcome'); // a custom style based on a localized "heading 1"
	expect(md).toContain('**Hello world** plain *soft*');
	expect(md).toContain('[Site](https://example.org/) and Bad'); // the javascript: link is dropped, its text kept
	expect(md).not.toContain('javascript');
	expect(md).toContain('[Field link](https://field.example/)');
	expect(md).toContain('kept added');
	expect(md).not.toContain('removed');
	expect(md).toContain('- one\n- two\n  - sub');
	expect(md).toContain('1. First\n2. Second');
	expect(md).toContain('> A famous line');
	expect(md).toContain('\\- looks like a list');
	expect(md).toContain('line one  \nline two');
	expect(md).toContain('inside a content control');
	expect(md).toContain('| Head |  |\n| --- | --- |\n| a \\| b | c |');
	expect(result.warnings).toContain('1 picture was not imported.');
	expect(result.warnings).toContain('Comments were not imported.');
});

test('special characters in Word text cannot turn into Markdown or HTML', async () => {
	const md = (await docxToMarkdown(await makeDocx({ 'word/document.xml': doc(p('*not bold* and _not italic_ and `tick` and [x](y) and &lt;b>tag&lt;/b> and # not heading') + p('# real text with hash') + p('1. not a list')) }))).markdown;
	expect(md).toContain('\\*not bold\\* and \\_not italic\\_ and \\`tick\\` and \\[x\\](y) and \\<b>tag\\</b> and # not heading');
	expect(md).toContain('\\# real text with hash');
	expect(md).toContain('1\\. not a list');
});

test('hostile or broken files fail with a plain sentence', async () => {
	await expect(docxToMarkdown(await makeDocx({ 'word/document.xml': `<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document ${W}><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>` }))).rejects.toThrow('could not be read');
	await expect(docxToMarkdown(await makeDocx({ 'word/other.xml': '<a/>' }))).rejects.toThrow('not a Word document');
	await expect(docxToMarkdown(new TextEncoder().encode('this is not a zip file at all, just text').buffer as ArrayBuffer)).rejects.toThrow();
	await expect(docxToMarkdown(await makeDocx({ 'word/document.xml': '<w:document' }))).rejects.toThrow('could not be read');
	await expect(docxToMarkdown(await makeDocx({ 'word/document.xml': '<root/>' }))).rejects.toThrow('not a Word document');
	await expect(docxToMarkdown(new ArrayBuffer(13 * 1024 * 1024))).rejects.toThrow('12 MB');
});

test('an empty document says so rather than importing nothing silently', async () => {
	const result = await docxToMarkdown(await makeDocx({ 'word/document.xml': doc('') }));
	expect(result.markdown).toBe('');
	expect(result.warnings).toContain('No text was found in this document.');
	void firstElement; void textOf;
});
