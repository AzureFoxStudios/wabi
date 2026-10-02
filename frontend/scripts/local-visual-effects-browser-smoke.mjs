// Compile the real Svelte shader component; exercise WebGL, SVG decoding and
// IndexedDB in an isolated headful browser without loading accounts or servers.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const desktopCsp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({ root, configFile: false,
	optimizeDeps: { noDiscovery: true, include: ['svelte', 'dompurify'] },
	server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
	plugins: [svelte({ configFile: false }), { name: 'local-effects-harness', configureServer(vite) {
		vite.middlewares.use((request, response, next) => {
			if (!['/__local_effects', '/__local_effects_reload'].includes(request.url)) return next();
			response.setHeader('Content-Type', 'text/html');
			response.setHeader('Content-Security-Policy', desktopCsp);
			response.end('<!doctype html><title>Wabi local effects verification</title>' + (request.url === '/__local_effects' ? '<script type="module" src="/test/local-visual-effects-browser-harness.ts"></script>' : 'Reload verification'));
		});
	} }]
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({ headless: false, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
	const page = await browser.newPage();
	page.on('pageerror', error => console.error(error));
	await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__local_effects`);
	await page.waitForFunction(() => ['passed', 'failed'].includes(window.__localEffectsSmoke?.status), null, { timeout: 60000 });
	const result = await page.evaluate(() => window.__localEffectsSmoke);
	if (result.status !== 'passed') { console.error(JSON.stringify(result, null, 2)); process.exitCode = 1; }
	else {
		const id = await page.evaluate(() => window.__savedImageId);
		await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__local_effects_reload`);
		const persisted = await page.evaluate(async id => {
			const library = await import('/src/lib/effects/localVisualEffects.ts');
			const record = await library.getLocalVisualEffect(id);
			await library.removeLocalVisualEffect(id);
			return record?.tileWidth === 96 && record?.tileHeight === 48 && record?.imageBlob instanceof Blob;
		}, id);
		if (!persisted) throw new Error('Real-origin IndexedDB reload lost rectangular image metadata');
		result.results.push('real-origin IndexedDB survives page navigation and reload');
		console.log(JSON.stringify(result, null, 2));
	}
} finally { await browser?.close(); await server.close(); }
