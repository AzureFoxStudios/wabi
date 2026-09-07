// Headful, isolated media harness. Does not load Wabi accounts, connect to a
// deployed server, acquire real microphones, or play sound through speakers.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktopCsp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({
	root,
	configFile: false, // isolated from SvelteKit generation and application state
	resolve: { alias: { $lib: fileURLToPath(new URL('../src/lib', import.meta.url)) } },
	server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
	plugins: [svelte({ configFile: false }), { name: 'audio-smoke-harness', enforce: 'pre',
		// Model the browser environment without booting SvelteKit or
		// regenerating its output alongside an application build.
		resolveId(id, importer) {
			if (id === '$app/environment') return '\0audio-smoke-environment';
			const entry = id.replace(root + 'src/lib/', '$lib/').replace(/\.ts$/, '');
			if (importer?.split('?')[0].endsWith('/AudioSettingsTab.svelte') && ['$lib/calling', '$lib/desktopHelper', '$lib/callRecording', '$lib/i18n'].includes(entry)) {
				return fileURLToPath(new URL('../test/audio-settings-boundaries.ts', import.meta.url));
			}
		},
		load(id) { if (id === '\0audio-smoke-environment') return 'export const browser=true; export const dev=true; export const building=false;'; },
		configureServer(vite) {
		vite.middlewares.use((req, res, next) => {
			if (req.url !== '/__audio_smoke' && req.url !== '/__audio_settings') return next();
			res.setHeader('Content-Type', 'text/html');
			res.setHeader('Content-Security-Policy', desktopCsp);
			const harness = req.url === '/__audio_settings' ? 'audio-settings-browser-harness' : 'audio-browser-harness';
			res.end(`<!doctype html><title>Wabi isolated audio verification</title><button id="run">Run synthetic audio tests</button><p>No microphone access or speaker output.</p><div id="settings"></div><script type="module" src="/test/${harness}.ts"></script>`);
		});
	} }]
});
let browser;
try {
	await server.listen();
	const address = server.httpServer.address();
	browser = await chromium.launch({ headless: false });
	const page = await browser.newPage();
	page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error('[browser]', message.text()); });
	page.on('pageerror', error => console.error('[browser]', error.message));
	for (const route of ['/__audio_smoke', '/__audio_settings']) {
		await page.goto(`http://127.0.0.1:${address.port}${route}`);
		await page.waitForFunction(() => window.__audioSmoke?.status === 'ready');
		await page.locator('#run').click();
		await page.waitForFunction(() => ['passed', 'failed'].includes(window.__audioSmoke?.status), null, { timeout: 90000 });
		const result = await page.evaluate(() => window.__audioSmoke);
		console.log(JSON.stringify({ route, ...result }, null, 2));
		if (result.status !== 'passed') process.exitCode = 1;
	}
} finally {
	await browser?.close();
	await server.close();
}
