// Real application and isolated backend, rendered in headful Chromium.
// Desktop docks must not become unsolicited full-screen mobile overlays.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-mobile-panel-resize-');
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
		body: JSON.stringify({ username: 'mobile_panel_fixture', password: 'Local-mobile-fixture-9825!' })
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
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });
	await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
	await page.waitForFunction(async () => (await import('/src/lib/layoutStoreStates.ts')).layoutLoaded);
	await page.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.closeRightPanel();
		layoutStore.pinPanel('users');
		layoutStore.rightPanelWidth.set(360);
	});
	await page.locator('.workspace-trigger').click();
	await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
	await page.locator('.chat-surface .notes-workspace').waitFor();
	await page.locator('.chat-surface').getByRole('button', { name: 'New note', exact: true }).first().click();
	const editor = page.locator('.chat-surface').getByRole('textbox', { name: 'Note text', exact: true });
	await editor.fill('Keep this note visible when the window narrows.');
	await page.mouse.move(500, 400);
	await page.screenshot({ path: `${scratch}/notes-desktop.png` });
	const desktopDock = await readSavedDock(page);
	assert.equal(desktopDock.panel, 'users');
	assert.equal(desktopDock.collapsed, false);
	assert.equal(desktopDock.width, 360);
	for (const width of [390, 360]) {
		await page.setViewportSize({ width, height: 844 });
		await page.waitForFunction(() => document.documentElement.dataset.shell === 'mobile');
		await page.screenshot({ path: `${scratch}/notes-mobile-${width}.png` });
		assert.equal(await page.locator('.mobile-right-overlay.visible').count(), 0, 'resizing must not open a mobile panel');
		assert.equal(await editor.innerText(), 'Keep this note visible when the window narrows.');
		assert.ok(await receivesPointer(editor), 'the note editor remains reachable');
		assert.ok(await receivesPointer(page.locator('.workspace-trigger')), 'workspace navigation remains reachable');
		assert.deepEqual(await readSavedDock(page), desktopDock, 'resize preserves the saved desktop dock');
	}
	// Opening the picker must still lift its bottom sheet above mobile navigation.
	await page.locator('.workspace-trigger').click();
	const picker = page.getByRole('dialog', { name: 'Choose workspace' });
	const lastWorkspace = picker.getByRole('button', { name: 'Map', exact: true });
	await lastWorkspace.scrollIntoViewIfNeeded();
	assert.ok(await receivesPointer(lastWorkspace), 'the open workspace picker stays above mobile navigation');
	await picker.getByRole('button', { name: 'Notes', exact: true }).click();
	assert.equal(await editor.innerText(), 'Keep this note visible when the window narrows.');
	// Open the actual mobile panel through the existing shared action, then use
	// the normal Chat button to close it. Neither action is a desktop unpin.
	await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.showUsersTab());
	await page.locator('.mobile-right-overlay.visible').waitFor();
	await page.locator('.mobile-right-overlay input').first().click();
	await page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Chat', exact: true }).click();
	await page.locator('.mobile-right-overlay.visible').waitFor({ state: 'hidden' });
	assert.deepEqual(await readSavedDock(page), desktopDock, 'mobile close preserves the saved desktop pin');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.locator('.right-panel.is-pinned').waitFor();
	assert.deepEqual(await readSavedDock(page), desktopDock);
	assert.equal(await page.locator('.right-panel-zone').boundingBox().then(box => Math.round(box.width)), 360);
	assert.equal(await page.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		let value; const off = layoutStore.activeRightTab.subscribe(next => value = next); off(); return value;
	}), 'users');
	await page.screenshot({ path: `${scratch}/desktop-restored.png` });
	// A cold mobile load must also leave the saved desktop dock intact.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload({ waitUntil: 'networkidle' });
	await page.locator('.workspace-trigger').waitFor();
	await page.waitForFunction(async () => (await import('/src/lib/layoutStoreStates.ts')).layoutLoaded);
	assert.equal(await page.locator('.mobile-right-overlay.visible').count(), 0);
	await page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Browse', exact: true }).click();
	await page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Chat', exact: true }).click();
	assert.deepEqual(await readSavedDock(page), desktopDock, 'cold mobile navigation preserves the saved desktop dock');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.locator('.right-panel.is-pinned').waitFor();
	assert.deepEqual(await readSavedDock(page), desktopDock);
	// A mobile action must not invent a pin when the desktop dock was closed.
	await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.closeRightPanel());
	await page.locator('.right-panel.is-pinned').waitFor({ state: 'hidden' });
	const closedDock = await readSavedDock(page);
	assert.equal(closedDock.collapsed, true);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForFunction(() => document.documentElement.dataset.shell === 'mobile');
	await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.showUsersTab());
	await page.locator('.mobile-right-overlay input').first().click();
	await page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Chat', exact: true }).click();
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForFunction(() => document.documentElement.dataset.shell !== 'mobile');
	assert.equal(await page.locator('.right-panel.is-pinned').count(), 0);
	assert.deepEqual(await readSavedDock(page), closedDock, 'mobile navigation preserves a closed desktop dock');
	// Resizing can interrupt a touch before touchend; desktop chrome must not
	// retain the partially faded gesture preview or its disabled transition.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForFunction(() => document.documentElement.dataset.shell === 'mobile');
	await page.evaluate(() => {
		const target = document.querySelector('.chat-surface');
		for (const [type, clientX] of [['touchstart', 5], ['touchmove', 45]]) {
			const touch = new Touch({ identifier: 1, target, clientX, clientY: 400 });
			target.dispatchEvent(new TouchEvent(type, { touches: [touch], changedTouches: [touch], bubbles: true, cancelable: true }));
		}
	});
	await page.waitForFunction(() => {
		const sidebar = document.querySelector('.channel-sidebar-container');
		return sidebar && Number(getComputedStyle(sidebar).opacity) < 1;
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForFunction(() => {
		const sidebar = document.querySelector('.channel-sidebar-container');
		return sidebar && getComputedStyle(sidebar).opacity === '1' && sidebar.style.transition !== 'none';
	});
	assert.deepEqual(await readSavedDock(page), closedDock);
	assert.deepEqual(errors, []);
	console.log(`PASS: mobile resize, picker layering, explicit panels, saved open/closed docks, cold mobile load and interrupted swipe. Screenshots: ${scratch}`);
} catch (error) {
	await page?.screenshot({ path: `${scratch}/failure.png` }).catch(() => {});
	console.error('Panel geometry:', await page?.evaluate(() => {
		const panel = document.querySelector('.mobile-right-overlay');
		return panel ? {
			classes: panel.className, inline: panel.getAttribute('style'), bounds: panel.getBoundingClientRect().toJSON(),
			layers: ['.mobile-right-overlay', '.workspace-view-bar', '.main-content', '.chat-stack', '.app-container'].map(selector => {
				const node = document.querySelector(selector); const css = getComputedStyle(node);
				return { selector, z: css.zIndex, position: css.position, isolation: css.isolation, transform: css.transform, modal: css.getPropertyValue('--z-modal') };
			})
		} : null;
	}).catch(() => null));
	console.error(`Mobile panel regression evidence: ${scratch}`);
	throw error;
} finally {
	await browser?.close();
	await vite?.close();
	server.kill('SIGTERM');
	log.end();
}

async function receivesPointer(locator) {
	return locator.evaluate(node => {
		const r = node.getBoundingClientRect();
		return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
	});
}

async function readSavedDock(page) {
	return page.evaluate(async () => {
		await Promise.resolve();
		const { layoutState } = await import('/src/lib/layoutStoreStates.ts');
		const { getWorkspace, getAuxTabset } = await import('/src/lib/docking/layoutSchema.ts');
		const { getDockActivePanelId } = await import('/src/lib/layoutStoreUtils.ts');
		let state; const off = layoutState.subscribe(value => state = value); off();
		const workspace = getWorkspace(state); const aux = getAuxTabset(workspace);
		return { panel: getDockActivePanelId(workspace.panelDock), collapsed: aux.collapsed, width: aux.size };
	});
}
