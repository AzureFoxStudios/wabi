// Run against a Vite development server. Uses real Markdown/sanitizer code in a
// headful browser; no fixture auth, user content, or backend changes are needed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = process.env.WABI_SMOKE_CDP_URL
	? await chromium.connectOverCDP(process.env.WABI_SMOKE_CDP_URL)
	: await chromium.launch({ headless: false, executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
const context = await browser.newContext();
try {
	const page = await context.newPage();
	await page.goto(process.env.WABI_SMOKE_ORIGIN || 'http://127.0.0.1:5173');
	const result = await page.evaluate(async () => {
		const { parseMessage } = await import('/src/lib/markdown.ts');
		const source = '| Day | Gathering |\n| --- | --- |\n| Monday | Open studio |';
		const chatFirst = parseMessage(source);
		const wiki = parseMessage(source, [], { allowTables: true });
		const chatAgain = parseMessage(source);
		const document = new DOMParser().parseFromString(wiki, 'text/html');
		const unsafe = parseMessage('| Content |\n| --- |\n| <img src="x" onerror="alert(1)"> <a href="javascript:alert(1)">unsafe</a> <script>alert(1)</script> |', [], { allowTables: true });
		const unsafeDocument = new DOMParser().parseFromString(unsafe, 'text/html');
		const code = parseMessage('```text\nfirst\n  indented\n```', [], { allowTables: true });
		return {
			headers: [...document.querySelectorAll('th')].map(node => node.textContent),
			cells: [...document.querySelectorAll('td')].map(node => node.textContent),
			chatUnchanged: chatFirst === chatAgain && !chatAgain.includes('<table'),
			unsafeTags: unsafeDocument.querySelectorAll('script,iframe,object,embed').length,
			unsafeAttributes: [...unsafeDocument.querySelectorAll('*')].flatMap(node => [...node.attributes]).filter(attribute => /^on/i.test(attribute.name) || /javascript:/i.test(attribute.value)).length,
			codePreserved: new DOMParser().parseFromString(code, 'text/html').querySelector('pre')?.textContent.includes('first\n  indented')
		};
	});
	assert.deepEqual(result.headers, ['Day', 'Gathering']);
	assert.deepEqual(result.cells, ['Monday', 'Open studio']);
	assert.equal(result.chatUnchanged, true, 'Wiki cache entries do not alter chat rendering');
	assert.equal(result.unsafeTags, 0, 'unsafe elements remain removed');
	assert.equal(result.unsafeAttributes, 0, 'event handlers and unsafe URLs remain removed');
	assert.equal(result.codePreserved, true, 'code whitespace remains intact');
	console.log('PASS: Wiki tables retain headings/cells, chat behavior is unchanged, unsafe markup remains removed, code whitespace is preserved.');
} finally {
	await context.close();
	await browser.close();
}
