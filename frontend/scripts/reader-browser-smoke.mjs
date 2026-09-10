import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

// Uses the production Reader, parser, preferences, library, and CSS. Only the
// surrounding tab queue is stubbed: this test never contacts a Wabi server.
// Run on Linux: xvfb-run -a node scripts/reader-browser-smoke.mjs
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(frontend, '.reader-smoke-'));
const artifacts = process.env.READER_ARTIFACT_DIR || path.join(tmpdir(), 'wabi-reader-artifacts');
await mkdir(artifacts, { recursive: true });
const file = (relative) => JSON.stringify(path.join(frontend, relative));
let server;
let browser;
const passed = [];

try {
	await writeFile(path.join(fixture, 'environment.js'), 'export const browser = true; export const dev = true; export const building = false;');
	await writeFile(path.join(fixture, 'tabQueue.js'), 'export const mobileTabQueue = { openAddonTab() {} };');
	await writeFile(path.join(fixture, 'main.js'), `
		import { mount } from 'svelte';
		import { get } from 'svelte/store';
		import Reader from ${file('src/lib/components/ReaderTabImpl.svelte')};
		import ${file('src/styles/components/reader-tab.css')};
		import { readerSelection, readerPreferences, updateReaderPreferences } from ${file('src/lib/readerWorkspace.ts')};
		import { readerLibrary } from ${file('src/lib/readerLibrary.ts')};
		import { highlightReaderSearch, clearReaderSearch } from ${file('src/lib/components/readerDocumentTools.ts')};
		updateReaderPreferences({ theme: 'paper', fontSize: 20 });
		mount(Reader, { target: document.getElementById('app') });
		window.readerTest = {
			state() { const doc = get(readerSelection); return { key: doc?.docKey, record: doc ? get(readerLibrary)[doc.docKey] : null }; },
			highlightReaderSearch, clearReaderSearch
		};
	`);
	await writeFile(path.join(fixture, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
		html,body,#app{height:100%;width:100%;margin:0} body{background:#132223;font-family:system-ui}
		:root{--text-secondary:#f4eccf;--surface-base:#e7e1d2;--text-warning:#ffcc44;--font-sans:system-ui}
		/* Deliberately hostile chat styling must not affect the document. */
		.markdown-content{max-height:300px;overflow:hidden;font-size:12px;color:#dedccc}
	</style></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>`);
	server = await createServer({
		configFile: false, root: fixture,
		plugins: [svelte({ configFile: false })],
		resolve: { dedupe: ['svelte'], alias: [
			{ find: '$app/environment', replacement: path.join(fixture, 'environment.js') },
			{ find: '$lib/mobileTabQueue', replacement: path.join(fixture, 'tabQueue.js') },
			{ find: '$lib', replacement: path.join(frontend, 'src/lib') }
		] },
		server: { host: '127.0.0.1', port: 0, fs: { allow: [frontend] } },
		logLevel: 'warn'
	});
	await server.listen();
	const origin = server.resolvedUrls.local[0];
	// Headful under Xvfb avoids the repository's documented headless Skia crash.
	browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
	const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light', reducedMotion: 'reduce' });
	await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(origin);
	await page.waitForFunction(() => !!window.readerTest);
	await page.locator('.reader-home h1').waitFor();
	await page.screenshot({ path: path.join(artifacts, '01-reader-home.png') });
	passed.push('real component mounts with functional empty state');

	const paragraph = 'The path through the valley opened into a broad stretch of morning light. A reader should be able to stay here for a while, following a thought without fighting the page. Comfortable lines, clear paragraphs, and a steady place to return are more useful than a crowded toolbar.';
	const book = '# A Place to Read\n\nA quiet **turning** point begins this book.\n\n```js\nconst answer = 42;\n```\n\n' +
		Array.from({ length: 80 }, (_, chapter) => `## Chapter ${chapter + 1}\n\n` + Array.from({ length: 24 }, (_, index) => `Passage ${chapter + 1}.${index + 1}. ${paragraph}`).join('\n\n')).join('\n\n') +
		'\n\n## Final chapter\n\nAnother quiet **turning** point.\n\nEND OF LONG-FORM FIXTURE.\n\n<script>window.readerXss = true</script>';
	const openBook = async () => {
		await page.locator('.reader-hidden-input').first().setInputFiles({ name: 'long-book.md', mimeType: 'text/markdown', buffer: Buffer.from(book) });
		await page.locator('.reader-document-body h1').waitFor();
		await page.waitForTimeout(500);
	};
	await openBook();
	const initial = await page.evaluate(() => {
		const view = document.querySelector('.reader-viewport');
		const prose = document.querySelector('.reader-prose');
		return { height: view.clientHeight, extent: view.scrollHeight, color: getComputedStyle(prose).color, font: getComputedStyle(prose).fontSize, lineHeight: getComputedStyle(prose).lineHeight, clipped: getComputedStyle(prose).maxHeight, xss: window.readerXss };
	});
	assert.ok(initial.height > 600, 'reader must fill the available height');
	assert.ok(initial.extent > initial.height * 20, 'long document must not be clipped to a card');
	assert.equal(initial.color, 'rgb(37, 43, 41)');
	assert.equal(initial.font, '20px');
	assert.ok(parseFloat(initial.lineHeight) >= 30);
	assert.equal(initial.clipped, 'none');
	assert.equal(initial.xss, undefined);
	assert.equal(await page.locator('.reader-document-body script').count(), 0);
	assert.equal(await page.locator('.reader-outline-item').count(), 82);
	await page.screenshot({ path: path.join(artifacts, '02-long-form-reading.png') });
	passed.push('100k+ word document: full-height scrolling, isolated contrast, true contents and sanitized HTML');

	await page.locator('.reader-viewport').focus();
	await page.keyboard.press('Control+f');
	await page.getByRole('textbox', { name: 'Find text' }).fill('quiet turning point');
	await page.waitForFunction(() => document.querySelectorAll('mark[data-reader-search]').length >= 6);
	assert.equal(await page.locator('.reader-focused').count(), 0, 'Ctrl+F must not trigger focus mode');
	assert.match(await page.locator('.reader-search-count').innerText(), /1 \/ 2/);
	await page.getByRole('button', { name: 'Next match', exact: true }).click();
	assert.match(await page.locator('.reader-search-count').innerText(), /2 \/ 2/);
	await page.getByRole('button', { name: 'Close search', exact: true }).click();
	await page.waitForTimeout(200);
	assert.equal(await page.locator('mark[data-reader-search]').count(), 0);
	passed.push('literal search crosses inline emphasis, next match works, Ctrl+F is scoped correctly');

	const seek = async (percent) => {
		await page.getByRole('slider', { name: 'Reading position' }).evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, percent);
		await page.waitForTimeout(350);
	};
	await seek(42);
	await page.getByRole('button', { name: 'Bookmark this place', exact: true }).click();
	await page.getByRole('button', { name: 'Notes', exact: true }).click();
	await page.getByRole('textbox', { name: 'Note for this passage' }).fill('A saved thought tied to this passage.');
	await page.getByRole('button', { name: 'Save note', exact: true }).click();
	const saved = await page.evaluate(() => window.readerTest.state());
	assert.equal(saved.record.bookmarks.length, 1);
	assert.equal(saved.record.notes.length, 1);
	await page.reload();
	await page.waitForFunction(() => !!window.readerTest);
	await openBook();
	const restored = await page.evaluate(() => window.readerTest.state());
	assert.equal(restored.record.bookmarks.length, 1);
	assert.equal(restored.record.notes.length, 1);
	assert.ok(Math.abs(restored.record.anchor.block - saved.record.anchor.block) <= 1, 'reopening must restore the same passage');
	passed.push('bookmarks, notes and block-anchored position survive reload and reopening');

	await page.getByRole('button', { name: 'Switch to paged reading', exact: true }).click();
	await page.waitForTimeout(400);
	const paged = await page.evaluate(() => {
		const el = document.querySelector('.reader-viewport');
		return { width: el.clientWidth, extent: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, left: el.scrollLeft };
	});
	assert.ok(paged.extent > paged.width * 20, 'paged mode must actually reflow into horizontal columns');
	assert.ok(paged.scrollHeight <= paged.height + 2, 'pages must not hide vertically overflowing text');
	await page.getByRole('button', { name: 'Next page', exact: true }).click();
	await page.waitForTimeout(100);
	const nextLeft = await page.locator('.reader-viewport').evaluate((el) => el.scrollLeft);
	assert.ok(Math.abs(nextLeft - paged.left - paged.width) < 3, 'next page must move by exactly one viewport');
	await seek(100);
	const endVisible = await page.locator('.reader-document-body p').filter({ hasText: 'END OF LONG-FORM FIXTURE.' }).evaluate((el) => {
		const view = document.querySelector('.reader-viewport').getBoundingClientRect();
		return [...el.getClientRects()].some((rect) => rect.right > view.left && rect.left < view.right && rect.top >= view.top && rect.bottom <= view.bottom + 2);
	});
	assert.ok(endVisible, 'the last paragraph must remain reachable in paged mode');
	await seek(0);
	await page.screenshot({ path: path.join(artifacts, '03-paged-reading.png') });
	passed.push('real paginated columns, exact page navigation and reachable final paragraph');

	await page.getByRole('button', { name: 'Switch to continuous scrolling', exact: true }).click();
	await seek(42);
	const beforeFont = await page.evaluate(() => window.readerTest.state().record.anchor.block);
	await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
	await page.getByRole('slider', { name: 'Text size', exact: true }).evaluate((input) => { input.value = '24'; input.dispatchEvent(new Event('input', { bubbles: true })); });
	await page.getByRole('button', { name: 'Close reading settings', exact: true }).click();
	await page.waitForTimeout(400);
	const afterFont = await page.evaluate(() => window.readerTest.state().record.anchor.block);
	assert.ok(Math.abs(afterFont - beforeFont) <= 1, 'font changes must preserve the passage');
	await page.getByRole('button', { name: 'Enter focus mode', exact: true }).click();
	assert.equal(await page.locator('.reader-focused').count(), 1);
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('.reader-focused').count(), 0);
	passed.push('font changes preserve the anchor; focus mode enters and exits by keyboard');

	if (await page.getByRole('button', { name: 'Close document sidebar', exact: true }).count()) await page.getByRole('button', { name: 'Close document sidebar', exact: true }).click();
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await page.waitForTimeout(250);
		const overflow = await page.evaluate(() => {
			const bounds = document.querySelector('.reader-shell').getBoundingClientRect();
			return [...document.querySelectorAll('.reader-toolbar button')].some((el) => el.getBoundingClientRect().right > bounds.right + 1);
		});
		assert.equal(overflow, false, `toolbar controls must fit a ${width}px-wide dock`);
	}
	await seek(0);
	await page.screenshot({ path: path.join(artifacts, '04-mobile-reading.png') });
	passed.push('mobile and narrow-dock controls remain visible at 390px and 320px');

	await page.setViewportSize({ width: 1440, height: 960 });
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
	await page.locator('.reader-hidden-input[multiple]').setInputFiles([
		{ name: 'page-01.png', mimeType: 'image/png', buffer: png },
		{ name: 'page-02.png', mimeType: 'image/png', buffer: png }
	]);
	await page.locator('.reader-image-page').first().waitFor();
	assert.equal(await page.locator('.reader-image-page').count(), 2);
	await page.getByRole('button', { name: 'Next page', exact: true }).click();
	await page.waitForTimeout(250);
	assert.match(await page.locator('.reader-pagination').innerText(), /Image 2 of 2/);
	await page.getByRole('button', { name: 'Open image 2: page-02.png', exact: true }).click();
	await page.getByRole('dialog', { name: 'Image viewer', exact: true }).waitFor();
	await page.keyboard.press('Escape');
	assert.equal(await page.getByRole('dialog', { name: 'Image viewer', exact: true }).count(), 0);
	passed.push('multiple image import retains its FileList, page navigation and native-dialog Escape work');

	assert.deepEqual(errors, [], `unexpected browser errors: ${errors.join('\n')}`);
	console.log(JSON.stringify({ passed, checks: passed.length }, null, 2));
	await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ passed, checks: passed.length }, null, 2));
} catch (error) {
	await writeFile(path.join(artifacts, 'failure.txt'), String(error?.stack || error));
	throw error;
} finally {
	await browser?.close();
	await server?.close();
	await rm(fixture, { recursive: true, force: true });
}
