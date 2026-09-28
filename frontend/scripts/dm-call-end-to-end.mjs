// Disposable two-account call smoke. Never point this at a live Authority.
// WABI_CALL_TEST_BINARY=/path/to/wabi-server node scripts/dm-call-end-to-end.mjs
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dependencyRoot = await realpath(`${frontendRoot}/node_modules`).catch(() => frontendRoot);
const scratch = await mkdtemp('/tmp/wabi-dm-call-');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const binary = process.env.WABI_CALL_TEST_BINARY || fileURLToPath(new URL('../../target/debug/wabi-server', import.meta.url));
const transportMode = process.env.WABI_CALL_TEST_TRANSPORT || 'p2p-only';
const authority = spawn(binary, ['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)], {
	cwd: scratch,
	env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` },
	stdio: ['ignore', 'pipe', 'pipe']
});
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
authority.stdout.pipe(log);
authority.stderr.pipe(log);
let vite;
let browser;
const contexts = [];

async function api(path, body) {
	const response = await fetch(`${origin}${path}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
	});
	const data = await response.json().catch(() => null);
	assert.equal(response.status, 200, `${path}: ${response.status} ${JSON.stringify(data)}`);
	return data;
}

async function openAccount(account, app) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		permissions: ['microphone', 'camera']
	});
	contexts.push(context);
	await context.addInitScript(({ serverUrl, login, mode }) => {
		const scope = encodeURIComponent(serverUrl);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, login.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, login.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(login.user.id));
		localStorage.setItem('wabi_call_transport_mode', mode);
		localStorage.setItem('notificationsEnabled', 'false');
		window.__callSmokeOffers = 0;
		window.__callSmokePeerConnected = 0;
		window.__callSmokeRemoteVideo = 0;
		window.__callSmokeVideoEncodes = 0;
		window.__callSmokeVideoDecodes = 0;
		const OriginalPeer = RTCPeerConnection;
		window.RTCPeerConnection = class extends OriginalPeer {
			constructor(...args) {
				super(...args);
				this.addEventListener('connectionstatechange', () => {
					if (this.connectionState === 'connected') window.__callSmokePeerConnected++;
				});
				this.addEventListener('track', event => {
					if (event.track.kind === 'video') window.__callSmokeRemoteVideo++;
				});
			}
		};
		const originalOffer = RTCPeerConnection.prototype.createOffer;
		RTCPeerConnection.prototype.createOffer = function (...args) {
			window.__callSmokeOffers++;
			return originalOffer.apply(this, args);
		};
		for (const [name, counter] of [['VideoEncoder', '__callSmokeVideoEncodes'], ['VideoDecoder', '__callSmokeVideoDecodes']]) {
			const MediaCodec = window[name];
			if (!MediaCodec) continue;
			const method = name === 'VideoEncoder' ? 'encode' : 'decode';
			const original = MediaCodec.prototype[method];
			MediaCodec.prototype[method] = function (...args) {
				window[counter]++;
				return original.apply(this, args);
			};
		}
	}, { serverUrl: origin, login: account, mode: transportMode });
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	await page.goto(app, { waitUntil: 'domcontentloaded' });
	await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
	await page.waitForFunction(async () => (await import('/src/lib/socketConnection.ts')).getSocket()?.connected === true);
	await page.waitForFunction(async () => (await import('/src/lib/groupAccess.ts')).groupMembership.ready());
	return page;
}

async function callState(page) {
	return page.evaluate(async () => {
		const read = store => { let value; store.subscribe(next => { value = next; })(); return value; };
		const { isInCall, outgoingCall, callMode, callOfflineNotice, activeCallSessionId } = await import('/src/lib/calling.ts');
		return { inCall: read(isInCall), outgoing: read(outgoingCall), mode: read(callMode),
			notice: read(callOfflineNotice), session: read(activeCallSessionId) };
	});
}

