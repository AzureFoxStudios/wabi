// Real application and isolated backend. An owner who has a direct message drags a room in the
// sidebar: the server must accept the new order (it refuses any batch that names a conversation).
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
const scratch = await mkdtemp('/tmp/wabi-reorder-ui-');
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
const register = async (username) => {
	const response = await fetch(`${backend}/api/auth/register`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password: 'Local-reorder-fixture-9825!' })
	});
	assert.equal(response.status, 200);
	return response.json();
};
try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated backend exited: ${scratch}`);
		try { ready = (await fetch(`${backend}/readyz`)).ok; } catch { /* starting */ }
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'isolated backend ready');
	const account = await register('reorder_owner');
	const peer = await register('reorder_peer');
	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: process.env.WABI_SMOKE_HEADLESS === '1', executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(20000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (process.env.WABI_SMOKE_VERBOSE && /reorder|socket\]/.test(message.text())) console.log('console:', message.text().slice(0, 200)); });
	await page.addInitScript(({ backend, account }) => {
		window.__socketErrors = [];
		window.addEventListener('wabi-socket-error', event => window.__socketErrors.push(event.detail));
		if (sessionStorage.getItem('reorder-fixture-seeded')) return;
		sessionStorage.setItem('reorder-fixture-seeded', '1');
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });
	await waitForAppShell(page);

	// The direct message joins the same room store the sidebar orders from.
	const conversation = await page.evaluate(async (peer) => {
		const socket = await import('/src/lib/socket.ts');
		const result = await socket.createDM(String(peer.id));
		if (!result.ok) throw new Error(result.error);
		return result.channelId;
	}, peer.user);
	await page.waitForFunction(async (id) => {
		const { channels } = await import('/src/lib/socket.ts');
		let found = false;
		channels.subscribe(list => { found = list.some(channel => channel.id === id); })();
		return found;
	}, conversation);

	const rows = page.locator('[data-drop-anchor="channel"][draggable="true"]');
	await rows.nth(1).waitFor();
	const before = await rows.evaluateAll(list => list.map(row => row.dataset.channelId));
	assert.ok(before.length >= 2, 'two rooms to reorder');
	// Drop the second room on the upper half of the first.
	const target = await rows.nth(0).boundingBox();
	const source = await rows.nth(1).boundingBox();
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
	await page.mouse.down();
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 6, { steps: 4 });
	await page.mouse.move(target.x + target.width / 2, target.y + 4, { steps: 12 });
	await page.waitForTimeout(200);
	await page.mouse.move(target.x + target.width / 2, target.y + 3, { steps: 2 });
	await page.mouse.up();
	await page.waitForTimeout(1500);
	const socketErrors = await page.evaluate(() => window.__socketErrors);
	if (process.env.WABI_SMOKE_VERBOSE) console.log('socket errors', JSON.stringify(socketErrors), 'now', JSON.stringify(await rows.evaluateAll(list => list.map(row => row.dataset.channelId))), 'before', JSON.stringify(before));
	assert.deepEqual(socketErrors, [], 'the server accepted the new order');

	// The order is the server's now: it survives a reload.
	await page.reload({ waitUntil: 'networkidle' });
	await waitForAppShell(page);
	await rows.nth(1).waitFor();
	const after = await rows.evaluateAll(list => list.map(row => row.dataset.channelId));
	assert.deepEqual(after.slice(0, 2), [before[1], before[0]], 'the dragged room moved up and stayed there');
	assert.deepEqual(errors, [], 'no browser exceptions');
	console.log(`PASS a room reorders while a direct message exists; evidence ${scratch}`);
} finally {
	await browser?.close(); await vite?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
