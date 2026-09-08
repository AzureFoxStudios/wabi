// Real headful rendering of production delivery/persistence rows under desktop
// CSP. No server, account, socket, native command, or message mutation involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = await mkdtemp('/tmp/wabi-message-delivery-rows-');
const csp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const vite = await createServer({
	root, configFile: false, resolve: { alias: { $lib: root + 'src/lib' } },
	server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
	plugins: [svelte({ configFile: false }), {
		name: 'message-delivery-rows', enforce: 'pre',
		resolveId(id) { if (id === '$app/environment') return '\0delivery-environment'; },
		load(id) { if (id === '\0delivery-environment') return 'export const browser=true; export const dev=true; export const building=false;'; },
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url?.split('?')[0] !== '/__delivery_rows') return next();
				res.setHeader('Content-Type', 'text/html');
				res.setHeader('Content-Security-Policy', csp);
				res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wabi delivery status fixture</title><div id="harness"></div><script type="module" src="/test/message-delivery-rows-browser-harness.ts"></script>');
			});
		}
	}]
});
let browser;
try {
	await vite.listen();
	browser = await chromium.launch({ headless: false });
	const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	page.setDefaultTimeout(15000);
	await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__delivery_rows`);
	await page.waitForFunction(() => window.__deliveryRows);
	const changing = page.locator('#changing-message');
	for (const theme of ['dark', 'light']) {
		await page.evaluate(theme => window.__deliveryRows.setTheme(theme), theme);
		for (const width of [1100, 390, 320]) {
			await page.setViewportSize({ width, height: 900 });
			await page.evaluate(() => window.__deliveryRows.setDelivery('queued'));
			await changing.getByRole('status').filter({ hasText: 'Queued — will send when online' }).waitFor();
			assert.equal(await changing.locator('.is-failed').count(), 0, 'waiting offline is not an error');
			await page.evaluate(() => window.__deliveryRows.setDelivery('sending'));
			await changing.getByRole('status').filter({ hasText: 'Sending…' }).waitFor();
			assert.equal(await changing.getByRole('status').getAttribute('aria-live'), 'polite');
			assert.equal(await changing.getByRole('status').getAttribute('aria-atomic'), 'true');
			assert.equal(await page.locator('#confirmed-message [role="status"], #received-message [role="status"]').count(), 0);
			assert.equal(await page.getByRole('button', { name: /retry/i }).count(), 0, 'legacy Retry stub is not exposed');
			assert.match(await page.locator('#legacy-retrying').textContent(), /Earlier save status is unconfirmed/);
			assert.match(await page.locator('#legacy-failed').textContent(), /Check this conversation’s history before sending again/);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
			await page.screenshot({ path: `${evidence}/${theme}-${width}.png`, fullPage: true });
			const exactError = `Not confirmed — <img src=x onerror="window.fixtureXss=true"> ${'long-diagnostic-'.repeat(18)}`;
			await page.evaluate(error => window.__deliveryRows.setDelivery('failed', error), exactError);
			await changing.getByRole('status').filter({ hasText: 'Not confirmed' }).waitFor();
			assert.equal((await changing.getByRole('status').textContent()).trim(), exactError, 'exact diagnostic remains safe text');
			assert.equal(await changing.locator('img').count(), 0);
			assert.equal(await page.evaluate(() => window.fixtureXss), undefined);
			assert.ok(await changing.getByRole('status').evaluate(node => node.scrollWidth <= node.clientWidth), 'long errors wrap inside narrow messages');
			assert.ok(await changing.getByRole('status').evaluate(node => node.getAnimations().length === 0), 'status changes add no animation');
			await page.evaluate(() => window.__deliveryRows.setDelivery(undefined));
			await changing.getByRole('status').waitFor({ state: 'hidden' });
			await page.evaluate(() => window.__deliveryRows.setDelivery('failed', 'Private sender diagnostic', false));
			assert.equal(await changing.getByRole('status').count(), 0, 'received message must not show another sender’s local error');
		}
	}
	await page.evaluate(() => window.__deliveryRows.setDelivery('failed'));
	await changing.getByRole('status').filter({ hasText: 'Delivery not confirmed.' }).waitFor();
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ status: 'passed', evidence, checks: ['live sending/failure/confirmation', 'own-message scope', 'safe exact errors', 'retained legacy warnings without Retry', 'dark/light at 1100/390/320px', 'long-error wrapping', 'polite status semantics', 'no status animation'] }));
} finally {
	await browser?.close();
	await vite.close();
}
