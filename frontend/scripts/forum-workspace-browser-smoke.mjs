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
    await page.getByRole('button', { name: 'Quick', exact: true }).click();
    await page.getByPlaceholder('Thread title...').fill('Pilot discussion');
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
    assert.equal(createCount, 1, 'pending submit admits one request');
    assert.deepEqual(errors, []);
    console.log(`PASS Forum failed thread/reply drafts survive and retry succeeds; evidence ${scratch}`);

} finally {
    await browser?.close(); await vite?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
    log.end();
}
