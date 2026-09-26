// Disposable two-account Authority proof. Never point this at a live server.
// Run after building wabi-server: WABI_DM_TEST_BINARY=../target/debug/wabi-server node scripts/dm-friends-end-to-end.mjs
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { io } from 'socket.io-client';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dependencyRoot = await realpath(`${frontendRoot}/node_modules`).catch(() => frontendRoot);
const scratch = await mkdtemp('/tmp/wabi-dm-friends-');
console.log(`Disposable DM smoke artifacts: ${scratch}`);
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const pwaOrigin = `http://wabi.test:${port}`;
const binary = process.env.WABI_DM_TEST_BINARY || fileURLToPath(new URL('../../target/debug/wabi-server', import.meta.url));
const server = spawn(binary, ['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)], {
	cwd: scratch,
	env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` },
	stdio: ['ignore', 'pipe', 'pipe']
});
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log);
server.stderr.pipe(log);
const sockets = [];
let vite;
let browser;
let pwaBrowser;

function event(socket, name, predicate = () => true, timeoutMs = 20000) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off(name, receive);
			reject(new Error(`Timed out waiting for ${name}`));
		}, timeoutMs);
		const receive = (payload) => {
			if (!predicate(payload)) return;
			clearTimeout(timeout);
			socket.off(name, receive);
			resolve(payload);
		};
		socket.on(name, receive);
	});
}

async function api(path, method, body, token) {
	const response = await fetch(`${origin}${path}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		...(body ? { body: JSON.stringify(body) } : {})
	});
	const data = await response.json().catch(() => null);
	assert.equal(response.status, 200, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
	return data;
}

async function connect(account) {
	const socket = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], auth: { token: account.accessToken } });
	sockets.push(socket);
	const diagnostics = [];
	socket.on('connect_error', (error) => diagnostics.push(`connect_error: ${error.message}`));
	socket.on('auth-required', (payload) => diagnostics.push(`auth-required: ${JSON.stringify(payload)}`));
	const initialized = event(socket, 'init', () => true, 60000);
	socket.on('connect', () => socket.emit('join', account.user.username));
	socket.connect();
	try {
		return { socket, init: await initialized };
	} catch (error) {
		throw new Error(`${error.message}; connected=${socket.connected}; id=${socket.id}; diagnostics=${JSON.stringify(diagnostics)}`);
	}
}

