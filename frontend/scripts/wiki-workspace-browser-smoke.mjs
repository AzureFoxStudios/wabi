// Real application and isolated backend, rendered in headful Chromium.
// Verify Wiki editing against a disposable Authority.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-wiki-ui-');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const backend = `http://127.0.0.1:${port}`;
const server = spawn(process.env.WABI_SMOKE_SERVER_BINARY || fileURLToPath(new URL('../../target/release/wabi-server', import.meta.url)),
	['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)],
	{ cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser, vite, page;
try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated backend exited: ${scratch}`);
		try { ready = (await fetch(`${backend}/readyz`)).ok; } catch { /* starting */ }
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'isolated backend ready');
	const registration = await fetch(`${backend}/api/auth/register`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: 'wiki_fixture', password: 'Local-mobile-fixture-9825!' })
	});
	assert.equal(registration.status, 200);
	const account = await registration.json();
	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(({ backend, account }) => {
		if (sessionStorage.getItem('privacy-fixture-seeded')) return;
		sessionStorage.setItem('privacy-fixture-seeded', '1');
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });

    await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
    const created = await fetch(`${backend}/api/channels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.accessToken}` },
        body: JSON.stringify({ name: 'wiki_journey', channel_type: 'wiki' })
    });
    assert.equal(created.status, 200);
    const channel = await created.json();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('wiki_journey', { exact: true }).first().click();
    await page.getByRole('button', { name: '+ New Page', exact: true }).click();
    await page.getByPlaceholder('Page title...').fill('Pilot guide');
    await page.getByPlaceholder('Write wiki content in markdown...').fill('Original guide body');
    await page.screenshot({ path: `${scratch}/wiki-create-desktop.png` });
    let creates = 0;
    let releaseCreate;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    await page.route('**/api/wiki/*/pages', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        creates += 1;
        await createGate;
        await route.continue();
    });
    await page.getByRole('button', { name: 'Create', exact: true }).dblclick();
    await page.getByRole('button', { name: 'Creating…', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Creating…', exact: true }).isDisabled(), true);
    releaseCreate();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.wiki-edit-body').fill('Unsaved draft must survive refresh');
    await page.getByRole('button', { name: 'Refresh pages', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    assert.equal(await page.locator('.wiki-edit-body').inputValue(), 'Unsaved draft must survive refresh');
    await page.screenshot({ path: `${scratch}/wiki-draft-refresh.png` });
    await page.route('**/api/wiki/*/pages/*', async route => {
        if (route.request().method() === 'PUT') return route.fulfill({ status: 503, body: 'fixture failure' });
        await route.continue();
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Save failed — your draft is still here', { exact: true }).waitFor();
    assert.equal(await page.locator('.wiki-edit-body').inputValue(), 'Unsaved draft must survive refresh');
    await page.unroute('**/api/wiki/*/pages/*');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.wiki-content-body').filter({ hasText: 'Unsaved draft must survive refresh' }).waitFor();
    assert.equal(creates, 1, 'one create request despite double click');
    const revisionResponse = page.waitForResponse(response => response.url().endsWith('/revisions') && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const revisions = await (await revisionResponse).json();
    assert.ok(revisions.revisions.length > 0, 'saved page has revisions');
    await page.locator('.wiki-drawer-item').first().waitFor();
    assert.equal(await page.locator('.wiki-drawer-item').count(), revisions.revisions.length);
    await page.getByRole('button', { name: 'Close revision history', exact: true }).click();

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('wiki_journey', { exact: true }).first().click();
    await page.getByText('Pilot guide', { exact: true }).first().click();
    await page.locator('.wiki-content-body').filter({ hasText: 'Unsaved draft must survive refresh' }).waitFor();

    const secondResponse = await fetch(`${backend}/api/channels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.accessToken}` },
        body: JSON.stringify({ name: 'wiki_isolated', channel_type: 'wiki' })
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    await page.evaluate(async ({ first, second }) => {
        const { createWikiWorkspace } = await import('/src/lib/wikiStore.ts');
        const read = store => { let value; const stop = store.subscribe(v => { value = v; }); stop(); return value; };
        const a = createWikiWorkspace(), b = createWikiWorkspace();
        const original = window.fetch;
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { started = resolve; });
        let delay = true;
        window.fetch = async (...args) => {
            const response = await original(...args);
            if (delay && String(args[0]).endsWith(`/wiki/${first}/pages`)) {
                delay = false; started(); await gate;
            }
            return response;
        };
        try {
            const stale = a.loadWiki(first);
            await ready;
            await a.loadWiki(second);
            await b.loadWiki(first);
            release(); await stale;
            if (read(a.wikiPagesStore).length !== 0) throw new Error('old channel overwrote current list');
            if (read(b.wikiPagesStore).length !== 1) throw new Error('independent view lost its list');
            await b.loadRevisions(first, read(b.wikiPagesStore)[0].pageId);
            if (read(b.wikiRevisionsStore).length < 1 || read(a.wikiRevisionsStore).length) throw new Error('revision ownership failed');
            a.dispose();
            if (read(b.wikiPagesStore).length !== 1) throw new Error('disposing one view cleared another');
            b.dispose();
            if (read(b.wikiPagesStore).length !== 0) throw new Error('disposed view retained content');
        } finally { release(); window.fetch = original; a.dispose(); b.dispose(); }
    }, { first: channel.id, second: second.id });
    await page.evaluate(async id => {
        const { createWikiWorkspace } = await import('/src/lib/wikiStore.ts');
        const { clearAuthSession } = await import('/src/lib/authSession.ts');
        const read = store => { let value; const stop = store.subscribe(v => { value = v; }); stop(); return value; };
        const view = createWikiWorkspace();
        await view.loadWiki(id);
        if (read(view.wikiPagesStore).length !== 1) throw new Error('logout fixture not loaded');
        const original = window.fetch;
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { started = resolve; });
        window.fetch = async (...args) => {
            const response = await original(...args);
            if (String(args[0]).endsWith(`/wiki/${id}/pages`)) { started(); await gate; }
            return response;
        };
        try {
            const pending = view.loadWiki(id);
            await ready;
            clearAuthSession();
            if (read(view.wikiPagesStore).length) throw new Error('logout retained visible content');
            release(); await pending;
            if (read(view.wikiPagesStore).length || read(view.wikiErrorStore)) throw new Error('late result resurrected logged-out state');
        } finally { release(); window.fetch = original; view.dispose(); }
    }, channel.id);
    assert.deepEqual(errors, []);
    console.log(`PASS Wiki editing, independent stores/revisions, delayed responses and logout; evidence ${scratch}`);

} finally {
    await browser?.close(); await vite?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
    log.end();
}