try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (authority.exitCode !== null) throw new Error(`Authority exited; inspect ${scratch}/server.log`);
		try { ready = (await fetch(`${origin}/readyz`)).ok; } catch { /* still booting */ }
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'disposable Authority ready');
	const alice = await api('/api/auth/register', { username: 'call_alice', password: 'Local-only-call-9825!' });
	const bob = await api('/api/auth/register', { username: 'call_bob', password: 'Local-only-call-9825!' });
	process.env.VITE_SOCKET_URL = origin;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root: frontendRoot, cacheDir: `${scratch}/vite-cache`, server: {
		host: '127.0.0.1', port: 0, open: false, fs: { allow: [projectRoot, dependencyRoot] }
	} });
	await vite.listen();
	const app = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false,
		args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
		...(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {})
	});
	const caller = await openAccount(alice, app);
	if (process.env.WABI_CALL_TEST_SKIP_OFFLINE !== '1') {
	await caller.evaluate(async targetId => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		const { startCall } = await import('/src/lib/calling.ts');
		await startCall(getSocket(), targetId, false, { scope: 'dm', displayName: 'call_bob' });
	}, `user-${bob.user.id}`);
	await caller.locator('.incoming-call-modal .call-type').getByText('Ringing · waiting for an answer').waitFor();
	assert.equal((await callState(caller)).outgoing?.status, 'ringing', 'offline DM remains visibly ringing');
	await caller.locator('.call-offline-banner').getByText('No answer from call_bob').waitFor({ timeout: 35_000 });
	assert.equal((await callState(caller)).outgoing, null, 'unanswered DM leaves ringing state');
	}

	const callee = await openAccount(bob, app);
	await callee.evaluate(async () => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		getSocket().emit('set-presence', { presence: 'invisible' });
	});
	await caller.evaluate(async targetId => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		const { startCall } = await import('/src/lib/calling.ts');
		await startCall(getSocket(), targetId, true, { scope: 'dm', displayName: 'call_bob' });
	}, `user-${bob.user.id}`);
	await callee.locator('.incoming-call-modal').getByRole('button', { name: 'Answer' }).waitFor();
	await callee.locator('.incoming-call-modal').getByText('Video').waitFor();
	await callee.locator('.incoming-call-modal').getByRole('button', { name: 'Answer' }).click();
	await caller.waitForFunction(async () => {
		let value; (await import('/src/lib/calling.ts')).isInCall.subscribe(next => { value = next; })();
		return value;
	});
	await callee.waitForFunction(async () => {
		let value; (await import('/src/lib/calling.ts')).isInCall.subscribe(next => { value = next; })();
		return value;
	});
	if (transportMode === 'p2p-only') {
		await caller.waitForFunction(() => window.__callSmokeOffers > 0);
		await caller.waitForFunction(() => window.__callSmokePeerConnected > 0);
		await callee.waitForFunction(() => window.__callSmokePeerConnected > 0);
		await caller.waitForFunction(() => window.__callSmokeRemoteVideo > 0);
		await callee.waitForFunction(() => window.__callSmokeRemoteVideo > 0);
	} else {
		await caller.waitForFunction(() => window.__callSmokeVideoEncodes > 0);
		await callee.waitForFunction(() => window.__callSmokeVideoEncodes > 0);
		await caller.waitForFunction(() => window.__callSmokeVideoDecodes > 0);
		await callee.waitForFunction(() => window.__callSmokeVideoDecodes > 0);
	}
	assert.equal((await callState(caller)).mode, 'direct');
	assert.equal((await callState(callee)).mode, 'direct');
	await caller.evaluate(async () => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		const { endCall } = await import('/src/lib/calling.ts');
		endCall(getSocket());
	});
	await callee.waitForFunction(async () => {
		let value; (await import('/src/lib/calling.ts')).isInCall.subscribe(next => { value = next; })();
		return !value;
	});
	for (const page of [caller, callee]) {
		await page.evaluate(() => {
			window.__callSmokeVideoEncodes = 0;
			window.__callSmokeVideoDecodes = 0;
		});
	}

	const group = await caller.evaluate(async targetId => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		const socket = getSocket();
		const requestId = crypto.randomUUID();
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('group creation timed out')), 10000);
			const result = row => {
				if (row.requestId !== requestId) return;
				clearTimeout(timer); socket.off('group-operation-result', result);
				if (row.ok) resolve(row); else reject(new Error(row.message || 'group creation failed'));
			};
			socket.on('group-operation-result', result);
			socket.emit('create-group', { requestId, groupName: 'Call proof group', userIds: [targetId] });
		});
	}, `user-${bob.user.id}`);
	for (const page of [caller, callee]) {
		await page.waitForFunction(async id => {
			const { channels } = await import('/src/lib/channelStore.ts');
			let value; channels.subscribe(next => { value = next; })();
			return value?.some(channel => channel.id === id);
		}, group.channelId);
	}
	await caller.evaluate(async ({ id, targetId }) => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		const { startGroupCall } = await import('/src/lib/calling.ts');
		await startGroupCall(getSocket(), id, 'Call proof group', true,
			{ invitees: [{ stableUserId: targetId, username: 'call_bob' }] });
	}, { id: group.channelId, targetId: `user-${bob.user.id}` });
	await caller.locator('.incoming-call-modal .call-type').getByText('Ringing · waiting for an answer').waitFor();
	await callee.locator('.incoming-call-modal').getByRole('button', { name: 'Answer' }).click();
	await caller.waitForFunction(async () => {
		const call = await import('/src/lib/calling.ts');
		let inCall, mode;
		call.isInCall.subscribe(next => { inCall = next; })();
		call.callMode.subscribe(next => { mode = next; })();
		return inCall && mode === 'group';
	});
	await callee.waitForFunction(async () => {
		const call = await import('/src/lib/calling.ts');
		let inCall, mode;
		call.isInCall.subscribe(next => { inCall = next; })();
		call.callMode.subscribe(next => { mode = next; })();
		return inCall && mode === 'group';
	});
	if (transportMode !== 'p2p-only') {
		await caller.waitForFunction(() => window.__callSmokeVideoEncodes > 0);
		await callee.waitForFunction(() => window.__callSmokeVideoEncodes > 0);
		await caller.waitForFunction(() => window.__callSmokeVideoDecodes > 0);
		await callee.waitForFunction(() => window.__callSmokeVideoDecodes > 0);
	}
	await caller.evaluate(async () => {
		const { getSocket } = await import('/src/lib/socketConnection.ts');
		const { endCall } = await import('/src/lib/calling.ts');
		endCall(getSocket());
	});
	console.log(`PASS: ${transportMode} browser UI and fake-media DM answer/video transport, live group video answer${process.env.WABI_CALL_TEST_SKIP_OFFLINE === '1' ? '' : ', offline ringing/no-answer'}. Artifacts: ${scratch}`);
} finally {
	for (const context of contexts) await context.close().catch(() => {});
	await browser?.close();
	await vite?.close();
	authority.kill('SIGTERM');
	await new Promise(resolve => authority.once('exit', resolve));
	log.end();
}