try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Disposable Authority exited; inspect ${scratch}/server.log`);
		try { ready = (await fetch(`${origin}/readyz`)).ok; } catch { /* booting */ }
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'disposable Authority ready');

	const alice = await api('/api/auth/register', 'POST', { username: 'dm_alice', password: 'Local-only-dm-9825!' });
	const bob = await api('/api/auth/register', 'POST', { username: 'dm_bob', password: 'Local-only-dm-9825!' });
	const charlie = await api('/api/auth/register', 'POST', { username: 'dm_charlie', password: 'Local-only-dm-9825!' });
	const a = await connect(alice);
	const b = await connect(bob);

	await api('/api/friends/requests', 'POST', { user_id: bob.user.id }, alice.accessToken);
	let snapshot = await api('/api/friends', 'GET', null, bob.accessToken);
	assert.equal(snapshot.incoming.length, 1, 'Bob receives friend request');
	assert.equal(snapshot.incoming[0].user_id, alice.user.id);
	await api(`/api/friends/requests/${snapshot.incoming[0].id}/accept`, 'POST', null, bob.accessToken);
	for (const account of [alice, bob]) {
		snapshot = await api('/api/friends', 'GET', null, account.accessToken);
		assert.equal(snapshot.friends.length, 1, 'accepted friendship visible to both accounts');
	}

	const recipientAdded = event(b.socket, 'dm-channel-added');
	const initiatorAdded = event(a.socket, 'dm-channel-added');
	const created = event(a.socket, 'dm-created');
	const otherCreated = event(b.socket, 'dm-created');
	a.socket.emit('create-dm', { targetUserId: `user-${bob.user.id}` });
	b.socket.emit('create-dm', { targetUserId: `user-${alice.user.id}` });
	const dm = await created;
	const recipient = await recipientAdded;
	assert.equal((await otherCreated).channelId, dm.channelId, 'concurrent DM creation converges on one channel');
	assert.equal((await initiatorAdded).channelId, dm.channelId, 'both devices learn the same concurrent DM');
	assert.equal(recipient.channelId, dm.channelId, 'both members learn the same DM');
	assert.ok(dm.channelId.startsWith('dm-user-'));
	const pendingStatus = await api(`/api/e2ee/channels/${dm.channelId}`, 'GET', null, alice.accessToken);
	assert.equal(pendingStatus.pendingDefault, true, 'new DM waits for encryption by default');
	const pendingDenied = event(a.socket, 'message-error', (row) => row.clientMessageId === 'pending-plaintext');
	a.socket.emit('message', { channelId: dm.channelId, clientMessageId: 'pending-plaintext', text: 'must not leak before mode choice', type: 'text' });
	assert.equal((await pendingDenied).code, 'e2ee_required', 'new DM rejects silent plaintext');
	// This fixture exercises the legacy/plaintext delivery contract. Newly
	// created private rooms require each sender to explicitly allow that mode.
	await api(`/api/e2ee/channels/${dm.channelId}/allow-server-readable`, 'POST', null, alice.accessToken);
	const peerDenied = event(b.socket, 'message-error', (row) => row.clientMessageId === 'peer-no-consent');
	b.socket.emit('message', { channelId: dm.channelId, clientMessageId: 'peer-no-consent', text: 'peer did not consent', type: 'text' });
	assert.equal((await peerDenied).code, 'e2ee_required', 'one participant cannot opt the other into plaintext');
	await api(`/api/e2ee/channels/${dm.channelId}/allow-server-readable`, 'POST', null, bob.accessToken);

	const firstId = 'dm-alice-first';
	const firstAccepted = event(a.socket, 'message-accepted', (row) => row.clientMessageId === firstId);
	const firstReceived = event(b.socket, 'message', (row) => row.channelId === dm.channelId && row.message?.text === 'hello from Alice');
	a.socket.emit('message', { channelId: dm.channelId, clientMessageId: firstId, text: 'hello from Alice', type: 'text' });
	const receipt = await firstAccepted;
	await firstReceived;
	assert.ok(receipt.messageId.startsWith('msg_'), 'sender receives durable message ID');

	const secondId = 'dm-bob-reply';
	const secondAccepted = event(b.socket, 'message-accepted', (row) => row.clientMessageId === secondId);
	const secondReceived = event(a.socket, 'message', (row) => row.channelId === dm.channelId && row.message?.text === 'hello from Bob');
	b.socket.emit('message', { channelId: dm.channelId, clientMessageId: secondId, text: 'hello from Bob', type: 'text' });
	await secondAccepted;
	await secondReceived;

	for (const socket of sockets) socket.disconnect();
	const reloadedAlice = await connect(alice);
	const reloadedBob = await connect(bob);
	for (const peer of [reloadedAlice, reloadedBob]) {
		assert.ok(peer.init.channels.some((channel) => channel.id === dm.channelId), 'DM survives reconnect');
		const history = event(peer.socket, 'history-loaded', (row) => row.channelId === dm.channelId && row.requestId === 'proof-history');
		peer.socket.emit('load-history', { channelId: dm.channelId, requestId: 'proof-history', limit: 50 });
		const loaded = await history;
		assert.deepEqual(loaded.messages.map((row) => row.text), ['hello from Alice', 'hello from Bob']);
	}
	const last = event(reloadedBob.socket, 'history-loaded', (row) => row.requestId === 'proof-preview');
	reloadedBob.socket.emit('load-history', { channelId: dm.channelId, requestId: 'proof-preview', limit: 1 });
	assert.deepEqual((await last).messages.map((row) => row.text), ['hello from Bob'], 'DM list preview uses latest durable row');

	process.env.VITE_SOCKET_URL = origin;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root: frontendRoot, server: {
		host: '127.0.0.1', port: 0, open: false,
		fs: { allow: [projectRoot, dependencyRoot] }
	} });
	await vite.listen();
	const app = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, ...(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {}) });
	async function openApp(account, mobile, conversationId = dm.channelId) {
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
		await page.waitForFunction(async (channelId) => {
			const { channels } = await import('/src/lib/channelStore.ts');
			let state;
			channels.subscribe((value) => { state = value; })();
			return state?.some((channel) => channel.id === channelId);
		}, conversationId);
		await page.evaluate(async (channelId) => {
			const { layoutStore } = await import('/src/lib/layoutStore.ts');
			layoutStore.openCenterDm(channelId, null);
		}, conversationId);
		await page.locator('.dm-conversation').waitFor({ state: 'visible' });
		return page;
	}
	const desktop = await openApp(alice, false);
	const mobile = await openApp(bob, true);
	await desktop.locator('.dm-conversation').getByText('hello from Bob').waitFor();
	await mobile.locator('.dm-conversation').getByText('hello from Alice').waitFor();
	for (const page of [desktop, mobile]) {
		const conversation = page.locator(`.dm-hub-conversation[data-dm-channel-id="${dm.channelId}"]`);
		await conversation.locator('.dm-hub-preview').getByText('hello from Bob').waitFor({ state: 'attached' });
	}
	await desktop.screenshot({ path: `${scratch}/dm-desktop.png` });
	await mobile.screenshot({ path: `${scratch}/dm-mobile.png` });
	await mobile.locator('.dm-conversation .input-container textarea').fill('phone viewport reply');
	await mobile.locator('.dm-conversation .send-button').click();
	await desktop.locator('.dm-conversation').getByText('phone viewport reply').waitFor();
	for (const page of [desktop, mobile]) {
		await page.locator(`.dm-hub-conversation[data-dm-channel-id="${dm.channelId}"] .dm-hub-preview`).getByText('phone viewport reply').waitFor({ state: 'attached' });
	}
	await desktop.locator('.personal-nav').getByRole('button', { name: /^Messages/ }).click();
	const dmBack = desktop.locator('.dm-conversation .dm-header-back');
	if (await dmBack.isVisible()) await dmBack.click();
	await desktop.locator('.personal-nav').getByRole('button', { name: /^Friends/ }).click();
	await desktop.locator('.friends-panel').getByText('dm_bob').waitFor();
	// Exercise the visible friend actions as well as the API contract above.
	await api(`/api/friends/${bob.user.id}`, 'DELETE', null, alice.accessToken);
	await desktop.locator('.friends-panel .friend-row').filter({ hasText: 'dm_bob' }).getByRole('button', { name: 'Add friend' }).click();
	await desktop.locator('.friends-panel').getByText('Sent requests').waitFor();
	await desktop.locator('.friends-panel .friend-row').filter({ hasText: 'dm_bob' }).getByText('Request sent', { exact: true }).waitFor();
	await mobile.locator('.mobile-bottom-nav').getByRole('button', { name: /^Friends/ }).click();
	await mobile.locator('.mobile-bottom-nav .mobile-nav-badge').filter({ hasText: '1' }).waitFor();
	await mobile.locator('.friends-panel').getByText('Requests to review').waitFor();
	await mobile.locator('.friends-panel .friend-row').filter({ hasText: 'dm_alice' }).getByRole('button', { name: 'Accept' }).click();
	await desktop.locator('.friends-panel .friend-row').filter({ hasText: 'dm_bob' }).getByRole('button', { name: 'Message' }).waitFor();
	await desktop.screenshot({ path: `${scratch}/friends-desktop.png` });
	await mobile.screenshot({ path: `${scratch}/friends-mobile.png` });

	await desktop.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.showUsersTab();
	});
	const people = desktop.locator('.user-list-tab');
	const bobRow = people.locator('.user-row-shell').filter({ hasText: 'dm_bob' });
	await bobRow.locator('.user-row').click({ button: 'right' });
	const peopleMenu = desktop.getByRole('menu', { name: 'User list actions' });
	await peopleMenu.getByRole('menuitem', { name: 'View Profile' }).waitFor();
	await peopleMenu.getByRole('menuitem', { name: 'Remove Friend' }).waitFor();
	await desktop.screenshot({ path: `${scratch}/people-right-click.png` });
	await peopleMenu.getByRole('menuitem', { name: 'View Profile' }).click();
	await desktop.getByRole('dialog', { name: 'User profile' }).waitFor();
	await desktop.getByRole('dialog', { name: 'User profile' }).getByRole('button', { name: 'Friends' }).waitFor();
	await desktop.screenshot({ path: `${scratch}/people-profile.png` });
	await desktop.locator('.dm-hub-title').click({ force: true });
	await desktop.getByRole('dialog', { name: 'User profile' }).waitFor({ state: 'hidden' });
	await bobRow.getByRole('button', { name: 'Actions for dm_bob' }).click({ force: true });
	await peopleMenu.getByRole('menuitem', { name: 'View Profile' }).waitFor();
	await desktop.locator('.dm-hub-title').click({ force: true });

	await people.getByRole('button', { name: /Offline/ }).click();
	const charlieRow = people.locator('.user-row-shell').filter({ hasText: 'dm_charlie' });
	await charlieRow.locator('.user-row').click({ button: 'right' });
	await peopleMenu.getByRole('menuitem', { name: 'Add Friend' }).waitFor();
	await peopleMenu.getByRole('menuitem', { name: 'Add Friend' }).click();
	let charlieSnapshot;
	for (let attempt = 0; attempt < 30; attempt++) {
		charlieSnapshot = await api('/api/friends', 'GET', null, alice.accessToken);
		if (charlieSnapshot.outgoing.some((request) => request.user_id === charlie.user.id)) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(charlieSnapshot.outgoing.some((request) => request.user_id === charlie.user.id), 'People menu sends durable friend request to an offline member');
	await charlieRow.locator('.user-row').click({ button: 'right' });
	await peopleMenu.getByRole('menuitem', { name: 'Cancel Friend Request' }).waitFor();
	await desktop.evaluate(async (channelId) => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.openCenterDm(channelId, null);
	}, dm.channelId);
	await peopleMenu.waitFor({ state: 'hidden' });
	await desktop.locator('.dm-conversation .input-container textarea').click();

	await mobile.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.showUsersTab();
	});
	const mobileBobRow = mobile.locator('.user-list-tab .user-row-shell').filter({ hasText: 'dm_alice' });
	await mobileBobRow.getByRole('button', { name: 'Actions for dm_alice' }).waitFor({ state: 'visible' });
	await mobileBobRow.getByRole('button', { name: 'Actions for dm_alice' }).click();
	await mobile.getByRole('menu', { name: 'User list actions' }).getByRole('menuitem', { name: 'View Profile' }).waitFor();
	await mobile.screenshot({ path: `${scratch}/people-mobile-actions.png` });
	await mobile.getByRole('menu', { name: 'User list actions' }).getByRole('menuitem', { name: 'Message' }).click();
	await mobile.getByRole('menu', { name: 'User list actions' }).waitFor({ state: 'hidden' });
	await mobile.locator('.dm-conversation').waitFor({ state: 'visible' });
	await mobile.locator('.mobile-right-overlay.visible').waitFor({ state: 'hidden' });
	await mobile.locator('.dm-conversation .input-container textarea').click();

	// Use the Rust Authority's embedded static frontend on a non-local test host.
	// localhost is deliberately excluded from Wabi's production service worker
	// path, so the Vite viewport check above cannot exercise the PWA send path.
	pwaBrowser = await chromium.launch({
		headless: false,
		...(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {}),
		args: [
			'--host-resolver-rules=MAP wabi.test 127.0.0.1',
			`--unsafely-treat-insecure-origin-as-secure=${pwaOrigin}`,
			'--no-proxy-server'
		]
	});
	const pwaContext = await pwaBrowser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		serviceWorkers: 'allow'
	});
	await pwaContext.addInitScript(({ serverUrl, login }) => {
		const scope = encodeURIComponent(serverUrl);
		sessionStorage.setItem('wabi.serverUrlSession', serverUrl);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, login.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, login.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(login.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { serverUrl: pwaOrigin, login: bob });
	const pwaPhone = await pwaContext.newPage();
	const pwaTransports = [];
	const pwaReceiptFrames = [];
	pwaPhone.on('websocket', (transport) => {
		if (!transport.url().includes('/socket.io/')) return;
		pwaTransports.push(transport);
		transport.on('framereceived', (frame) => {
			const payload = String(frame.payload);
			if (payload.includes('message-accepted') || payload.includes('message-error')) pwaReceiptFrames.push(payload);
		});
	});
	pwaPhone.setDefaultTimeout(30000);
	await pwaPhone.goto(pwaOrigin, { waitUntil: 'domcontentloaded' });
	await pwaPhone.locator('.mobile-bottom-nav').waitFor({ state: 'visible', timeout: 60000 });
	const sw = await pwaPhone.evaluate(async () => {
		const registration = await Promise.race([
			navigator.serviceWorker.ready,
			new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not activate')), 60000))
		]);
		const manifest = await fetch('/manifest.webmanifest').then((response) => response.json());
		return { script: registration.active?.scriptURL, state: registration.active?.state, display: manifest.display };
	});
	assert.match(sw.script, /\/sw\.js\?v=/, 'embedded frontend registered production service worker');
	assert.equal(sw.state, 'activated', 'service worker activated');
	assert.equal(sw.display, 'standalone', 'embedded frontend supplies installable manifest');
	await pwaPhone.reload({ waitUntil: 'load' });
	assert.equal(await pwaPhone.evaluate(() => Boolean(navigator.serviceWorker.controller)), true, 'PWA reload is service-worker controlled');
	await pwaPhone.locator('.mobile-bottom-nav').waitFor({ state: 'visible', timeout: 60000 });
	await pwaPhone.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
	await pwaPhone.getByRole('region', { name: 'Wabi update available' }).getByRole('button', { name: 'Reload' }).waitFor();
	await pwaPhone.getByRole('button', { name: 'Dismiss update notice' }).click();
	await pwaPhone.locator('.mobile-bottom-nav').getByRole('button', { name: 'Messages' }).click();
	const pwaConversation = pwaPhone.locator(`.dm-hub-conversation[data-dm-channel-id="${dm.channelId}"]`);
	await pwaConversation.waitFor({ state: 'visible' });
	await pwaConversation.click();
	await pwaPhone.locator('.dm-conversation').getByText('hello from Alice').waitFor();
	const pwaReply = 'phone PWA embedded reply';
	const pwaReceived = event(reloadedAlice.socket, 'message', (row) => row.channelId === dm.channelId && row.message?.text === pwaReply);
	await pwaPhone.locator('.dm-conversation .input-container textarea').fill(pwaReply);
	await pwaPhone.locator('.dm-conversation .send-button').click();
	await pwaReceived;
	await pwaPhone.screenshot({ path: `${scratch}/dm-phone-pwa.png` });

	// Two installed phone PWAs must exchange actual server-delivered messages.
	// Block WebSocket for Alice to cover mobile networks where polling works but
	// the WebSocket upgrade does not. A local optimistic bubble is insufficient.
	const constrainedContext = await pwaBrowser.newContext({
		viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
		serviceWorkers: 'allow'
	});
	await constrainedContext.routeWebSocket(/\/socket\.io\//, (socket) => socket.close());
	await constrainedContext.addInitScript(({ serverUrl, login }) => {
		const scope = encodeURIComponent(serverUrl);
		sessionStorage.setItem('wabi.serverUrlSession', serverUrl);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, login.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, login.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(login.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { serverUrl: pwaOrigin, login: alice });
	const constrainedPhone = await constrainedContext.newPage();
	let pollingRequests = 0;
	const constrainedConsoleErrors = [];
	constrainedPhone.on('console', (message) => { if (message.type() === 'error') constrainedConsoleErrors.push(message.text()); });
	constrainedPhone.on('pageerror', (error) => constrainedConsoleErrors.push(error.message));
	constrainedPhone.on('request', (request) => {
		if (request.url().includes('/socket.io/') && request.url().includes('transport=polling')) pollingRequests += 1;
	});
	constrainedPhone.setDefaultTimeout(30000);
	await constrainedPhone.goto(pwaOrigin, { waitUntil: 'domcontentloaded' });
	await constrainedPhone.locator('.badge--online').waitFor({ state: 'visible', timeout: 60000 });
	assert.ok(pollingRequests > 0, 'constrained phone connected through HTTP polling');
	const constrainedSwReady = await constrainedPhone.evaluate(() => Promise.race([
		navigator.serviceWorker.ready.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 60000))
	]));
	if (!constrainedSwReady) {
		const diagnostics = await constrainedPhone.evaluate(async () => ({
			secure: isSecureContext,
			online: navigator.onLine,
			controller: navigator.serviceWorker.controller?.scriptURL || null,
			registrations: (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
				scope: registration.scope,
				active: registration.active?.scriptURL || null,
				activeState: registration.active?.state || null,
				waiting: registration.waiting?.scriptURL || null,
				installing: registration.installing?.scriptURL || null
			}))
		}));
		throw new Error(`Polling-only phone service worker did not activate: ${JSON.stringify({ diagnostics, constrainedConsoleErrors })}`);
	}
	await constrainedPhone.reload({ waitUntil: 'load' });
	assert.equal(await constrainedPhone.evaluate(() => Boolean(navigator.serviceWorker.controller)), true, 'constrained phone is service-worker controlled');
	await constrainedPhone.locator('.mobile-bottom-nav').getByRole('button', { name: 'Messages' }).click();
	await constrainedPhone.locator(`.dm-hub-conversation[data-dm-channel-id="${dm.channelId}"]`).click();
	await constrainedPhone.locator('.dm-conversation').getByText(pwaReply).waitFor();
	const bobToAlice = 'phone PWA to polling-only phone';
	await pwaPhone.locator('.dm-conversation .input-container textarea').fill(bobToAlice);
	await pwaPhone.locator('.dm-conversation .send-button').click();
	await constrainedPhone.locator('.dm-conversation').getByText(bobToAlice).waitFor();
	const aliceToBob = 'polling-only phone PWA reply';
	await constrainedPhone.locator('.dm-conversation .input-container textarea').fill(aliceToBob);
	await constrainedPhone.locator('.dm-conversation .send-button').click();
	await pwaPhone.locator('.dm-conversation').getByText(aliceToBob).waitFor();
	const crossPwaHistory = await api(`/api/messages/${dm.channelId}`, 'GET', null, alice.accessToken);
	assert.ok(crossPwaHistory.messages.some((message) => message.content === aliceToBob), 'polling-only PWA reply is durable');
	await constrainedPhone.screenshot({ path: `${scratch}/dm-phone-pwa-polling.png` });
	await constrainedContext.close();

	// Simulate a real phone losing its connection while the installed PWA stays
	// open. Wait for both the browser's offline state and the live transport to
	// close so this send exercises the offline path, not a stale connected socket.
	const liveTransports = pwaTransports.filter((transport) => !transport.isClosed());
	assert.ok(liveTransports.length > 0, 'embedded PWA has a live Socket.IO transport before going offline');
	const offlineReply = 'phone PWA offline replay';
	const offlineArrivals = [];
	const observeOfflineReply = (row) => {
		if (row.channelId === dm.channelId && row.message?.text === offlineReply) offlineArrivals.push(row);
	};
	reloadedAlice.socket.on('message', observeOfflineReply);
	await pwaContext.setOffline(true);
	await pwaPhone.locator('.badge--offline').waitFor({ state: 'visible' });
	assert.equal(await pwaPhone.evaluate(() => navigator.onLine), false, 'PWA browser reports offline');
	const transportDeadline = Date.now() + 15000;
	while (liveTransports.some((transport) => !transport.isClosed()) && Date.now() < transportDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(liveTransports.every((transport) => transport.isClosed()), 'PWA Socket.IO transport closed before offline send');
	const pwaTextarea = pwaPhone.locator('.dm-conversation .input-container textarea');
	await pwaTextarea.fill(offlineReply);
	await pwaPhone.locator('.dm-conversation .send-button').click();
	const offlineOutcome = await pwaPhone.waitForFunction((reply) => {
		const queued = [...document.querySelectorAll('.dm-conversation .message')].some((message) =>
			message.textContent?.includes(reply) && message.textContent?.includes('Queued — will send when online')
		);
		const preservedDraft = document.querySelector('.dm-conversation .input-container textarea')?.value === reply &&
			document.querySelector('#wabi-toast-container')?.textContent?.includes('Your draft is unchanged.');
		return queued ? 'queued' : preservedDraft ? 'draft-preserved' : false;
	}, offlineReply, { timeout: 15000 });
	const offlineResult = await offlineOutcome.jsonValue();
	assert.equal(offlineArrivals.length, 0, 'offline reply did not reach Alice before reconnection');
	if (offlineResult === 'queued') {
		assert.equal(await pwaTextarea.inputValue(), '', 'queued offline reply clears only the accepted draft');
	} else {
		assert.equal(offlineResult, 'draft-preserved', 'offline send has an explicit outcome');
		assert.equal(await pwaTextarea.inputValue(), offlineReply, 'failed offline reply remains editable');
	}
	await pwaPhone.screenshot({ path: `${scratch}/dm-phone-pwa-offline.png` });
	await pwaContext.setOffline(false);
	await pwaPhone.locator('.badge--online').waitFor({ state: 'visible', timeout: 45000 });
	if (offlineResult === 'queued') {
		const deliveryDeadline = Date.now() + 30000;
		while (offlineArrivals.length === 0 && Date.now() < deliveryDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(offlineArrivals.length, 1, 'Alice receives the queued reply after PWA reconnection');
	}
	const offlineHistory = event(reloadedAlice.socket, 'history-loaded', (row) => row.channelId === dm.channelId && row.requestId === 'proof-pwa-offline', 30000);
	reloadedAlice.socket.emit('load-history', { channelId: dm.channelId, requestId: 'proof-pwa-offline', limit: 50 });
	const durableOfflineRows = (await offlineHistory).messages.filter((row) => row.text === offlineReply);
	assert.equal(durableOfflineRows.length, offlineResult === 'queued' ? 1 : 0, 'offline reply has exactly the expected number of durable copies');
	reloadedAlice.socket.off('message', observeOfflineReply);
	if (offlineResult === 'queued') {
		// Alice's receipt and history can precede Bob's next browser paint. The
		// PWA proof is complete only after Bob's optimistic row is reconciled.
		try {
			await pwaPhone.waitForFunction((reply) => {
				const rows = [...document.querySelectorAll('.dm-conversation .message')]
					.filter((message) => message.textContent?.includes(reply));
				return rows.length === 1 && !rows[0].querySelector('.message-delivery-row');
			}, offlineReply, { timeout: 15000 });
		} catch (error) {
			const rows = await pwaPhone.evaluate((reply) => [...document.querySelectorAll('.dm-conversation .message')]
				.filter((message) => message.textContent?.includes(reply))
				.map((message) => ({ id: message.getAttribute('data-message-id'), status: message.querySelector('.message-delivery-row')?.textContent?.trim() })), offlineReply);
			throw new Error(`Queued label did not settle after durable acceptance (${scratch}): ${JSON.stringify({ rows, pwaReceiptFrames, aliceArrivals: offlineArrivals })}`, { cause: error });
		}
	}
	await pwaPhone.screenshot({ path: `${scratch}/dm-phone-pwa-reconnected.png` });
	await pwaPhone.locator('.dm-conversation .dm-header-back').click();
	await pwaPhone.locator('.dm-hub-tabs').getByRole('button', { name: /Friends/ }).click();
	await pwaPhone.locator('#friends-search').fill('hermes-bot');
	const hermesRows = pwaPhone.locator('.friends-panel .friend-row').filter({ hasText: 'hermes-bot' });
	assert.equal(await hermesRows.getByRole('button', { name: 'Add friend' }).count(), 0, 'bot account is never an Add friend candidate');

	// Retention is assigned when each message is sent. A later shorter policy
	// must not wipe the conversation's earlier history or extend a 5s message.
	await desktop.evaluate(async (channelId) => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.closeRightPanel();
		layoutStore.openCenterDm(channelId, null);
	}, dm.channelId);
	await desktop.locator('.dm-conversation').waitFor({ state: 'visible' });
	await mobile.locator('.dm-conversation').waitFor({ state: 'visible' });
	await mobile.locator('.mobile-right-overlay.visible').waitFor({ state: 'hidden' });
	const retentionSelect = desktop.locator('.dm-conversation select[aria-label="Retention for new messages"]');
	const thirtySave = desktop.waitForResponse((response) => response.url().includes(`/api/channels/${encodeURIComponent(dm.channelId)}/retention`) && response.request().method() === 'PUT');
	await retentionSelect.selectOption('30s');
	assert.equal((await thirtySave).status(), 200);
	await desktop.locator('.dm-conversation .input-container textarea').fill('retention visual preview');
	await desktop.locator('.dm-conversation .send-button').click();
	const visualRow = desktop.locator('.dm-conversation .message').filter({ hasText: 'retention visual preview' });
	await visualRow.locator('.deletion-timer').waitFor({ state: 'visible' });
	assert.match(await visualRow.locator('.deletion-timer').innerText(), /30s timer/, 'Static badge states the original policy lifetime instead of a frozen countdown');
	const mobileVisualTimer = mobile.locator('.dm-conversation .message').filter({ hasText: 'retention visual preview' }).locator('.deletion-timer');
	await mobileVisualTimer.waitFor({ state: 'visible' });
	assert.match(await mobileVisualTimer.innerText(), /30s timer/, 'phone-sized Static badge states the original lifetime');
	await desktop.screenshot({ path: `${scratch}/retention-desktop.png` });
	await mobile.screenshot({ path: `${scratch}/retention-mobile.png` });
	const daySave = desktop.waitForResponse((response) => response.url().includes(`/api/channels/${encodeURIComponent(dm.channelId)}/retention`) && response.request().method() === 'PUT');
	await retentionSelect.selectOption('24h');
	assert.equal((await daySave).status(), 200);
	assert.equal(await retentionSelect.inputValue(), '24h', 'conversation control reflects the new 24h policy');
	await desktop.locator('.dm-conversation .input-container textarea').fill('new 24-hour retention proof');
	await desktop.locator('.dm-conversation .send-button').click();
	const dayRow = desktop.locator('.dm-conversation .message').filter({ hasText: 'new 24-hour retention proof' });
	await dayRow.waitFor({ state: 'visible' });
	assert.equal(await dayRow.locator('.deletion-timer').count(), 0, 'new 24h message never inherits the older 30s badge');
	await visualRow.locator('.deletion-timer').getByText('30s timer').waitFor({ state: 'visible' });
	const dayHistory = await api(`/api/messages/${dm.channelId}`, 'GET', null, alice.accessToken);
	const timeline = await api(`/api/channels/${dm.channelId}/retention`, 'GET', null, alice.accessToken);
	const deadlineFor = (content) => {
		const message = dayHistory.messages.find((row) => row.content === content);
		assert.ok(message, `history contains ${content}`);
		const epoch = [...timeline.epochs].reverse().find((row) => row.fromMicros <= message.created_at * 1000);
		assert.ok(epoch, `retention epoch exists for ${content}`);
		return { durationMs: epoch.durationMs, deadline: message.created_at + epoch.durationMs };
	};
	assert.equal(deadlineFor('retention visual preview').durationMs, 30_000, 'older message keeps 30s deadline');
	const dayDeadline = deadlineFor('new 24-hour retention proof');
	assert.equal(dayDeadline.durationMs, 86_400_000, 'new message receives 24h deadline');
	assert.ok(dayDeadline.deadline - Date.now() > 86_300_000, 'server deadline is approximately one day away');
	const fiveSave = desktop.waitForResponse((response) => response.url().includes(`/api/channels/${encodeURIComponent(dm.channelId)}/retention`) && response.request().method() === 'PUT');
	await retentionSelect.selectOption('5s');
	assert.equal((await fiveSave).status(), 200);
	await desktop.locator('.dm-conversation .input-container textarea').fill('five-second retention proof');
	const shortRemovalDeadline = Date.now() + 9000;
	await desktop.locator('.dm-conversation .send-button').click();
	const shortRow = desktop.locator('.dm-conversation .message').filter({ hasText: 'five-second retention proof' });
	await shortRow.waitFor({ state: 'visible' });
	await shortRow.waitFor({ state: 'hidden', timeout: Math.max(1000, shortRemovalDeadline - Date.now()) });
	await visualRow.waitFor({ state: 'visible' });
	await desktop.locator('.dm-conversation').getByText('hello from Bob').waitFor({ state: 'visible' });
	let retainedHistory;
	do {
		retainedHistory = await api(`/api/messages/${dm.channelId}`, 'GET', null, alice.accessToken);
		if (!retainedHistory.messages.some((message) => message.content === 'five-second retention proof')) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < shortRemovalDeadline);
	assert.ok(retainedHistory.messages.some((message) => message.content === 'hello from Bob'), 'older DM history remains after a 5s selection');
	assert.ok(retainedHistory.messages.some((message) => message.content === 'retention visual preview'), '30s message keeps its original lifetime');
	assert.ok(!retainedHistory.messages.some((message) => message.content === 'five-second retention proof'), '5s message leaves server history promptly');
	const headerChannel = reloadedAlice.init.channels.find((channel) => channel.type === 'text' && channel.name === 'general');
	assert.ok(headerChannel, 'starter text channel is available for header visual QA');
	await api(`/api/channels/${headerChannel.id}/retention`, 'PUT', { retention: '30s' }, alice.accessToken);
	await desktop.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.closeCenterDm();
		layoutStore.closeRightPanel();
	});
	await desktop.locator(`.channel-item[data-channel-id="${headerChannel.id}"] .channel-btn`).click();
	await desktop.locator('.chat-header .retention-channel-badge').getByText('30 seconds').waitFor({ state: 'visible' });
	await desktop.screenshot({ path: `${scratch}/retention-header-desktop.png` });

	// Two real browser accounts must exchange one-layer encrypted messages in
	// both a new group and a fresh DM. The Authority retains only wire envelopes.
	const groupRequestId = crypto.randomUUID();
	const groupResult = event(reloadedAlice.socket, 'group-operation-result', (row) => row.requestId === groupRequestId);
	reloadedAlice.socket.emit('create-group', { requestId: groupRequestId, groupName: 'Encrypted pilot group', userIds: [`user-${bob.user.id}`] });
	const group = await groupResult;
	assert.equal(group.ok, true, `encrypted group creation: ${JSON.stringify(group)}`);
	const groupId = group.channelId;
	assert.equal((await api(`/api/e2ee/channels/${groupId}`, 'GET', null, alice.accessToken)).pendingDefault, true, 'new group starts pending encryption');
	for (const page of [desktop, mobile]) {
		await page.waitForFunction(async (id) => {
			const { channels } = await import('/src/lib/channelStore.ts');
			let value;
			channels.subscribe((next) => { value = next; })();
			return value?.some((channel) => channel.id === id);
		}, groupId);
		if (page === desktop) {
			await page.locator('.personal-nav').getByRole('button', { name: /^Messages/ }).click();
		} else {
			await page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Messages' }).click();
		}
		await page.locator(`.dm-hub-conversation[data-dm-channel-id="${groupId}"]`).click();
		await page.locator('.dm-conversation').waitFor({ state: 'visible' });
	}
	for (const page of [desktop, mobile]) await page.locator('.dm-conversation .dm-header-pill-secure').waitFor({ state: 'visible', timeout: 30000 });
	await desktop.locator('.dm-conversation .input-container textarea').fill('one-layer group secret from Alice');
	await desktop.locator('.dm-conversation .send-button').click();
	await mobile.locator('.dm-conversation').getByText('one-layer group secret from Alice').waitFor();
	assert.equal(await mobile.locator('.dm-conversation').getByText('wabi-e2ee-v1:').count(), 0, 'group recipient does not see a nested ciphertext envelope');
	await mobile.locator('.dm-conversation .input-container textarea').fill('group reply from Bob');
	await mobile.locator('.dm-conversation .send-button').click();
	await desktop.locator('.dm-conversation').getByText('group reply from Bob').waitFor();
	const groupHistory = await api(`/api/messages/${groupId}`, 'GET', null, alice.accessToken);
	assert.equal(groupHistory.messages.length, 2, 'both encrypted group messages are durable');
	for (const row of groupHistory.messages) {
		assert.match(row.content, /^wabi-e2ee-v1:/, 'Authority stores a ciphertext envelope');
		assert.ok(!row.content.includes('one-layer group secret') && !row.content.includes('group reply from Bob'), 'Authority does not store group plaintext');
	}
	for (const page of [desktop, mobile]) {
		await page.locator(`.dm-hub-conversation[data-dm-channel-id="${groupId}"] .dm-hub-preview`).getByText('Encrypted message', { exact: true }).waitFor({ state: 'attached' });
	}
	await desktop.screenshot({ path: `${scratch}/e2ee-group-desktop.png` });
	await mobile.screenshot({ path: `${scratch}/e2ee-group-mobile.png` });

	const freshDmCreated = event(reloadedAlice.socket, 'dm-created', (row) => row.otherUser?.id === `user-${charlie.user.id}`);
	reloadedAlice.socket.emit('create-dm', { targetUserId: `user-${charlie.user.id}` });
	const freshDm = await freshDmCreated;
	assert.equal((await api(`/api/e2ee/channels/${freshDm.channelId}`, 'GET', null, alice.accessToken)).pendingDefault, true, 'fresh DM starts pending encryption');
	const charliePage = await openApp(charlie, false, freshDm.channelId);
	await charliePage.locator('.dm-conversation .dm-header-pill-secure').waitFor({ state: 'visible', timeout: 30000 });
	await desktop.evaluate(async (id) => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.openCenterDm(id, null);
	}, freshDm.channelId);
	await desktop.locator('.dm-conversation .dm-header-pill-secure').waitFor({ state: 'visible', timeout: 30000 });
	await charliePage.locator('.dm-conversation .input-container textarea').fill('one-layer DM secret from Charlie');
	await charliePage.locator('.dm-conversation .send-button').click();
	await desktop.locator('.dm-conversation').getByText('one-layer DM secret from Charlie').waitFor();
	await desktop.locator('.dm-conversation .input-container textarea').fill('encrypted DM reply from Alice');
	await desktop.locator('.dm-conversation .send-button').click();
	await charliePage.locator('.dm-conversation').getByText('encrypted DM reply from Alice').waitFor();
	const encryptedDmHistory = await api(`/api/messages/${freshDm.channelId}`, 'GET', null, charlie.accessToken);
	assert.equal(encryptedDmHistory.messages.length, 2, 'both encrypted DM messages are durable');
	for (const row of encryptedDmHistory.messages) {
		assert.match(row.content, /^wabi-e2ee-v1:/, 'Authority stores DM ciphertext');
		assert.ok(!row.content.includes('one-layer DM secret') && !row.content.includes('encrypted DM reply'), 'Authority does not store DM plaintext');
	}
	for (const page of [desktop, charliePage]) {
		await page.locator(`.dm-hub-conversation[data-dm-channel-id="${freshDm.channelId}"] .dm-hub-preview`).getByText('Encrypted message', { exact: true }).waitFor({ state: 'attached' });
	}
	await charliePage.screenshot({ path: `${scratch}/e2ee-dm-charlie.png` });

	const logoutRoster = await desktop.evaluate(async (serverUrl) => {
		const { clearAuthSession } = await import('/src/lib/authSession.ts');
		const { users, serverMembers, currentUser } = await import('/src/lib/presenceIdentity.ts');
		const read = (store) => {
			let value;
			const unsubscribe = store.subscribe((next) => { value = next; });
			unsubscribe();
			return value;
		};
		const before = { members: read(serverMembers).length, user: read(currentUser)?.username };
		clearAuthSession(serverUrl);
		return {
			before,
			after: { users: read(users).length, members: read(serverMembers).length, user: read(currentUser) }
		};
	}, origin);
	assert.ok(logoutRoster.before.members > 0 && logoutRoster.before.user, 'account roster exists before logout');
	assert.deepEqual(logoutRoster.after, { users: 0, members: 0, user: null }, 'logout clears account-scoped roster immediately');

	console.log(`PASS: friendship UI, two-way live DM, receipts, reconnect history, previews, bot exclusion, mobile UI, future-only 5s retention, and embedded phone PWA send/reconnect (${offlineResult}; ${scratch})`);
} finally {
	for (const socket of sockets) socket.disconnect();
	await pwaBrowser?.close();
	await browser?.close();
	await vite?.close();
	server.kill('SIGTERM');
	await new Promise((resolve) => {
		if (server.exitCode !== null) resolve();
		else { server.once('exit', resolve); setTimeout(resolve, 5000); }
	});
	log.end();
}
