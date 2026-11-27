// Real application and isolated backend. The first account is the owner: open the admin
// panel from the Welcome page, visit every section and fail on any browser exception.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { waitForAppShell } from './smoke-shell.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-admin-ui-');
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
		body: JSON.stringify({ username: 'admin_panel_owner', password: 'Local-admin-fixture-9825!' })
	});
	assert.equal(registration.status, 200);
	const account = await registration.json();
	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	// WABI_SMOKE_BUILT=1 checks the production bundle as the server itself serves it.
	let origin = backend;
	if (process.env.WABI_SMOKE_BUILT !== '1') {
		vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
		await vite.listen();
		origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	}
	browser = await chromium.launch({ headless: process.env.WABI_SMOKE_HEADLESS === '1', executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(20000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error' && process.env.WABI_SMOKE_VERBOSE) console.log('console.error:', message.text().slice(0, 300)); });
	await page.addInitScript(({ backend, account }) => {
		if (sessionStorage.getItem('admin-fixture-seeded')) return;
		sessionStorage.setItem('admin-fixture-seeded', '1');
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });
	await waitForAppShell(page);

	try {
		await page.getByRole('button', { name: 'Manage server', exact: true }).click();
		await page.locator('.admin-center-stage').waitFor();
	} catch (error) {
		await page.screenshot({ path: `${scratch}/admin-did-not-open.png` });
		throw new Error(`admin panel did not open (${error.message.split('\n')[0]}); page errors: ${JSON.stringify(errors)}; evidence ${scratch}`);
	}
	const count = await page.locator('.admin-nav-item').count();
	assert.ok(count >= 8, `owner sees the admin sections (saw ${count})`);
	const visited = [];
	for (let index = 0; index < count; index++) {
		const item = page.locator('.admin-nav-item').nth(index);
		const label = (await item.innerText()).trim();
		assert.doesNotMatch(label, /admin_nav\.|undefined/, 'section has a real name');
		await item.click();
		await page.locator('.admin-nav-item.admin-nav-active').filter({ hasText: label }).waitFor();
		await page.waitForTimeout(600);
		assert.ok(await page.locator('.admin-center-stage').isVisible(), `${label} keeps the admin panel mounted`);
		assert.ok((await page.locator('.admin-content-inner').innerText()).trim().length > 0, `${label} renders content`);
		assert.deepEqual(errors, [], `no browser exceptions in ${label}`);
		visited.push(label);
	}
	await page.screenshot({ path: `${scratch}/admin-panel.png` });
	await page.locator('.admin-back-btn').click();
	await page.locator('.admin-center-stage').waitFor({ state: 'detached' });
	// The second way in: Settings, then a destination on its Admin page.
	await page.getByRole('button', { name: 'Server settings', exact: true }).click();
	await page.getByText('Admin', { exact: true }).first().click();
	await page.locator('.admin-destination').first().click();
	try {
		await page.locator('.admin-center-stage').waitFor();
		const top = await page.evaluate(() => {
			const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
			return Boolean(el?.closest('.admin-center-stage'));
		});
		assert.ok(top, 'nothing covers the admin panel after Settings closes');
	} catch (error) {
		await page.screenshot({ path: `${scratch}/admin-from-settings.png` });
		throw new Error(`admin panel did not open from Settings (${error.message.split('\n')[0]}); page errors: ${JSON.stringify(errors)}; evidence ${scratch}`);
	}
	assert.deepEqual(errors, [], 'no browser exceptions from Settings');
	console.log(`PASS admin panel opens for the owner; sections: ${visited.join(', ')}; evidence ${scratch}`);
} finally {
	await browser?.close(); await vite?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
