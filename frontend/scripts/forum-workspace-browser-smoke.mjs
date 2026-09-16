// Real application and isolated backend, rendered in headful Chromium.
// Verify Forum submission recovery against a disposable Authority.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-forum-ui-');
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
		body: JSON.stringify({ username: 'forum_fixture', password: 'Local-mobile-fixture-9825!' })
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
        body: JSON.stringify({ name: 'forum_journey', channel_type: 'forum' })
    });
    assert.equal(created.status, 200);
    const channel = await created.json();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('forum_journey', { exact: true }).first().click();
    await page.getByRole('button', { name: 'New thread', exact: true }).click();
    await page.getByPlaceholder('Thread title...').fill('Pilot discussion');
    await page.screenshot({ path: `${scratch}/forum-create.png` });
    await page.locator('.forum-composer-textarea').fill('Preserve this failed thread draft');
    await page.route('**/api/forum/*/threads', async route => {
        if (route.request().method() === 'POST') return route.fulfill({ status: 503, body: 'fixture failure' });
        await route.continue();
    });
    await page.getByRole('button', { name: 'Create Thread', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'draft' }).waitFor();
    assert.equal(await page.locator('.forum-composer-textarea').inputValue(), 'Preserve this failed thread draft');
    assert.equal(await page.getByPlaceholder('Thread title...').inputValue(), 'Pilot discussion');
    await page.unroute('**/api/forum/*/threads');
    let createCount = 0;
    let releaseCreate;
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    await page.route('**/api/forum/*/threads', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        createCount += 1;
        await createGate;
        await route.continue();
    });
    await page.getByRole('button', { name: 'Create Thread', exact: true }).dblclick();
    await page.getByRole('button', { name: 'Posting…', exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('Thread title...').isDisabled(), true);
    releaseCreate();
    await page.locator('.forum-post-detail-title').filter({ hasText: 'Pilot discussion' }).waitFor();
    await page.locator('.forum-composer-textarea').fill('Preserve this failed reply');
    let uploads = 0;
    page.on('request', request => { if (request.url().endsWith('/api/upload/resumable/init')) uploads += 1; });
    await page.locator('.forum-composer input[type=file]').setInputFiles({
        name: 'pilot.png', mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64')
    });
    await page.route('**/api/forum/*/threads/*/posts', async route => {
        if (route.request().method() === 'POST') return route.fulfill({ status: 503, body: 'fixture failure' });
        await route.continue();
    });
    await page.getByRole('button', { name: 'Post Reply', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'draft' }).waitFor();
    assert.equal(await page.locator('.forum-composer-textarea').inputValue(), 'Preserve this failed reply');
    await page.unroute('**/api/forum/*/threads/*/posts');
    await page.getByRole('button', { name: 'Post Reply', exact: true }).click();
    await page.getByText('Preserve this failed reply', { exact: true }).waitFor();
    assert.equal(await page.locator('.forum-composer-textarea').inputValue(), '');
    assert.equal(uploads, 1, 'retry reuses the successful attachment upload');
    await page.screenshot({ path: `${scratch}/forum-saved-reply.png` });
    const reading = await page.locator('.forum-reading-pane').boundingBox();
    assert.ok(reading.width >= 700, 'discussion uses available center-stage width');
    await page.locator('.forum-composer-textarea').fill('Keep this navigation draft');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    assert.equal(await page.locator('.forum-composer-textarea').inputValue(), 'Keep this navigation draft');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.getByText('Pilot discussion', { exact: true }).first().click();
    await page.getByText('Preserve this failed reply', { exact: true }).waitFor();
    assert.equal(await page.locator('.forum-composer-textarea').inputValue(), '', 'accepted discard stays discarded on thread reopen');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Categories', exact: true }).click();
    await page.locator('.forum-category-header').waitFor();
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.getByText('Pilot discussion', { exact: true }).first().click();
    await page.screenshot({ path: `${scratch}/forum-mobile.png` });
    const mobile = await page.locator('.forum-reading-pane').boundingBox();
    assert.ok(mobile.width > 250 && mobile.width <= 390, 'mobile reading fits its workspace');

    await page.setViewportSize({ width: 1440, height: 900 });
    const centerForum = page.locator('.main-content .forum-channel');
    await centerForum.locator('.forum-composer-textarea').fill('Center discussion draft');
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.openRightPanel('forum'); });
    const panelForum = page.locator('.right-panel-embedded .forum-channel');
    await panelForum.getByText('Pilot discussion', { exact: true }).first().click();
    await panelForum.locator('.forum-composer-textarea').fill('Independent panel reply');
    assert.equal(await centerForum.locator('.forum-composer-textarea').inputValue(), 'Center discussion draft');
    await page.screenshot({ path: `${scratch}/forum-two-editors.png` });
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.closeRightPanel(); });
    await panelForum.waitFor({ state: 'hidden' });
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.openRightPanel('forum'); });
    await panelForum.getByText('Pilot discussion', { exact: true }).first().click();
    assert.equal(await panelForum.locator('.forum-composer-textarea').inputValue(), 'Independent panel reply', 'closed panel restores its own draft');
    assert.equal(await centerForum.locator('.forum-composer-textarea').inputValue(), 'Center discussion draft');

    page.once('dialog', dialog => dialog.dismiss());
    await panelForum.getByRole('button', { name: 'Threads', exact: true }).click();
    assert.equal(await panelForum.locator('.forum-composer-textarea').inputValue(), 'Independent panel reply');
    page.once('dialog', dialog => dialog.accept());
    await panelForum.getByRole('button', { name: 'Threads', exact: true }).click();
    assert.equal(await centerForum.locator('.forum-composer-textarea').inputValue(), 'Center discussion draft');
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.closeRightPanel(); });
    await panelForum.waitFor({ state: 'hidden' });
    assert.equal(await centerForum.locator('.forum-composer-textarea').inputValue(), 'Center discussion draft');
    await centerForum.locator('.forum-composer-textarea').fill('');
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.openRightPanel('forum'); });
    await panelForum.getByText('Pilot discussion', { exact: true }).first().click();
    assert.equal(await panelForum.locator('.forum-composer-textarea').inputValue(), '', 'explicit discard removes recovered panel draft');
    await panelForum.locator('.forum-composer-textarea').fill('Pending panel acknowledgement');
    let releasePost, postStarted;
    const postGate = new Promise(resolve => { releasePost = resolve; });
    const postReady = new Promise(resolve => { postStarted = resolve; });
    let pendingPosts = 0;
    await page.route('**/api/forum/*/threads/*/posts', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        pendingPosts += 1; postStarted(); await postGate; await route.continue();
    });
    await panelForum.getByRole('button', { name: 'Post Reply', exact: true }).click();
    await postReady;
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.closeRightPanel(); });
    await panelForum.waitFor({ state: 'hidden' });
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.openRightPanel('forum'); });
    await panelForum.getByText('Pilot discussion', { exact: true }).first().click();
    assert.equal(await panelForum.getByRole('button', { name: 'Posting…', exact: true }).isDisabled(), true);
    releasePost();
    await panelForum.getByRole('button', { name: 'Post Reply', exact: true }).waitFor();
    assert.equal(await panelForum.locator('.forum-composer-textarea').inputValue(), '', 'accepted post settles the remounted draft');
    assert.equal(pendingPosts, 1);
    await page.unroute('**/api/forum/*/threads/*/posts');
    await page.evaluate(async () => { const { layoutStore } = await import('/src/lib/layoutStore.ts'); layoutStore.closeRightPanel(); });
    await panelForum.waitFor({ state: 'hidden' });
    const secondResponse = await fetch(`${backend}/api/channels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.accessToken}` },
        body: JSON.stringify({ name: 'forum_isolated', channel_type: 'forum' })
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    await page.evaluate(async ({ first, second }) => {
        const { createForumWorkspace } = await import('/src/lib/forumStore.ts');
        const read = store => { let value; const stop = store.subscribe(v => { value = v; }); stop(); return value; };
        const a = createForumWorkspace(), b = createForumWorkspace();
        const original = window.fetch;
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { started = resolve; });
        let delay = true;
        window.fetch = async (...args) => {
            const response = await original(...args);
            if (delay && String(args[0]).endsWith(`/forum/${first}/threads`)) {
                delay = false; started(); await gate;
            }
            return response;
        };
        try {
            const stale = a.loadThreads(first);
            await ready;
            await a.loadThreads(second);
            await b.loadThreads(first);
            release(); await stale;
            if (read(a.forumThreadsStore).length !== 0) throw new Error('old channel overwrote current list');
            if (read(b.forumThreadsStore).length !== 1) throw new Error('independent view lost its list');
            a.dispose();
            if (read(b.forumThreadsStore).length !== 1) throw new Error('disposing one view cleared another');
            b.dispose();
            if (read(b.forumThreadsStore).length !== 0) throw new Error('disposed view retained content');
        } finally { release(); window.fetch = original; a.dispose(); b.dispose(); }
    }, { first: channel.id, second: second.id });
    await page.evaluate(async id => {
        const { createForumWorkspace } = await import('/src/lib/forumStore.ts');
        const { clearAuthSession } = await import('/src/lib/authSession.ts');
        const read = store => { let value; const stop = store.subscribe(v => { value = v; }); stop(); return value; };
        const view = createForumWorkspace();
        await view.loadThreads(id);
        if (read(view.forumThreadsStore).length !== 1) throw new Error('logout fixture not loaded');
        const original = window.fetch;
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { started = resolve; });
        window.fetch = async (...args) => {
            const response = await original(...args);
            if (String(args[0]).endsWith(`/forum/${id}/threads`)) { started(); await gate; }
            return response;
        };
        try {
            const pending = view.loadThreads(id);
            await ready;
            clearAuthSession();
            if (read(view.forumThreadsStore).length) throw new Error('logout retained visible content');
            release(); await pending;
            if (read(view.forumThreadsStore).length || read(view.forumErrorStore)) throw new Error('late result resurrected logged-out state');
        } finally { release(); window.fetch = original; view.dispose(); }
    }, channel.id);
    assert.equal(createCount, 1, 'pending submit admits one request');
    assert.deepEqual(errors, []);
    console.log(`PASS Forum recovery, responsive navigation, independent stores, delayed responses and logout; evidence ${scratch}`);

} finally {
    await browser?.close(); await vite?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
    log.end();
}
