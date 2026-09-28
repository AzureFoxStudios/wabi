// Disposable two-account browser proof for Authority-backed conversation notes.
// Never run against a live Authority or an existing data directory.
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { io } from 'socket.io-client';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dependencyRoot = await realpath(`${frontendRoot}/node_modules`).catch(() => frontendRoot);
const scratch = await mkdtemp('/tmp/wabi-shared-notes-');
console.log(`Disposable shared-note artifacts: ${scratch}`);
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const binary = process.env.WABI_DM_TEST_BINARY || fileURLToPath(new URL('../../target/debug/wabi-server', import.meta.url));
const server = spawn(binary, ['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)], {
	cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
let vite;
let browser;
const sockets = [];

async function api(path, method = 'GET', body, token, expected = 200) {
	const response = await fetch(`${origin}${path}`, {
		method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const value = await response.json().catch(() => null);
	assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
	return value;
}

function event(socket, name, predicate = () => true, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`Timed out waiting for ${name}`)); }, timeoutMs);
		const receive = (payload) => {
			if (!predicate(payload)) return;
			clearTimeout(timer); socket.off(name, receive); resolve(payload);
		};
		socket.on(name, receive);
	});
}

async function connect(account) {
	const socket = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], auth: { token: account.accessToken } });
	sockets.push(socket);
	const diagnostics = [];
	socket.on('connect_error', (error) => diagnostics.push(`connect_error: ${error.message}`));
	socket.on('auth-required', (payload) => diagnostics.push(`auth-required: ${JSON.stringify(payload)}`));
	socket.on('auth-failed', (payload) => diagnostics.push(`auth-failed: ${JSON.stringify(payload)}`));
	const initialized = event(socket, 'init', () => true, 60000);
	let joinRetry;
	socket.on('connect', () => {
		// The client connect event can race the Authority's registration of
		// its join handler. Retry only until the first init is observed.
		socket.emit('join', account.user.username);
		joinRetry = setInterval(() => socket.emit('join', account.user.username), 500);
	});
	socket.connect();
	try {
		await initialized;
		return socket;
	} catch (error) {
		throw new Error(`${error.message}; connected=${socket.connected}; id=${socket.id}; diagnostics=${JSON.stringify(diagnostics)}`);
	} finally {
		if (joinRetry) clearInterval(joinRetry);
	}
}

