// Full application, real isolated WabiDB + HTTP/socket server, headful Chromium.
// No live account, host service restart, microphone acquisition or Lore binary.
// Run AFTER checks/builds: node scripts/workspace-browser-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { probePanelPersistence, runPanelPolishChecks } from './panel-polish-checks.mjs';
import { runComposerSettingsChecks } from './composer-settings-polish-checks.mjs';
import { runAdminPolishChecks } from './admin-polish-checks.mjs';
import { runComposerSendChecks } from './composer-send-polish-checks.mjs';
import { runMessageDeliveryAppChecks } from './message-delivery-app-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-workspace-smoke-');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const backend = `http://127.0.0.1:${port}`;
const server = spawn(fileURLToPath(new URL('../../target/release/wabi-server', import.meta.url)),
	['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)],
	{ cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser, vite, page;
try {
	let healthy = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated server exited: ${scratch}`);
		try { healthy = (await fetch(`${backend}/readyz`)).ok; } catch { /* starting */ }
		if (healthy) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(healthy, 'isolated backend ready');
	const registered = await fetch(`${backend}/api/auth/register`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: 'workspace_fixture', password: 'Local-fixture-only-9825!' })
	});
	assert.equal(registered.status, 200);
	const account = await registered.json();
	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false });
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(({ backend, account }) => {
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });
	const trigger = page.locator('.workspace-trigger');
	await trigger.waitFor({ state: 'visible', timeout: 60000 });
	console.log('PIN PERSISTENCE PROBE', await probePanelPersistence(page));
	await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.closeRightPanel());
	await runComposerSettingsChecks(page);
	await runMessageDeliveryAppChecks(page);
	await runComposerSendChecks(page);
	await runAdminPolishChecks(page, scratch);
	const anchor = await trigger.boundingBox();
	const originalTrigger = await trigger.elementHandle();
	async function choose(label) {
		await trigger.click();
		await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: label }).click();
		await page.waitForFunction(label => document.querySelector('.workspace-current')?.textContent === label, label);
		assert.ok(await originalTrigger.evaluate(node => node === document.activeElement), `${label}: focus retained on persistent trigger`);
		const box = await trigger.boundingBox();
		assert.equal(box.x, anchor.x, `${label}: stable x`);
		assert.equal(box.y, anchor.y, `${label}: stable y`);
	}
	await choose('Planner');
	await page.locator('.planner-surface').waitFor();
	await choose('Files');
	await page.locator('.files-workspace').waitFor();
	await choose('Whiteboard');
	await page.locator('.whiteboard-surface').waitFor();
	await choose('Project');
	await page.locator('.lore-workspace').waitFor();
	await choose('Notes');
	await page.locator('.notes-workspace').waitFor();
	const notes = await page.locator('.notes-workspace').boundingBox();
	assert.ok(notes.y + notes.height <= 900, 'Notes fits remaining viewport height');
	await page.screenshot({ path: `${scratch}/notes-desktop.png` });
	await choose('Calls');
	await page.locator('.vv').waitFor();
	await choose('Messages');
	for (const label of ['Reader', '3D viewer', 'Map', 'Media']) await choose(label);
	await choose('Messages');
	await trigger.focus();
	await page.keyboard.press('Enter');
	await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Notes' }).focus();
	await page.keyboard.press('Enter');
	assert.ok(await trigger.evaluate(node => node === document.activeElement), 'keyboard selection retains focus');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Escape');
	assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
	assert.ok(await trigger.evaluate(node => node === document.activeElement), 'Escape restores focus');
	await trigger.click();
	await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Map', exact: true }).focus();
	await page.keyboard.press('Tab');
	assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Tab can leave the nonmodal picker');
	await trigger.click();
	await page.locator('.notes-editor').click({ position: { x: 600, y: 300 } });
	assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'outside press dismisses picker');
	await trigger.click();
	await page.screenshot({ path: `${scratch}/picker-desktop.png` });
	const hoverOption = page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Files', exact: true });
	const hoverBounds = await hoverOption.boundingBox();
	await hoverOption.hover();
	await hoverOption.evaluate(node => node.getAnimations().forEach(animation => animation.updatePlaybackRate(0.1)));
	await page.screenshot({ path: `${scratch}/picker-hover-slow.png` });
	assert.deepEqual(await hoverOption.boundingBox(), hoverBounds, 'hover does not move or resize targets at 10% playback');
	await page.keyboard.press('Escape');
	// Docking consumes center-pane width; test the actual pinned People panel.
	await page.setViewportSize({ width: 1000, height: 800 });
	await page.getByRole('button', { name: 'People', exact: true }).click();
	await page.locator('.right-panel.is-pinned').waitFor();
	for (const label of ['Files', 'Whiteboard', 'Notes']) {
		await choose(label);
		assert.equal(await page.locator('.right-panel.is-pinned').count(), 1, 'switching workspaces preserves the pinned panel');
	}
	for (const viewport of [{ width: 1000, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
		if (viewport.width === 390) {
			// Reset the fixture between docking and mobile scenarios. Mobile
			// panels intentionally overlay the center; this is not an unpin test.
			await page.mouse.move(10, 10);
			await trigger.focus();
			await page.evaluate(async () => (await import('/src/lib/layoutStore.ts')).layoutStore.closeRightPanel());
		}
		await page.setViewportSize(viewport);
		await trigger.click();
		const picker = page.getByRole('dialog', { name: 'Choose workspace' });
		const box = await picker.boundingBox();
		const main = await page.locator('.main-content').boundingBox();
		assert.ok(box.x >= main.x && box.x + box.width <= main.x + main.width, 'picker stays inside center pane');
		assert.ok(box.y + box.height <= viewport.height, 'picker stays within viewport');
		const options = picker.getByRole('button');
		assert.equal(await options.count(), 11);
		for (const option of await options.all()) {
			await option.scrollIntoViewIfNeeded();
			const rect = await option.boundingBox();
			assert.ok(rect.height >= 44 && rect.width >= 44, 'touch targets >=44px');
			assert.ok(await option.evaluate(node => { const b=node.getBoundingClientRect(); return node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)); }), 'option receives pointer hits');
		}
		await picker.evaluate(node => node.scrollTop = 0);
		await page.screenshot({ path: `${scratch}/picker-${viewport.width}.png` });
		await page.keyboard.press('Escape');
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.evaluate(async () => {
		const { themeStore } = await import('/src/lib/theme/themeStore.ts');
		themeStore.setThemeId('light');
	});
	await trigger.click();
	await page.screenshot({ path: `${scratch}/picker-light.png` });
	assert.ok(await trigger.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(duration => parseFloat(duration) <= 0.001)), 'reduced motion honored (including the global near-zero override)');
	await page.keyboard.press('Escape');
	const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	touch.setDefaultTimeout(15000);
	touch.on('pageerror', error => errors.push(error.message));
	await touch.addInitScript(({ backend, account }) => {
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
	}, { backend, account });
	// Exercise the new lazy-load error boundary in a fresh module realm.
	await touch.route('**/LoreWorkspace.svelte*', route => route.abort());
	await touch.goto(origin, { waitUntil: 'networkidle' });
	await touch.locator('.workspace-trigger').waitFor({ timeout: 60000 });
	await touch.locator('.workspace-trigger').tap();
	await touch.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Notes', exact: true }).tap();
	await touch.locator('.notes-workspace').waitFor();
	await touch.locator('.workspace-trigger').tap();
	await touch.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Project', exact: true }).tap();
	await touch.getByRole('alert').filter({ hasText: "Couldn't load Project" }).waitFor();
	await touch.getByRole('button', { name: 'Return to messages', exact: true }).tap();
	assert.equal(await touch.locator('.workspace-current').textContent(), 'Messages', 'touch return works even when a workspace module fails');
	await touch.close();
	await runPanelPolishChecks(page, scratch);
	assert.deepEqual(errors, [], 'no uncaught application errors');
	console.log(JSON.stringify({ status: 'passed', evidence: scratch, checks: ['actual workspace transitions', 'persistent keyboard focus', 'stable anchor', 'Notes height', 'pinned panel + responsive picker', 'touch taps + hit targets', 'lazy-load failure escape', 'light theme + reduced/slow motion'] }));
} catch (error) {
	await page?.screenshot({ path: `${scratch}/failure.png` }).catch(() => {});
	console.error(`Evidence: ${scratch}`);
	throw error;
} finally {
	await browser?.close();
	await vite?.close();
	if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
	log.end();
}
