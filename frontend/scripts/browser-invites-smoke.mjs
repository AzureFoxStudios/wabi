// "Invite a friend" from the browser app, end to end, in headful Chromium against a disposable
// Authority (docs/testing/INSTALL_FROM_NOTHING.md stage 3; docs/VISION.md point 2).
//
// 1. The owner sets up a fresh server in the browser and chooses "Invite only".
// 2. The owner creates an invitation in Settings › Admin and reads the link the page shows.
// 3. A second browser context opens the link and joins; it lands in the signed-in app.
// 4. A third context, with no invitation, is refused registration.
// 5. Opening the same link again is refused in plain words; so are a cancelled link, an expired
//    link and any link while the server is Closed. A link opened while signed in says so.
//
// Addressing: the join page refuses plain HTTP unless the address is a private LAN address, and
// a link made from localhost is useless to a friend, so the app must be reached at a private
// address. CI runners and sandboxes do not reliably have one, so Chromium is pointed at a tiny
// forward proxy that sends every request for FRIEND_ORIGIN to a local Vite dev server, which in
// turn proxies /api and /socket.io to the Authority. The pages therefore see one same-origin
// server at a 10.x address, as they would on a home network.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { waitForAppShell } from './smoke-shell.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-browser-invites-');
// Screenshots only (never the server's data directory) go to WABI_SMOKE_EVIDENCE_DIR when set, for CI.
const evidence = process.env.WABI_SMOKE_EVIDENCE_DIR || scratch;
await mkdir(evidence, { recursive: true });
const ORIGIN = 'http://10.77.0.10:3080';

async function freePort() {
	const listener = net.createServer();
	await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
	const { port } = listener.address();
	await new Promise(resolve => listener.close(resolve));
	return port;
}

