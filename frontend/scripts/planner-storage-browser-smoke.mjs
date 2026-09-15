// Real IndexedDB transactions in disposable headful browser pages; no Vite/live data.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'wabi-planner-storage-'));
let server, browser;
const data = title => ({ todos: [{ id: '1', title, status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: '1' }], calendarEvents: [], diaryEntries: [], projects: [], sprints: [], kanbanColumns: [], resources: [], tags: [], graphEdges: [] });
try {
	await writeFile(join(scratch, 'entry.ts'), `export { plannerPersistence } from '${root}src/lib/business/persistence.ts';\nexport { PlannerSession } from '${root}src/lib/business/session.ts';`);
	execFileSync('npm', ['exec', '--yes', '--package=bun@1.3.14', '--', 'bun', 'build', join(scratch, 'entry.ts'), '--target', 'browser', '--outfile', join(scratch, 'planner.js')], { cwd: root, stdio: 'pipe' });
	const bundle = await readFile(join(scratch, 'planner.js'));
	server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/planner.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/planner.js' ? bundle : '<!doctype html><title>Planner storage test</title>Planner storage fixture'); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
	const context = await browser.newContext();
	const open = async () => { const page = await context.newPage(); await page.goto(origin); await page.evaluate(async () => { window.mod = await import('/planner.js'); }); return page; };
	const a = await open(), b = await open();
	const scope = 'planner:v1:https%3A%2F%2Fa.test:account:1';
	const other = 'planner:v1:https%3A%2F%2Fb.test:account:1';
	assert.equal(await a.evaluate(scope => window.mod.plannerPersistence.read(scope), scope), null);
	await a.evaluate(({ scope, data }) => window.mod.plannerPersistence.write(scope, 0, data, 'initial'), { scope, data: data('Original') });
	assert.equal(await b.evaluate(scope => window.mod.plannerPersistence.read(scope), other), null);
	const revisions = await Promise.all([a, b].map(page => page.evaluate(async scope => (await window.mod.plannerPersistence.read(scope)).revision, scope)));
	assert.deepEqual(revisions, [1, 1]);
	const writes = await Promise.all([a, b].map((page, i) => page.evaluate(async ({ scope, revision, data, id }) => {
		try { await window.mod.plannerPersistence.write(scope, revision, data, id); return 'saved'; }
		catch (error) { if (!error.message.includes('another window')) throw error; return 'conflict'; }
	}, { scope, revision: revisions[i], data: data(i === 0 ? 'A wins or recovers' : 'B wins or recovers'), id: `writer-${i}` })));
	assert.deepEqual(writes.toSorted(), ['conflict', 'saved']);
	const winner = await a.evaluate(scope => window.mod.plannerPersistence.read(scope), scope);
	const drafts = await b.evaluate(scope => window.mod.plannerPersistence.drafts(scope), scope);
	assert.equal(drafts.length, 1); assert.notEqual(drafts[0].data.todos[0].title, winner.data.todos[0].title);
	assert.deepEqual(await b.evaluate(scope => window.mod.plannerPersistence.drafts(scope), other), []);
	const rejected = await b.evaluate(async ({ scope, data }) => {
		try { await window.mod.plannerPersistence.write(scope, 1, data, 'retry'); return false; }
		catch { return true; }
	}, { scope, data: data('Stale retry') });
	assert.equal(rejected, true);
	await a.reload();
	await a.evaluate(async () => { window.mod = await import('/planner.js'); });
	assert.deepEqual(await a.evaluate(scope => window.mod.plannerPersistence.read(scope), scope), winner);
	// A real transaction abort cannot publish a partially completed save.
	const aborted = await a.evaluate(async ({ scope, data }) => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function(...args) { const request = original.apply(this, args); this.transaction.abort(); return request; };
		try {
			await window.mod.plannerPersistence.write(scope, 2, data, 'aborted'); return false;
		} catch { return true; } finally { IDBObjectStore.prototype.put = original; }
	}, { scope, data: data('Aborted data') });
	assert.equal(aborted, true);
	assert.deepEqual(await a.evaluate(scope => window.mod.plannerPersistence.read(scope), scope), winner);
	// Actual failed session save preserves the complete retryable draft.
	const retained = await b.evaluate(async ({ scope, data }) => {
		const { PlannerSession, plannerPersistence } = window.mod;
		const record = await plannerPersistence.read(scope);
		const session = new PlannerSession(scope, record.data, record.revision, plannerPersistence, () => {});
		session.edit(data);
		const original = indexedDB.open.bind(indexedDB);
		indexedDB.open = () => { throw new DOMException('Device storage unavailable', 'QuotaExceededError'); };
		let failed;
		try { failed = await session.flush(); } finally { indexedDB.open = original; }
		const before = { dirty: session.dirty, data: session.data, error: session.error };
		const retry = await session.flush();
		return { failed, before, retry, dirty: session.dirty };
	}, { scope, data: data('Retained after storage failure') });
	assert.equal(retained.failed, false); assert.equal(retained.before.dirty, true);
	assert.deepEqual(retained.before.data, data('Retained after storage failure'));
	assert.ok(retained.before.error); assert.equal(retained.retry, true); assert.equal(retained.dirty, false);
	console.log('PASS Planner IndexedDB isolation, competing writes, recovery, reload, abort atomicity and failed-save retry');
} finally {
	await browser?.close();
	if (server) await new Promise(resolve => server.close(resolve));
	await rm(scratch, { recursive: true, force: true });
}
