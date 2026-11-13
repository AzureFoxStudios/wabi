// Real application and a disposable default-build Authority, in headful Chromium.
//
// The server is the lean core a plain download gives you: `cargo build -p
// wabi-server` with no features, nothing switched on, so GET /api/addons
// reports every add-on as off and the feature-gated ones (Lore, webhooks,
// payment rails) are not in the binary at all.
//
// What this proves: walking the shell the way a person does — channel list,
// channel creation, the workspace list, the companion-panel list and Settings
// → Add-ons — turns up no add-on entry point that is offered as usable. Each
// one is either absent, or disabled with a sentence that says it is not
// enabled on this server. Nothing calls an add-on route that is not there.
//
// AGENTS.md: "core Wabi should remain usable with optional plugins/helpers
// disabled". docs/VISION.md: a tool "may never weaken a core guarantee", and
// add-ons are Tools.
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
const scratch = await mkdtemp('/tmp/wabi-addons-absent-');
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const backend = `http://127.0.0.1:${port}`;
const server = spawn(
	process.env.WABI_SMOKE_SERVER_BINARY ||
		fileURLToPath(new URL('../../target/release/wabi-server', import.meta.url)),
	['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)],
	// A cleared environment: no WABI_*_ENABLED can leak in from the runner.
	{ cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'] }
);
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log);
server.stderr.pipe(log);

let browser, vite, page;
try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated backend exited: ${scratch}`);
		try {
			ready = (await fetch(`${backend}/readyz`)).ok;
		} catch {
			/* starting */
		}
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'isolated backend ready');

	// The server's own answer, so the UI assertions below are measured against
	// what this build really reports rather than an assumption.
	const inventory = await (await fetch(`${backend}/api/addons`)).json();
	const enabled = inventory.addons.filter((addon) => addon.enabled);
	assert.deepEqual(enabled, [], `default build reports add-ons as enabled: ${JSON.stringify(enabled)}`);
	const listed = inventory.addons.map((addon) => addon.id);
	for (const gated of ['lore', 'webhooks', 'payments-crypto', 'payments-eu', 'payments-us']) {
		assert.ok(!listed.includes(gated), `${gated} is feature-gated and must not be listed: ${listed}`);
	}

	const registration = await fetch(`${backend}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: 'addon_audit_owner', password: 'Local-mobile-fixture-9825!' })
	});
	assert.equal(registration.status, 200);
	const account = await registration.json();

	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({
		headless: false,
		executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH
	});
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(15000);

	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	// Every request to a route that only exists with an add-on compiled in.
	const addonRequests = [];
	page.on('request', (request) => {
		const url = request.url();
		if (/\/api\/addons\/lore\//.test(url) || /\/api\/plugins/.test(url)) {
			addonRequests.push(`${request.method()} ${url.replace(backend, '')}`);
		}
	});

	await page.addInitScript(
		({ backend, account }) => {
			if (sessionStorage.getItem('addon-audit-seeded')) return;
			sessionStorage.setItem('addon-audit-seeded', '1');
			const scope = encodeURIComponent(backend);
			sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
			localStorage.setItem(`wabi_username:${scope}`, account.user.username);
			localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
			localStorage.setItem('notificationsEnabled', 'false');
		},
		{ backend, account }
	);
	// The first navigation compiles the app in the dev server; give it its own
	// budget rather than the per-action default.
	await page.goto(origin, { waitUntil: 'networkidle', timeout: 120000 });
	await waitForAppShell(page);

	// ---------------------------------------------------------------------
	// 1. The companion-panel list offers no panel that needs a missing add-on.
	// ---------------------------------------------------------------------
	// "Project" (panel id `code`) browses a Lore repository and can do nothing
	// else. On a server without Lore it must not be in the list people pick
	// panels from.
	const panels = await page.evaluate(async () => {
		const module = await import('/src/lib/workspacePanels.ts');
		let value = [];
		const stop = module.workspacePanelList.subscribe((list) => (value = list));
		stop();
		return value.map((panel) => panel.id);
	});
	assert.ok(
		!panels.includes('code'),
		`the Lore-only "Project" panel is still offered on a server without Lore: ${panels}`
	);
	// The core panels are all still there: withdrawing an add-on panel must not
	// thin out the shell.
	for (const core of ['users', 'dms', 'notes', 'wiki', 'forum', 'media']) {
		assert.ok(panels.includes(core), `core panel ${core} went missing: ${panels}`);
	}

	// ---------------------------------------------------------------------
	// 2. Channel creation does not offer a kind this server cannot create.
	// ---------------------------------------------------------------------
	await page.getByRole('button', { name: 'Channel actions' }).first().click();
	await page.getByText('New channel', { exact: true }).first().click();
	const dialog = page.locator('[role=dialog]').first();
	await dialog.waitFor();
	const loreKind = dialog.locator('.create-kind.unavailable');
	assert.equal(
		await loreKind.count(),
		1,
		'the Lore channel kind is offered as usable on a server without the Lore add-on'
	);
	await loreKind.getByText('Needs the Lore add-on', { exact: true }).waitFor();
	await page.screenshot({ path: `${scratch}/create-channel.png` });
	await page.keyboard.press('Escape');

	// ---------------------------------------------------------------------
	// 3. Settings → Add-ons tells the truth about every server row.
	// ---------------------------------------------------------------------
	await page.locator('button[aria-label="Settings"]').first().click();
	await page.locator('button:has-text("Add-ons")').first().click();
	const serverSection = page.locator('.addons-server');
	await serverSection.waitFor();
	// Not one server add-on may show as on: the server reports none.
	assert.equal(
		await serverSection.locator('[role=switch][aria-checked="true"]').count(),
		0,
		'Settings → Add-ons shows a server add-on as on, but the server reports none enabled'
	);
	// The rows the server says are switchable are switchable here: this is the
	// in-app detach path in docs/addons/ATTACH_DETACH.md, and it silently
	// rendered every row as locked when the inventory fields were dropped on
	// the way to the row.
	const switchable = inventory.addons.filter((addon) => addon.runtimeSwitch).map((a) => a.name);
	assert.ok(switchable.length > 0, 'this build reports no switchable add-on at all');
	assert.equal(
		await serverSection.locator('[role=switch]').count(),
		switchable.length,
		`the server reports ${switchable.length} switchable add-ons (${switchable.join(', ')}) ` +
			'but Settings shows a different number of switches'
	);
	// Nothing claims a feature-gated add-on this binary does not hold.
	const sectionText = await serverSection.innerText();
	for (const gated of ['Lore', 'Webhooks']) {
		assert.ok(
			!sectionText.includes(gated),
			`Settings lists ${gated}, which is not compiled into this build`
		);
	}
	await page.screenshot({ path: `${scratch}/settings-addons.png` });
	await page.keyboard.press('Escape');

	// ---------------------------------------------------------------------
	// 4. Nothing called a route that is not in this build.
	// ---------------------------------------------------------------------
	assert.deepEqual(
		addonRequests,
		[],
		`the app called add-on routes that a default build does not serve: ${addonRequests.join(', ')}`
	);
	assert.deepEqual(errors, [], 'no browser exceptions');

	await page.screenshot({ path: `${scratch}/shell-core-only.png` });
	console.log(
		`PASS core shell on a default build: no add-on entry point offered as usable, ` +
			`no add-on-only request made; evidence ${scratch}`
	);
} finally {
	await browser?.close();
	await vite?.close();
	server.kill('SIGTERM');
	await new Promise((resolve) => {
		if (server.exitCode !== null) resolve();
		else {
			server.once('exit', resolve);
			setTimeout(resolve, 5000);
		}
	});
	log.end();
}
