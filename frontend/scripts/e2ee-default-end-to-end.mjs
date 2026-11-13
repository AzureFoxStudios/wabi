// Disposable two-account proof for the experimental new-room encryption default.
// Never point this at a live Authority or an existing data directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { io } from 'socket.io-client';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { openDmConversation, waitForAppShell } from './smoke-shell.mjs';
import { saveOpenAdmission } from './smoke-admission.mjs';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dependencyRoot = await realpath(`${frontendRoot}/node_modules`).catch(() => frontendRoot);
const scratch = await mkdtemp('/tmp/wabi-e2ee-default-');
console.log(`Disposable E2EE artifacts: ${scratch}`);
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const binary = process.env.WABI_DM_TEST_BINARY || fileURLToPath(new URL('../../target/debug/wabi-server', import.meta.url));
saveOpenAdmission(`${scratch}/data`); // registers members directly; no saved policy means invite only
const server = spawn(binary, ['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)], {
	cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe']
});
const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
const sockets = [];
let vite;
let browser;

function event(socket, name, predicate = () => true, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`Timed out waiting for ${name}`)); }, timeoutMs);
		const receive = (payload) => {
			if (!predicate(payload)) return;
			clearTimeout(timer);
			socket.off(name, receive);
			resolve(payload);
		};
		socket.on(name, receive);
	});
}

async function api(path, method, body, token) {
	const response = await fetch(`${origin}${path}`, {
		method,
		headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
		...(body ? { body: JSON.stringify(body) } : {})
	});
	const data = await response.json().catch(() => null);
	assert.equal(response.status, 200, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
	return data;
}

async function connect(account) {
	const socket = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], auth: { token: account.accessToken } });
	sockets.push(socket);
	const initialized = event(socket, 'init');
	socket.on('connect', () => socket.emit('join', account.user.username));
	socket.connect();
	await initialized;
	return socket;
}