const port = await freePort();
const backend = `http://127.0.0.1:${port}`;
const server = spawn(process.env.WABI_SMOKE_SERVER_BINARY || fileURLToPath(new URL('../../target/debug/wabi-server', import.meta.url)),
	['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)],
	{ cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log); server.stderr.pipe(log);

let browser, vite, proxy;
const errors = [];
try {
	let ready = false;
	for (let attempt = 0; attempt < 300 && !ready; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated backend exited: ${scratch}`);
		try { ready = (await fetch(`${backend}/readyz`)).ok; } catch { /* starting */ }
		if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'isolated backend ready');

	delete process.env.VITE_SOCKET_URL;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({
		root,
		server: {
			host: '127.0.0.1', port: 0, open: false,
			proxy: {
				'/api': { target: backend, changeOrigin: true },
				'/socket.io': { target: backend, changeOrigin: true, ws: true },
				'/uploads': { target: backend, changeOrigin: true }
			}
		}
	});
	await vite.listen();
	const vitePort = vite.httpServer.address().port;

	// Forward proxy: plain requests and CONNECT tunnels (WebSockets) for any host go to Vite.
	proxy = http.createServer((request, response) => {
		const url = new URL(request.url, ORIGIN);
		const upstream = http.request({ host: '127.0.0.1', port: vitePort, method: request.method, path: url.pathname + url.search, headers: request.headers }, reply => {
			response.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(response);
		});
		upstream.on('error', () => { response.writeHead(502); response.end(); });
		request.pipe(upstream);
	});
	proxy.on('connect', (_request, socket, head) => {
		const upstream = net.connect(vitePort, '127.0.0.1', () => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head?.length) upstream.write(head);
			upstream.pipe(socket); socket.pipe(upstream);
		});
		upstream.on('error', () => socket.destroy());
		socket.on('error', () => upstream.destroy());
	});
	await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
	const proxyPort = proxy.address().port;

	browser = await chromium.launch({
		headless: false,
		executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH,
		proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' }
	});
	const context = async (name, viewport = { width: 1440, height: 900 }) => {
		const ctx = await browser.newContext({ viewport });
		await ctx.addInitScript(() => { try { localStorage.setItem('notificationsEnabled', 'false'); } catch { /* storage blocked */ } });
		const page = await ctx.newPage();
		page.setDefaultTimeout(20000);
		page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
		return page;
	};

	// ── 1. Owner sets up the server and chooses Invite only ──
	const owner = await context('owner');
	await owner.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
	const wizard = owner.locator('.wizard');
	await wizard.getByText('Display name', { exact: true }).waitFor({ timeout: 60000 });
	await wizard.getByLabel('Display name').fill('Owner');
	await wizard.getByLabel('Permanent handle').fill('owner');
	await wizard.locator('input[type="password"]').nth(0).fill('Owner-invite-smoke-4471!');
	await wizard.locator('input[type="password"]').nth(1).fill('Owner-invite-smoke-4471!');
	await wizard.locator('button[type="submit"]').click();
	const choices = owner.getByRole('radiogroup', { name: 'Who can join this server?' });
	await choices.waitFor();
	const labels = await choices.locator('.join-option-title').allInnerTexts();
	assert.deepEqual(labels, ['Open', 'Invite only', 'Closed'], 'Invite only sits between Open and Closed');
	assert.equal(await choices.locator('input[value="open"]').isChecked(), true, 'the preselected option is unchanged (Open)');
	await choices.locator('input[value="invite"]').check();
	assert.equal(await owner.locator('.join-guest-row').count(), 0, 'guest access is not offered for Invite only (the server refuses guests)');
	await owner.screenshot({ path: `${evidence}/setup-invite-only-desktop.png` });
	await owner.getByRole('button', { name: 'Finish setup' }).click();
	await waitForAppShell(owner);
	const policy = await (await fetch(`${backend}/api/public/auth-policy`)).json();
	assert.equal(policy.mode, 'invite', 'the setup choice reached the server');
	assert.equal(policy.allowGuest, false);

	// ── 2. Owner creates an invitation in Settings › Admin ──
	async function openInviteSection(page) {
		await page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).first().click();
		const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
		await settings.getByRole('tab', { name: 'Admin', exact: true }).click();
		const section = settings.locator('.admin-invite');
		await section.getByRole('heading', { name: 'Invite someone' }).waitFor();
		return { settings, section };
	}
	const { settings, section } = await openInviteSection(owner);
	await settings.locator('.admin-join').getByRole('radio', { name: 'Invite only' }).and(owner.locator('[aria-checked="true"]')).waitFor();
	await section.getByRole('radio', { name: '1 day' }).and(owner.locator('[aria-checked="true"]')).waitFor();
	await section.getByText('No invitations are waiting.', { exact: false }).waitFor();
	async function createLink(hours = '1 day') {
		await section.getByRole('radio', { name: hours }).click();
		await section.getByRole('button', { name: 'Create invitation' }).click();
		const field = section.locator('#invite-link');
		await field.waitFor();
		const link = await field.inputValue();
		assert.match(link, new RegExp(`^${ORIGIN.replace(/[.:/]/g, '\\$&')}/join#invite=[a-f0-9]{64}$`), 'link is built from the address the owner is using');
		return link;
	}
	const link = await createLink();
	const facts = await section.locator('[data-invite-facts]').innerText();
	assert.match(facts, /Works once, for one person\. Expires .+ \(in 2[34] hours\)\./, 'the page says it works once and when it expires');
	await section.locator('[data-reach="network"]').getByText('This link only works for people on your network').waitFor();
	await section.locator('img.admin-invite__qr').waitFor();
	await section.getByRole('button', { name: 'Copy link' }).click();
	await section.getByRole('button', { name: 'Copied' }).waitFor();
	// A plain-HTTP LAN page is not a secure context, so it has no navigator.clipboard; the button
	// must still copy (through the selected field) rather than fail.
	assert.equal(await owner.evaluate(() => window.isSecureContext), false, 'the LAN page is not a secure context');
	assert.equal(await section.getByRole('alert').count(), 0, 'copying did not fail');
	assert.equal(await section.locator('.admin-invite__row').count(), 1, 'the new invitation is listed as waiting');
	await owner.screenshot({ path: `${evidence}/invite-created-desktop.png` });
	await owner.setViewportSize({ width: 390, height: 844 });
	await section.scrollIntoViewIfNeeded();
	await owner.screenshot({ path: `${evidence}/invite-created-phone.png` });
	const overflow = await owner.evaluate(() => {
		const box = document.querySelector('.admin-invite')?.getBoundingClientRect();
		return box ? box.right - window.innerWidth : 999;
	});
	assert.ok(overflow <= 1, `the invitation section fits a 390px phone (overflow ${overflow}px)`);
	await owner.setViewportSize({ width: 1440, height: 900 });

	// ── 3. A friend joins with the link ──
	const friend = await context('friend', { width: 390, height: 844 });
	await friend.goto(link, { waitUntil: 'domcontentloaded' });
	await friend.getByRole('heading', { name: 'Create your member account' }).waitFor();
	assert.equal(new URL(friend.url()).hash, '', 'the invitation secret is removed from the address bar');
	await friend.locator('#wabi-boot-shell').waitFor({ state: 'detached' }).catch(() => {}); // the boot splash fades out
	await friend.screenshot({ path: `${evidence}/join-phone.png` });
	// A taken name is refused before the invitation is spent, and the page says so under the button.
	await friend.getByLabel('Username').fill('Owner');
	await friend.getByLabel('Password', { exact: true }).fill('Friend-invite-smoke-4471!');
	await friend.getByLabel('Repeat password').fill('Friend-invite-smoke-4471!');
	await friend.getByRole('button', { name: 'Accept invitation & create account' }).click();
	await friend.locator('[data-form-error]').getByText(/already has that username.*has not been used/).waitFor();
	await friend.getByLabel('Username').fill('friend');
	await friend.getByRole('button', { name: 'Accept invitation & create account' }).click();
	await waitForAppShell(friend);
	const users = await (await fetch(`${backend}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'friend', password: 'Friend-invite-smoke-4471!' }) })).json();
	assert.equal(users.user?.username, 'friend', 'the friend has a real account');

	// The owner's list no longer shows the used invitation.
	await owner.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Done' }).click().catch(() => {});
	await owner.keyboard.press('Escape');
	const again = await openInviteSection(owner);
	await again.section.getByText('No invitations are waiting.', { exact: false }).waitFor();

	// ── 4. Someone without an invitation is refused ──
	const stranger = await context('stranger');
	await stranger.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
	const direct = await fetch(`${backend}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'stranger', password: 'Stranger-smoke-4471!' }) });
	assert.equal(direct.status, 403, 'registration without an invitation is refused by the server');
	assert.match((await direct.json()).error, /invite is required/);
	await stranger.locator('[data-invite-only]').getByText('This server is invite only.', { exact: false }).waitFor({ timeout: 60000 });
	assert.equal(await stranger.getByRole('button', { name: /create one|create account/i }).count(), 0, 'no registration form is offered without an invitation');
	assert.equal(await stranger.locator('.main-content .chat-surface').count(), 0, 'the stranger is not let in');
	await stranger.screenshot({ path: `${evidence}/stranger-refused.png` });

	// ── 5. Refusals the friend can understand ──
	const usedMessage = /can't be used any more\. Each link works once/;
	async function tryLink(name, href, { expectPhase = 'ready', submit = true } = {}) {
		const page = await context(name, { width: 390, height: 844 });
		await page.goto(href, { waitUntil: 'domcontentloaded' });
		await page.locator(`main[data-join-phase="${expectPhase}"]`).waitFor();
		if (submit && expectPhase === 'ready') {
			await page.getByLabel('Username').fill(name);
			await page.getByLabel('Password', { exact: true }).fill('Second-use-smoke-4471!');
			await page.getByLabel('Repeat password').fill('Second-use-smoke-4471!');
			await page.getByRole('button', { name: 'Accept invitation & create account' }).click();
		}
		return page;
	}
	// Second use of the same link.
	const reuse = await tryLink('reuser', link);
	await reuse.getByRole('alert').filter({ hasText: usedMessage }).waitFor();
	await reuse.locator('main[data-join-phase="spent"]').waitFor();
	assert.equal(await reuse.getByLabel('Username').count(), 0, 'a spent link offers no form to retry');
	await reuse.screenshot({ path: `${evidence}/join-used-phone.png` });

	// A cancelled link.
	const { section: list } = again;
	const cancelled = await (async () => {
		await list.getByRole('radio', { name: '1 day' }).click();
		await list.getByRole('button', { name: 'Create invitation' }).click();
		const href = await list.locator('#invite-link').inputValue();
		await list.getByRole('button', { name: 'Cancel invitation' }).click();
		await list.getByText('No invitations are waiting.', { exact: false }).waitFor();
		assert.equal(await list.locator('#invite-link').count(), 0, 'cancelling the shown link hides it');
		return href;
	})();
	await (await tryLink('cancelled', cancelled)).getByRole('alert').filter({ hasText: usedMessage }).waitFor();

	// An expired link: move its expiry into the past on disk (the server reads the registry on every request).
	await list.getByRole('button', { name: 'Create invitation' }).click();
	const expiring = await list.locator('#invite-link').inputValue();
	const registryPath = `${scratch}/data/join-invites-v1.json`;
	const registry = JSON.parse(await readFile(registryPath, 'utf8'));
	for (const grant of registry.grants) if (!grant.consumed && !grant.revoked) grant.expiresAt = Math.floor(Date.now() / 1000) - 5;
	await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
	await (await tryLink('expired', expiring)).getByRole('alert').filter({ hasText: usedMessage }).waitFor();

	// A link opened by someone already signed in to this server.
	await list.getByRole('button', { name: 'Create invitation' }).click();
	const spare = await list.locator('#invite-link').inputValue();
	await friend.goto(spare, { waitUntil: 'domcontentloaded' });
	await friend.locator('[data-signed-in]').getByText(/already signed in to .* as friend/).waitFor();
	await friend.screenshot({ path: `${evidence}/join-signed-in-phone.png` });

	// A link for a server that is Closed: said before the form, and the invitation is not spent.
	await owner.getByRole('dialog', { name: 'Settings', exact: true }).locator('.admin-join').getByRole('radio', { name: 'Closed' }).click();
	await list.getByText("Invitations won't work while this server is closed").waitFor();
	const closed = await tryLink('closed', spare, { expectPhase: 'closed' });
	await closed.getByRole('alert').filter({ hasText: /isn't taking new accounts right now, not even with an invitation/ }).waitFor();
	assert.equal(await closed.getByLabel('Username').count(), 0, 'no form is offered while the server is closed');
	await closed.screenshot({ path: `${evidence}/join-closed-phone.png` });

	// A link made while the owner uses localhost is not offered at all.
	const local = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	local.on('pageerror', error => errors.push(`local: ${error.message}`));
	await local.goto(`http://127.0.0.1:${vitePort}/join#invite=${'a'.repeat(64)}`, { waitUntil: 'domcontentloaded' });
	await local.getByRole('alert').filter({ hasText: /always means the device you are using/ }).waitFor();

	assert.deepEqual(errors, [], 'no browser exceptions');
	console.log(`PASS browser invitations: setup Invite only, create/copy/QR/cancel, friend joins, stranger refused, used/cancelled/expired/closed/signed-in links explained; screenshots ${evidence}`);
} catch (failure) {
	// Leave a picture of every open page for whoever reads the failure.
	for (const [index, page] of (browser?.contexts() ?? []).flatMap(ctx => ctx.pages()).entries()) {
		await page.screenshot({ path: `${evidence}/failure-${index}.png` }).catch(() => {});
	}
	console.error(`FAIL; screenshots ${evidence}, server log ${scratch}/server.log`);
	throw failure;
} finally {
	await browser?.close(); await vite?.close(); proxy?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
