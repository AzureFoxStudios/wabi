import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(frontend, '.reader-documents-smoke-'));
const artifacts = process.env.READER_ARTIFACT_DIR || path.join(tmpdir(), 'wabi-reader-artifacts');
await mkdir(artifacts, { recursive: true });
const file = (relative) => JSON.stringify(path.join(fixture, relative));
let server;
let browser;

try {
	for (const relative of [
		'src/lib/components/ReaderTab.svelte',
		'src/lib/components/ReaderDocumentWorkbench.svelte',
		'src/lib/components/ReaderTabImpl.svelte',
		'src/lib/components/ReaderImportSheet.svelte',
		'src/lib/components/ReaderIcon.svelte',
		'src/lib/components/readerTabHelpers.ts',
		'src/lib/components/readerDocumentTools.ts',
		'src/lib/components/readerCode.css',
		'src/lib/readerWorkspace.ts',
		'src/lib/readerDocuments.ts',
		'src/lib/readerLibrary.ts',
		'src/lib/readerCode.ts',
		'src/lib/prism.ts',
		'src/styles/components/reader-tab.css'
	]) {
		await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
		await copyFile(path.join(frontend, relative), path.join(fixture, relative));
	}

	await writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
		target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', skipLibCheck: true
	} }));
	await writeFile(path.join(fixture, 'environment.js'), 'export const browser = true; export const dev = true; export const building = false;');
	await writeFile(path.join(fixture, 'tabQueue.js'), 'export const mobileTabQueue = { openAddonTab() {} };');
	await writeFile(path.join(fixture, 'channelStore.js'), `import { writable } from 'svelte/store'; export const currentChannel = writable('general'); export const channels = writable([]);`);
	await writeFile(path.join(fixture, 'loreWorkspace.js'), 'export const openLoreSurface = () => {};');
	await writeFile(path.join(fixture, 'main.js'), `
		import { mount } from 'svelte';
		import { get } from 'svelte/store';
		import Reader from ${file('src/lib/components/ReaderTab.svelte')};
		import ${file('src/styles/components/reader-tab.css')};
		import { openReaderDocument, readerSelection, updateReaderPreferences } from ${file('src/lib/readerWorkspace.ts')};
		import { readerDocuments, readerDocumentSaveState } from ${file('src/lib/readerDocuments.ts')};
		updateReaderPreferences({ theme: 'paper', fontSize: 18 });
		mount(Reader, { target: document.getElementById('app') });
		openReaderDocument('Class notes', '# Lesson\\n\\nOriginal line for Timmy.', 'markdown', 'chat');
		window.readerDocTest = {
			state() {
				const selection = get(readerSelection);
				const docs = get(readerDocuments);
				const doc = Object.values(docs)[0] || null;
				return { selection, doc, save: doc ? get(readerDocumentSaveState)[doc.documentId] : null };
			}
		};
	`);
	await writeFile(path.join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
		html,body,#app{height:100%;width:100%;margin:0} body{background:#101221;font-family:system-ui}
		:root{--text-secondary:#d8dbea;--surface-base:#e7e1d2;--text-warning:#ffcc44;--font-sans:system-ui;--accent:#7774e7}
	</style></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>`);

	server = await createServer({
		configFile: false,
		root: fixture,
		plugins: [svelte({ configFile: false })],
		resolve: { dedupe: ['svelte'], alias: [
			{ find: '$app/environment', replacement: path.join(fixture, 'environment.js') },
			{ find: '$lib/mobileTabQueue', replacement: path.join(fixture, 'tabQueue.js') },
			{ find: '$lib/channelStore', replacement: path.join(fixture, 'channelStore.js') },
			{ find: '$lib/loreWorkspace', replacement: path.join(fixture, 'loreWorkspace.js') },
			{ find: '$lib', replacement: path.join(fixture, 'src/lib') }
		] },
		optimizeDeps: { rolldownOptions: { tsconfig: false } },
		server: { host: '127.0.0.1', port: 0, fs: { allow: [frontend] } },
		logLevel: 'warn'
	});
	await server.listen();
	const origin = server.resolvedUrls.local[0];
	browser = await chromium.launch({ headless: false, executablePath: process.env.READER_CHROMIUM_PATH, args: ['--no-sandbox'] });
	const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark', reducedMotion: 'reduce' });
	await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
	const page = await context.newPage();
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await page.goto(origin);
	await page.waitForFunction(() => !!window.readerDocTest);
	await page.getByRole('heading', { name: 'Lesson', exact: true }).waitFor();

	assert.match(await page.locator('.reader-document-bar').innerText(), /Source unchanged/);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByLabel('Document content').waitFor();
	let state = await page.evaluate(() => window.readerDocTest.state());
	assert.equal(state.doc.kind, 'working-copy');
	assert.equal(state.doc.shareState, 'private');
	assert.equal(state.doc.originalContent, '# Lesson\n\nOriginal line for Timmy.');

	await page.getByLabel('Document content').fill('# Lesson\n\nEdited locally for Timmy.');
	await page.waitForFunction(() => document.querySelector('.reader-document-body')?.textContent?.includes('Edited locally for Timmy.'));
	await page.waitForTimeout(300);
	state = await page.evaluate(() => window.readerDocTest.state());
	assert.match(state.doc.content, /Edited locally/);
	assert.equal(state.doc.originalContent, '# Lesson\n\nOriginal line for Timmy.');
	assert.equal(state.save, 'saved');
	await page.screenshot({ path: path.join(artifacts, 'reader-documents-edit.png'), animations: 'disabled' });

	// A reload reopens the source but the local draft must still be discoverable.
	await page.reload();
	await page.waitForFunction(() => !!window.readerDocTest);
	await page.getByRole('heading', { name: 'Lesson', exact: true }).waitFor();
	await page.waitForTimeout(150);
	assert.match(await page.locator('.reader-document-bar').innerText(), /Local draft/);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	assert.match(await page.getByLabel('Document content').inputValue(), /Edited locally/);

	await page.getByRole('button', { name: 'Read', exact: true }).click();
	await page.getByRole('button', { name: 'Save as Wabi Document', exact: true }).click();
	await page.waitForTimeout(120);
	state = await page.evaluate(() => window.readerDocTest.state());
	assert.equal(state.doc.kind, 'native');
	assert.equal(state.selection.source, 'document');
	assert.equal(state.selection.documentId, state.doc.documentId);

	await page.getByRole('button', { name: /^Suggest/ }).click();
	await page.getByLabel('Document content').fill('# Lesson\n\nProposed wording only.');
	await page.waitForFunction(() => document.querySelector('.reader-document-body')?.textContent?.includes('Proposed wording only.'));
	state = await page.evaluate(() => window.readerDocTest.state());
	assert.match(state.doc.content, /Edited locally/);
	assert.equal(state.doc.suggestions.filter((item) => item.status === 'open').length, 1);
	await page.locator('.reader-suggestion-actions').getByRole('button', { name: 'Reject', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.reader-document-body')?.textContent?.includes('Edited locally for Timmy.'));

	await page.getByRole('button', { name: /^Comment/ }).click();
	await page.getByPlaceholder('Add a comment about this document…').fill('Ask Timmy why this line changed.');
	await page.getByRole('button', { name: 'Add comment', exact: true }).click();
	assert.match(await page.locator('.reader-comments-pane').innerText(), /Ask Timmy why this line changed/);
	await page.getByRole('button', { name: 'Resolve', exact: true }).click();
	assert.match(await page.locator('.reader-comments-pane').innerText(), /Resolved/);

	await page.getByRole('button', { name: 'Read', exact: true }).click();
	await context.setOffline(true);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByLabel('Document content').fill('# Lesson\n\nStill editable with no network.');
	await page.waitForTimeout(300);
	assert.match(await page.locator('.reader-document-bar').innerText(), /Offline/);
	state = await page.evaluate(() => window.readerDocTest.state());
	assert.match(state.doc.content, /Still editable with no network/);
	assert.equal(state.save, 'saved');
	await context.setOffline(false);

	await page.getByRole('button', { name: 'Share', exact: true }).click();
	assert.match(await page.locator('.reader-remote-notice').innerText(), /Nothing was uploaded or exposed|replication transport/);
	state = await page.evaluate(() => window.readerDocTest.state());
	assert.equal(state.doc.shareState, 'private');

	await page.getByRole('button', { name: /^Documents/ }).click();
	assert.equal(await page.locator('.reader-document-row').count(), 1);
	assert.equal(pageErrors.length, 0, `browser errors: ${pageErrors.join(' | ')}`);

	console.log('reader documents browser smoke passed');
} finally {
	if (browser) await browser.close().catch(() => {});
	if (server) await server.close().catch(() => {});
	await rm(fixture, { recursive: true, force: true }).catch(() => {});
}