try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Authority exited: ${serverLog.join('')}`);
		try { ready = (await fetch(`${origin}/readyz`)).ok; } catch { /* booting */ }
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'disposable Authority is ready');
	const alice = await api('/api/auth/register', 'POST', { username: 'e2ee_alice', password: 'Disposable-e2ee-9825!' });
	const bob = await api('/api/auth/register', 'POST', { username: 'e2ee_bob', password: 'Disposable-e2ee-9825!' });
	const charlie = await api('/api/auth/register', 'POST', { username: 'e2ee_charlie', password: 'Disposable-e2ee-9825!' });
	const david = await api('/api/auth/register', 'POST', { username: 'e2ee_david', password: 'Disposable-e2ee-9825!' });
	const aliceSocket = await connect(alice);
	await connect(bob);

	process.env.VITE_SOCKET_URL = origin;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root: frontendRoot, server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [projectRoot, dependencyRoot] } } });
	await vite.listen();
	const app = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, ...(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {}) });

	async function openApp(account, channelId) {
		const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
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
		await waitForAppShell(page);
		if (!channelId) return page;
		await page.waitForFunction(async (id) => {
			const { channels } = await import('/src/lib/channelStore.ts');
			let state;
			channels.subscribe((value) => { state = value; })();
			return state?.some((channel) => channel.id === id);
		}, channelId);
		await openDmConversation(page, channelId);
		return page;
	}

	async function assertHubPreviewHidesContent(page, channelId, plaintexts) {
		const preview = page.locator(`.dm-hub-conversation[data-dm-channel-id="${channelId}"] .dm-hub-preview`);
		await preview.getByText('Open to read the latest message', { exact: true }).waitFor();
		const text = await preview.innerText();
		assert.ok(!text.includes('wabi-e2ee-v1:'), 'hub preview does not show the envelope');
		for (const plaintext of plaintexts) assert.ok(!text.includes(plaintext), 'hub preview does not show decrypted text');
	}

	async function assertCiphertext(channelId, account, plaintexts) {
		const history = await api(`/api/messages/${channelId}`, 'GET', null, account.accessToken);
		assert.equal(history.messages.length, plaintexts.length, 'both messages reached durable history');
		for (const row of history.messages) {
			assert.match(row.content, /^wabi-e2ee-v1:/, 'Authority stores an E2EE envelope');
			for (const text of plaintexts) assert.ok(!row.content.includes(text), 'Authority history does not contain plaintext');
		}
	}

	const groupRequestId = crypto.randomUUID();
	const groupAck = event(aliceSocket, 'group-operation-result', (reply) => reply.requestId === groupRequestId);
	aliceSocket.emit('create-group', { requestId: groupRequestId, groupName: 'Encrypted pilot group', userIds: [`user-${bob.user.id}`] });
	const group = await groupAck;
	assert.equal(group.ok, true, `group creation: ${JSON.stringify(group)}`);
	assert.equal((await api(`/api/e2ee/channels/${group.channelId}`, 'GET', null, alice.accessToken)).pendingDefault, true);
	const alicePage = await openApp(alice, group.channelId);
	await alicePage.locator('.dm-conversation .dm-gate[data-gate="pending"]').waitFor({ state: 'visible' });
	const bobPage = await openApp(bob, group.channelId);
	for (const page of [alicePage, bobPage]) await page.locator('.dm-conversation .dm-header-seal[data-state="experimental-encryption"]').waitFor({ state: 'visible', timeout: 30000 });
	await alicePage.locator('.dm-conversation .composer__input').fill('group secret from Alice');
	await alicePage.locator('.dm-conversation .composer__send').click();
	await bobPage.locator('.dm-conversation').getByText('group secret from Alice').waitFor();
	assert.ok(!(await bobPage.locator('.dm-conversation').innerText()).includes('wabi-e2ee-v1:'), 'group recipient sees one decryption layer');
	await bobPage.locator('.dm-conversation .composer__input').fill('group reply from Bob');
	await bobPage.locator('.dm-conversation .composer__send').click();
	await alicePage.locator('.dm-conversation').getByText('group reply from Bob').waitFor();
	await assertCiphertext(group.channelId, alice, ['group secret from Alice', 'group reply from Bob']);
	for (const page of [alicePage, bobPage]) {
		// 7bbba4ed (wave 1b) reworded the unopened-envelope preview from "Encrypted message" to an
		// instruction ("never a privacy claim"). The preview must still show neither plaintext nor the envelope.
		await assertHubPreviewHidesContent(page, group.channelId, ['group secret from Alice', 'group reply from Bob']);
	}
	await alicePage.screenshot({ path: `${scratch}/group-alice.png` });
	await bobPage.screenshot({ path: `${scratch}/group-bob.png` });

	// A signed-in participant should register their encryption device on app
	// startup, even if they never open the conversation. This is required for
	// default encryption to be usable when the other person starts a DM.
	const charliePage = await openApp(charlie, null);
	let charlieRegistered = false;
	for (let attempt = 0; attempt < 50; attempt++) {
		charlieRegistered = (await api('/api/e2ee/devices', 'GET', null, charlie.accessToken)).devices.length > 0;
		if (charlieRegistered) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(charlieRegistered, 'app startup registers a device without opening a DM');
	const created = event(aliceSocket, 'dm-created', (row) => row.otherUser?.id === `user-${charlie.user.id}`);
	aliceSocket.emit('create-dm', { targetUserId: `user-${charlie.user.id}` });
	const dm = await created;
	assert.equal((await api(`/api/e2ee/channels/${dm.channelId}`, 'GET', null, alice.accessToken)).pendingDefault, true);
	await openDmConversation(alicePage, dm.channelId);
	await alicePage.locator('.dm-conversation .dm-header-seal[data-state="experimental-encryption"]').waitFor({ state: 'visible', timeout: 30000 });
	await openDmConversation(charliePage, dm.channelId);
	await charliePage.locator('.dm-conversation .dm-header-seal[data-state="experimental-encryption"]').waitFor({ state: 'visible', timeout: 30000 });
	await charliePage.locator('.dm-conversation .composer__input').fill('DM secret from Charlie');
	await charliePage.locator('.dm-conversation .composer__send').click();
	await alicePage.locator('.dm-conversation').getByText('DM secret from Charlie').waitFor();
	assert.ok(!(await alicePage.locator('.dm-conversation').innerText()).includes('wabi-e2ee-v1:'), 'DM recipient sees one decryption layer');
	await alicePage.locator('.dm-conversation .composer__input').fill('DM reply from Alice');
	await alicePage.locator('.dm-conversation .composer__send').click();
	await charliePage.locator('.dm-conversation').getByText('DM reply from Alice').waitFor();
	await assertCiphertext(dm.channelId, charlie, ['DM secret from Charlie', 'DM reply from Alice']);
	for (const page of [alicePage, charliePage]) {
		// 7bbba4ed (wave 1b) reworded the unopened-envelope preview from "Encrypted message" to an
		// instruction ("never a privacy claim"). The preview must still show neither plaintext nor the envelope.
		await assertHubPreviewHidesContent(page, dm.channelId, ['DM secret from Charlie', 'DM reply from Alice']);
	}
	await charliePage.screenshot({ path: `${scratch}/dm-charlie.png` });

	// Simulate a DM that predates the new-room policy without changing any
	// message record. The updated clients should encrypt future messages once
	// both participants have registered devices.
	const oldCreated = event(aliceSocket, 'dm-created', (row) => row.otherUser?.id === `user-${bob.user.id}`);
	aliceSocket.emit('create-dm', { targetUserId: `user-${bob.user.id}` });
	const oldDm = await oldCreated;
	const registryPath = `${scratch}/data/e2ee_state.json`;
	const registry = JSON.parse(await readFile(registryPath, 'utf8'));
	delete registry.newRoomPolicies[oldDm.channelId];
	await writeFile(registryPath, JSON.stringify(registry));
	const oldStatus = await api(`/api/e2ee/channels/${oldDm.channelId}`, 'GET', null, alice.accessToken);
	assert.equal(oldStatus.pendingDefault, false, 'fixture is an existing server-readable room');
	await openDmConversation(alicePage, oldDm.channelId);
	await alicePage.locator('.dm-conversation .dm-header-seal[data-state="experimental-encryption"]').waitFor({ state: 'visible', timeout: 30000 });
	assert.equal((await api(`/api/e2ee/channels/${oldDm.channelId}`, 'GET', null, bob.accessToken)).enabled, true);

	const lateCreated = event(aliceSocket, 'dm-created', (row) => row.otherUser?.id === `user-${david.user.id}`);
	aliceSocket.emit('create-dm', { targetUserId: `user-${david.user.id}` });
	const lateDm = await lateCreated;
	await openDmConversation(alicePage, lateDm.channelId);
	await alicePage.locator('.dm-conversation .dm-gate[data-gate="pending"]').waitFor({ state: 'visible' });
	assert.equal((await api(`/api/e2ee/channels/${lateDm.channelId}`, 'GET', null, alice.accessToken)).enabled, false);
	await openApp(david, null);
	await alicePage.locator('.dm-conversation .dm-header-seal[data-state="experimental-encryption"]').waitFor({ state: 'visible', timeout: 30000 });
	console.log('PASS: startup registers idle participants; new and existing conversations encrypt future messages; late participant setup enables a pending DM; two-account ciphertext exchange succeeds');
} finally {
	for (const socket of sockets) socket.disconnect();
	await browser?.close();
	await vite?.close();
	server.kill('SIGTERM');
	await new Promise((resolve) => {
		if (server.exitCode !== null) resolve();
		else { server.once('exit', resolve); setTimeout(resolve, 5000); }
	});
}
