// Real application and isolated backend. A message arrives in a room the owner is not looking
// at; opening that room reads it, so its badge must not come back after leaving.
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
const scratch = await mkdtemp('/tmp/wabi-unread-ui-');
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
		body: JSON.stringify({ username, password: 'Local-unread-fixture-9825!' })
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
	const account = await register('unread_owner');
	const peer = await register('unread_peer');
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
	const seed = ({ backend, who }) => {
		if (sessionStorage.getItem('unread-fixture-seeded')) return;
		sessionStorage.setItem('unread-fixture-seeded', '1');
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, who.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, who.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(who.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	};
	await page.addInitScript(seed, { backend, who: account });
	await page.goto(origin, { waitUntil: 'networkidle' });
	await waitForAppShell(page);
	await page.locator('[data-drop-anchor="channel"][data-channel-id]').first().waitFor();
	// Two ordinary text rooms: the one the owner sits in, and one made for the other person to write in.
	const here = await page.evaluate(async () => {
		const { channels } = await import('/src/lib/socket.ts');
		let all = [];
		channels.subscribe(list => { all = list; })();
		return all.find(channel => channel.type === 'text')?.id;
	});
	const there = await page.evaluate(async () => {
		const { createChannel } = await import('/src/lib/channelStore.ts');
		return createChannel('elsewhere');
	});
	assert.ok(here && there, 'two text rooms');
	await page.locator(`[data-drop-anchor="channel"][data-channel-id="${there}"]`).waitFor();
	// The owner has been in both rooms this session, and is now looking at the first.
	await page.locator(`[data-drop-anchor="channel"][data-channel-id="${there}"]`).click();
	await page.waitForTimeout(800);
	await page.locator(`[data-drop-anchor="channel"][data-channel-id="${here}"]`).click();

	// A second person, in their own browser session, writes in the other room.
	const peerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const peerPage = await peerContext.newPage();
	peerPage.setDefaultTimeout(20000);
	await peerPage.addInitScript(seed, { backend, who: peer });
	await peerPage.goto(origin, { waitUntil: 'networkidle' });
	await waitForAppShell(peerPage);
	const say = (text) => peerPage.evaluate(async ({ there, text }) => {
		const socket = await import('/src/lib/socket.ts');
		socket.switchChannel(there);
		await new Promise(resolve => setTimeout(resolve, 600));
		const result = await socket.sendMessage(there, text);
		if (!result.ok) throw new Error(`send failed: ${result.reason}`);
	}, { there, text });
	const unreadCount = (id) => page.evaluate(async (id) => {
		const { channelUnreadCounts } = await import('/src/lib/messageStore.ts');
		let value = 0;
		channelUnreadCounts.subscribe(counts => { value = counts[id] || 0; })();
		return value;
	}, id);
	const badge = (id) => page.locator(`[data-drop-anchor="channel"][data-channel-id="${id}"] .w-badge`);

	await say('first while away');
	await say('second while away');
	await badge(there).waitFor();
	assert.equal(await unreadCount(there), 2, 'two messages counted while looking elsewhere');

	// Open the room: both messages are there, with the divider above the first of them.
	await page.locator(`[data-drop-anchor="channel"][data-channel-id="${there}"]`).click();
	await page.getByText('second while away').first().waitFor();
	await page.waitForFunction(async (id) => {
		const { channelUnreadCounts } = await import('/src/lib/messageStore.ts');
		let value = 1;
		channelUnreadCounts.subscribe(counts => { value = counts[id] || 0; })();
		return value === 0;
	}, there);
	const divider = await page.evaluate(async (id) => {
		const { channelFirstUnread, channelMessages } = await import('/src/lib/messageStore.ts');
		let mark = null; let first = null;
		channelFirstUnread.subscribe(marks => { mark = marks[id] ?? null; })();
		channelMessages.subscribe(all => { first = (all[id] || []).find(message => (message.text ?? message.content) === 'first while away')?.id ?? null; })();
		return { mark, first };
	}, there);
	assert.ok(divider.first, 'the first message is in the room');
	assert.equal(divider.mark, divider.first, 'the divider sits at the first unread message, not the latest');

	// Leave again: the badge stays gone, which it did not before.
	await page.locator(`[data-drop-anchor="channel"][data-channel-id="${here}"]`).click();
	await page.waitForTimeout(800);
	assert.equal(await unreadCount(there), 0, 'the room stays read after leaving it');
	assert.equal(await badge(there).count(), 0, 'no badge comes back');

	// And a new message after that is counted afresh.
	await say('third, later');
	await badge(there).waitFor();
	assert.equal(await unreadCount(there), 1, 'a later message is one new unread');
	assert.deepEqual(errors, [], 'no browser exceptions');
	console.log(`PASS opening a room reads it and the badge does not return; evidence ${scratch}`);
} finally {
	await browser?.close(); await vite?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
