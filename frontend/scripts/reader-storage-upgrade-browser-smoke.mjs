// Actual IndexedDB migration and failure tests in an isolated headful browser.
// A direct Bun bundle avoids Vite, SvelteKit generation and shared dev processes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'wabi-reader-upgrade-'));
let server, browser;
const scope = 'https://reader.example/CasePath|user:7';
const record = (scopeId, documentId, content = 'Original prose') => ({
	v: 1, scopeId, storageId: `${encodeURIComponent(scopeId)}::${documentId}`, storageRevision: 7,
	documentId, kind: 'working-copy', sourceDocKey: `source:${documentId}`, source: 'notes',
	originalTitle: 'Original title', originalContent: content, title: 'Saved title', content,
	format: 'markdown', shareState: 'private', revision: 4, createdAt: 100, updatedAt: 200,
	suggestions: [], comments: []
});
try {
	execFileSync('npm', ['exec', '--yes', '--package=bun@1.3.14', '--', 'bun', 'build', 'src/lib/readerDocuments.ts', '--target', 'browser', '--outfile', join(directory, 'reader.js')], { cwd: root, stdio: 'pipe' });
	const bundle = await readFile(join(directory, 'reader.js'));
	server = createServer((req, res) => {
		res.setHeader('Content-Type', req.url === '/reader.js' ? 'text/javascript' : 'text/html');
		res.end(req.url === '/reader.js' ? bundle : '<!doctype html><title>Reader storage migration test</title><p>Isolated Reader storage checks</p>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
	const pageIn = async context => { const page = await context.newPage(); await page.goto(origin); return page; };
	const load = page => page.evaluate(async () => {
		window.reader = await import('/reader.js');
		window.value = store => { let value; const stop = store.subscribe(next => { value = next; }); stop(); return value; };
	});
	const seed = (page, version, rows, hold = false) => page.evaluate(({ version, rows, hold }) => new Promise((resolve, reject) => {
		const opening = indexedDB.open('wabi-reader-documents', version);
		opening.onupgradeneeded = () => {
			const store = opening.result.createObjectStore('documents', { keyPath: version === 1 ? 'documentId' : 'storageId' });
			if (version === 2) { store.createIndex('scopeId', 'scopeId'); store.createIndex('sourceDocKey', 'sourceDocKey'); }
			for (const row of rows) store.add(row);
		};
		opening.onerror = () => reject(opening.error);
		opening.onsuccess = () => { if (hold) window.blockingDb = opening.result; else opening.result.close(); resolve(); };
	}), { version, rows, hold });

	const first = await browser.newContext();
	const v1 = await pageIn(first);
	const unscoped = { documentId: 'unscoped-v1', title: 'Unclaimed', content: '  exact old prose\n\n', extra: { preserve: true } };
	await seed(v1, 1, [unscoped]);
	await load(v1);
	const firstResult = await v1.evaluate(async scope => {
		await window.reader.activateReaderDocumentScope(scope);
		return { documents: window.value(window.reader.readerDocuments), recovery: JSON.parse(await window.reader.exportReaderRecoverySources()), error: window.value(window.reader.readerStorageError) };
	}, scope);
	assert.deepEqual(firstResult.documents, {}, 'unscoped v1 documents never adopt the active account');
	assert.deepEqual(firstResult.recovery.legacyDocuments, [unscoped], 'v1 legacy records survive unchanged');
	assert.equal(firstResult.error, null);

	const second = await browser.newContext();
	const v2 = await pageIn(second);
	const original = record(scope, 'scoped-v2');
	const other = record('https://other.example|user:7', 'other-account');
	const ambiguous = { ...record('', 'ambiguous'), storageId: 'ambiguous' };
	await seed(v2, 2, [original, other, ambiguous]);
	await load(v2);
	const secondResult = await v2.evaluate(async scope => {
		await window.reader.activateReaderDocumentScope(scope);
		const before = window.value(window.reader.readerDocuments);
		window.reader.updateReaderDocument('scoped-v2', { content: 'New prose after migration' });
		await window.reader.flushReaderDocument('scoped-v2');
		const legacy = await new Promise((resolve, reject) => {
			const opening = indexedDB.open('wabi-reader-documents', 3);
			opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('documents', 'readonly'); const request = tx.objectStore('documents').getAll(); request.onsuccess = () => resolve(request.result); tx.oncomplete = () => db.close(); };
			opening.onerror = () => reject(opening.error);
		});
		return { before, legacy, after: window.value(window.reader.readerDocuments), state: window.value(window.reader.readerDocumentSaveState), recovery: JSON.parse(await window.reader.exportReaderRecoverySources()) };
	}, scope);
	assert.deepEqual(Object.keys(secondResult.before), ['scoped-v2']);
	assert.equal(secondResult.before['scoped-v2'].storageRevision, 7);
	assert.equal(secondResult.after['scoped-v2'].storageRevision, 8);
	assert.equal(secondResult.state['scoped-v2'], 'saved');
	assert.deepEqual(secondResult.legacy.find(row => row.documentId === 'scoped-v2'), original, 'migration and new writes leave legacy source intact');
	assert.equal(secondResult.legacy.length, 3);
	assert.deepEqual(secondResult.recovery.legacyDocuments, [ambiguous], 'only ambiguous or unmigrated own sources need recovery');
	const retryDraft = await v2.evaluate(async () => {
		const originalSet = Storage.prototype.setItem;
		Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
		try {
			window.reader.updateReaderDocument('scoped-v2', { content: 'Runtime-only writing during quota failure' });
			await window.reader.retryReaderDocumentStorage();
			return window.value(window.reader.readerDocuments)['scoped-v2'].content;
		} finally { Storage.prototype.setItem = originalSet; }
	});
	assert.equal(retryDraft, 'Runtime-only writing during quota failure', 'retry cannot replace an unmirrored runtime draft with older durable content');
	await v2.evaluate(async () => { window.reader.updateReaderDocument('scoped-v2', { content: 'New prose after migration' }); await window.reader.flushReaderDocument('scoped-v2'); });

	const isolatedRecovery = await v2.evaluate(async ({ scope, original, other }) => {
		const ownKey = `wabi:reader:document:v2:${encodeURIComponent(scope)}:old-fallback`;
		localStorage.setItem(ownKey, JSON.stringify({ ...original, content: 'Unsafe old fallback', updatedAt: Date.now() + 10000 }));
		await window.reader.retryReaderDocumentStorage();
		const durableContent = window.value(window.reader.readerDocuments)['scoped-v2'].content;
		localStorage.setItem(`wabi:reader:document:v2:${encodeURIComponent(other.scopeId)}:other-fallback`, JSON.stringify(other));
		const sources = JSON.parse(await window.reader.exportReaderRecoverySources());
		const pending = window.reader.exportReaderRecoverySources().then(() => false, error => /account changed/.test(error.message));
		await window.reader.activateReaderDocumentScope(other.scopeId);
		return { ownKey, sources, durableContent, rejected: await pending };
	}, { scope, original, other });
	assert.deepEqual(isolatedRecovery.sources.localSources.map(source => source.key), [isolatedRecovery.ownKey], 'recovery export excludes known other-account local sources');
	assert.equal(isolatedRecovery.durableContent, 'New prose after migration', 'untrusted fallback cannot overlay committed documents');
	assert.equal(isolatedRecovery.rejected, true, 'scope change fences pending recovery export');


	const blocked = await browser.newContext();
	const holding = await pageIn(blocked), waiting = await pageIn(blocked);
	await seed(holding, 2, [original], true);
	await load(waiting);
	const blockedError = await waiting.evaluate(async scope => {
		await window.reader.activateReaderDocumentScope(scope);
		return window.value(window.reader.readerStorageError);
	}, scope);
	assert.match(blockedError, /Close other Wabi windows/);
	await holding.evaluate(() => window.blockingDb.close());
	const retried = await waiting.evaluate(async () => {
		await window.reader.retryReaderDocumentStorage();
		return { docs: window.value(window.reader.readerDocuments), error: window.value(window.reader.readerStorageError) };
	});
	assert.equal(retried.docs['scoped-v2'].content, original.content);
	assert.equal(retried.error, null);
	await waiting.evaluate(() => new Promise((resolve, reject) => {
		const upgrade = indexedDB.open('wabi-reader-documents', 4);
		const timeout = setTimeout(() => reject(new Error('Abandoned late connection blocked the next upgrade')), 3000);
		upgrade.onsuccess = () => { clearTimeout(timeout); upgrade.result.close(); resolve(); };
		upgrade.onerror = () => { clearTimeout(timeout); reject(upgrade.error); };
	}));

	const unavailable = await browser.newContext();
	const failed = await pageIn(unavailable);
	const fallbackKey = `wabi:reader:document:v2:${encodeURIComponent(scope)}:fallback`;
	const fallbackRaw = JSON.stringify({ ...original, documentId: 'fallback' });
	await failed.evaluate(({ fallbackKey, fallbackRaw }) => {
		localStorage.setItem(fallbackKey, fallbackRaw);
		Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
	}, { fallbackKey, fallbackRaw });
	await load(failed);
	const failedResult = await failed.evaluate(async scope => {
		await window.reader.activateReaderDocumentScope(scope);
		const doc = await window.reader.ensureReaderDocument({ id: 'test', docKey: 'test-source', title: 'Unsaved', content: 'Keep this draft', source: 'document', format: 'markdown' });
		await window.reader.activateReaderDocumentScope(scope);
		await window.reader.flushReaderDocument(doc.documentId);
		let discardError = false;
		try { await window.reader.discardReaderDocument(doc.documentId); } catch { discardError = true; }
		return { doc, discardError, documents: window.value(window.reader.readerDocuments), state: window.value(window.reader.readerDocumentSaveState), recovery: JSON.parse(await window.reader.exportReaderRecoverySources()) };
	}, scope);
	assert.equal(failedResult.state[failedResult.doc.documentId], 'error', 'unavailable IndexedDB never yields fallback Saved');
	assert.equal(failedResult.discardError, true);
	assert.equal(failedResult.documents[failedResult.doc.documentId].content, 'Keep this draft', 'failed discard retains runtime writing');
	assert.equal(failedResult.recovery.databaseUnavailable, true);
	assert.equal(failedResult.recovery.localSources.find(source => source.key === fallbackKey).raw, fallbackRaw, 'fallback original remains exact');
	console.log('PASS Reader v1 preservation, v2 scoped migration and post-upgrade write, blocked retry/late connection closure, unavailable storage/recovery and failed discard.');
} finally {
	await browser?.close();
	if (server) await new Promise(resolve => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