try {
	let ready = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (server.exitCode !== null) throw new Error(`Disposable Authority exited: ${serverLog.join('')}`);
		try { ready = (await fetch(`${origin}/readyz`)).ok; } catch { /* booting */ }
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'disposable Authority is ready');
	const alice = await api('/api/auth/register', 'POST', { username: 'notes_alice', password: 'Disposable-notes-9825!' });
	const bob = await api('/api/auth/register', 'POST', { username: 'notes_bob', password: 'Disposable-notes-9825!' });
	const outsider = await api('/api/auth/register', 'POST', { username: 'notes_outsider', password: 'Disposable-notes-9825!' });
	const creator = await connect(alice);
	await connect(bob);
	const created = event(creator, 'dm-created', (row) => row.otherUser?.id === `user-${bob.user.id}`);
	creator.emit('create-dm', { targetUserId: `user-${bob.user.id}` });
	const dm = await created;
	const channelId = dm.channelId;
	const path = `/api/conversation-notes/${encodeURIComponent(channelId)}`;
	await api(path, 'POST', { content: JSON.stringify({ title: 'Leak', text: 'pending plaintext' }) }, alice.accessToken, 403);
	await api(path, 'GET', null, outsider.accessToken, 403);

	process.env.VITE_SOCKET_URL = origin;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root: frontendRoot, server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [projectRoot, dependencyRoot] } } });
	await vite.listen();
	const app = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, ...(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {}) });

	async function openApp(account, mobile = false) {
		const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 860 }, isMobile: mobile, hasTouch: mobile });
		await context.addInitScript(({ serverUrl, login }) => {
			const scope = encodeURIComponent(serverUrl);
			sessionStorage.setItem(`wabi_auth_token:${scope}`, login.accessToken);
			localStorage.setItem(`wabi_username:${scope}`, login.user.username);
			localStorage.setItem(`wabi_db_user_id:${scope}`, String(login.user.id));
			localStorage.setItem('notificationsEnabled', 'false');
		}, { serverUrl: origin, login: account });
		const page = await context.newPage();
		page.setDefaultTimeout(30000);
		await page.goto(app, { waitUntil: 'domcontentloaded' });
		await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
		await page.waitForFunction(async (id) => {
			const { channels } = await import('/src/lib/channelStore.ts');
			let state; channels.subscribe((value) => { state = value; })();
			return state?.some((channel) => channel.id === id);
		}, channelId);
		await page.evaluate(async (id) => {
			const { layoutStore } = await import('/src/lib/layoutStore.ts');
			layoutStore.openCenterDm(id, null);
		}, channelId);
		await page.locator('.dm-conversation').waitFor({ state: 'visible' });
		return page;
	}

	const alicePage = await openApp(alice);
	const bobPage = await openApp(bob, true);
	for (const page of [alicePage, bobPage]) await page.locator('.dm-conversation .dm-header-pill-secure').waitFor({ state: 'visible', timeout: 45000 });
	await alicePage.locator('.dm-notes-action').click();
	await bobPage.locator('.dm-notes-action').click();
	await alicePage.getByRole('button', { name: 'New note' }).click();
	await alicePage.getByRole('textbox', { name: 'Shared note title' }).fill('Our special note');
	await alicePage.getByRole('textbox', { name: 'Shared note text' }).fill('The recipient should see this after the save and after reload.');
	await alicePage.locator('.shared-notes .save-state').getByText('Unsaved changes').waitFor();
	await alicePage.getByRole('button', { name: 'Share note' }).click();
	await alicePage.getByRole('status').getByText('Saved for everyone').first().waitFor();
	await bobPage.locator('.shared-notes .note-row').getByText('Our special note').waitFor({ state: 'visible' });
	await bobPage.locator('.shared-notes .note-row').getByText('Our special note').click();
	assert.equal(await bobPage.getByRole('textbox', { name: 'Shared note text' }).inputValue(), 'The recipient should see this after the save and after reload.');
	assert.equal(await bobPage.getByRole('textbox', { name: 'Shared note text' }).getAttribute('readonly'), '', 'recipient cannot edit author note');
	const saved = await api(path, 'GET', null, alice.accessToken);
	assert.equal(saved.notes.length, 1);
	assert.equal(saved.notes[0].encrypted, true, 'encrypted room stores an encrypted note');
	assert.match(saved.notes[0].content, /^wabi-e2ee-v1:/);
	assert.ok(!saved.notes[0].content.includes('Our special note'), 'Authority note store contains no plaintext title');
	await alicePage.screenshot({ path: `${scratch}/shared-note-author-desktop.png` });
	await bobPage.screenshot({ path: `${scratch}/shared-note-recipient-phone.png` });

	await bobPage.reload({ waitUntil: 'domcontentloaded' });
	await bobPage.locator('.workspace-trigger').waitFor({ timeout: 60000 });
	await bobPage.evaluate(async (id) => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.openCenterDm(id, null);
	}, channelId);
	await bobPage.locator('.dm-notes-action').click();
	await bobPage.locator('.shared-notes .note-row').getByText('Our special note').waitFor({ state: 'visible' });
	await bobPage.locator('.shared-notes .note-row').getByText('Our special note').click();
	assert.equal(await bobPage.getByRole('textbox', { name: 'Shared note text' }).inputValue(), 'The recipient should see this after the save and after reload.', 'recipient sees shared note after reload');

	// A second conversation may replace the entire notes component. A draft
	// remains unsent and available in page memory when returning to this DM.
	await alicePage.getByRole('button', { name: 'New note' }).click();
	await alicePage.getByRole('textbox', { name: 'Shared note title' }).fill('Unsent draft');
	await alicePage.getByRole('textbox', { name: 'Shared note text' }).fill('Still only on this device');
	const secondCreated = event(creator, 'dm-created', (row) => row.otherUser?.id === `user-${outsider.user.id}`);
	creator.emit('create-dm', { targetUserId: `user-${outsider.user.id}` });
	const secondDm = await secondCreated;
	await alicePage.evaluate(async (id) => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.openCenterDm(id, null);
	}, secondDm.channelId);
	await alicePage.locator('.dm-header-name').getByText('notes_outsider', { exact: true }).waitFor();
	await alicePage.evaluate(async (id) => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.openCenterDm(id, null);
	}, channelId);
	await alicePage.locator('.dm-header-name').getByText('notes_bob', { exact: true }).waitFor();
	await alicePage.locator('.dm-notes-action').click();
	assert.equal(await alicePage.getByRole('textbox', { name: 'Shared note title' }).inputValue(), 'Unsent draft', 'unsaved draft survives conversation switch');
	assert.equal(await alicePage.getByRole('textbox', { name: 'Shared note text' }).inputValue(), 'Still only on this device');
	await alicePage.locator('.shared-notes .save-state').getByText('Unsaved changes').waitFor();
	assert.equal((await api(path, 'GET', null, alice.accessToken)).notes.length, 1, 'unsaved draft never reached Authority');
	console.log(`PASS: encrypted note shared live with second account and visible after phone reload (${scratch})`);
} finally {
	for (const socket of sockets) socket.disconnect();
	if (browser) await browser.close().catch(() => {});
	if (vite) await vite.close().catch(() => {});
	server.kill('SIGTERM');
}
