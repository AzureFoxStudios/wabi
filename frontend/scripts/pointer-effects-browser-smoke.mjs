// Real Svelte components, real pointer events and a headful browser. Instrument
// drawing only to observe pixels/lifetime; no account or backend is loaded.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.env.POINTER_EFFECTS_SCREENSHOTS || fileURLToPath(new URL('../test-results/pointer-effects', import.meta.url)));
mkdirSync(output, { recursive: true });
const desktopCsp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, include: ['svelte', 'dompurify'] },
	server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: { ignored: ['**/.svelte-kit/**', '**/build/**'] }, fs: { allow: [root, output] } },
	plugins: [svelte({ configFile: false }), { name: 'pointer-effects-harness', configureServer(vite) {
		vite.middlewares.use((request, response, next) => {
			if (request.url !== '/__pointer_effects') return next();
			response.setHeader('Content-Type', 'text/html'); response.setHeader('Content-Security-Policy', desktopCsp);
			response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wabi pointer effects verification</title><script type="module" src="/test/pointer-effects-browser-harness.ts"></script>');
		});
	} }]
});
let browser;
const results = [], failures = [], patternResults = [];
const check = (condition, label, detail) => { (condition ? results : failures).push(condition ? label : { label, detail }); if (!condition) console.error('FAIL', label, detail ?? ''); };
try {
	await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
	page.on('pageerror', error => { failures.push({ label: 'browser runtime exception', detail: error.message }); console.error(error); });
	await page.goto(origin + '/__pointer_effects'); await page.waitForFunction(() => window.__pointerSmoke?.ready);
	const stats = () => page.evaluate(() => window.__pointerSmoke.stats());
	const apply = async patch => { await page.evaluate(patch => window.__pointerSmoke.apply(patch), patch); await page.waitForTimeout(40); };
	const move = async (x = 980, y = 680) => { await page.mouse.move(x - 160, y - 80); await page.mouse.move(x, y, { steps: 10 }); await page.waitForTimeout(35); };
	const alive = data => data.overlay !== 'none' && (data.glow > 0 || data.canvases.some(canvas => canvas.display !== 'none' && canvas.count > 0));
	const patterns = await page.evaluate(() => window.__pointerSmoke.patterns);
	check(patterns.length === 40, 'all40 built-ins are present');
	check(await page.locator('#feeler-pattern optgroup').evaluateAll(nodes => nodes.map(node => node.label)).then(names => ['Basics', 'Little Worlds', 'Connected Worlds'].every(name => names.includes(name))), 'settings keep all three families separate');
	for (const [key, label] of [['intensity', 'Glow strength'], ['textureOpacity', 'Texture / effect strength'], ['radius', 'Radius'], ['patternScale', 'Spacing / pattern scale'], ['idleDelayMs', 'Idle delay'], ['fadeMs', 'Fade duration'], ['trailMs', 'Trail duration'], ['trailStrength', 'Trail strength']]) {
		const before = (await stats()).settings[key];
		await page.getByLabel(label, { exact: true }).focus(); await page.keyboard.press('ArrowRight');
		check((await stats()).settings[key] > before, `${label} updates saved preferences through its real keyboard control`);
	}
	await page.getByRole('switch', { name: 'Enable pointer effects' }).click();
	check(!(await stats()).enabled, 'the settings switch disables the production host');
	await page.getByRole('switch', { name: 'Enable pointer effects' }).click();
	check((await stats()).enabled, 'the settings switch enables the production host');
	await page.locator('#feeler-pattern').selectOption('maze');
	for (const [key, label] of [['fieldDensity', 'Field density'], ['settleSpeed', 'Settle speed'], ['mazeCurve', 'Maze curve'], ['response', 'Pointer response']]) {
		const before = (await stats()).settings[key];
		await page.getByLabel(label, { exact: true }).focus(); await page.keyboard.press('ArrowRight');
		check((await stats()).settings[key] > before, `${label} updates its connected-world setting`);
	}
	await page.getByLabel('Layout seed', { exact: true }).fill('4242'); await page.keyboard.press('Tab');
	check((await stats()).settings.seed === 4242, 'the seed control saves an explicit arrangement');
	await page.getByRole('button', { name: 'Reshuffle', exact: true }).click();
	check((await stats()).settings.seed !== 4242, 'Reshuffle chooses a different layout seed');
	await page.locator('#feeler-pattern').selectOption('water');
	await page.getByLabel('Material detail', { exact: true }).focus(); await page.keyboard.press('ArrowRight');
	check((await stats()).settings.materialDetail > 1, 'Material detail updates through its relevant control');
	await page.locator('aside').evaluate(element => { element.scrollTop = 0; });
	await apply({ enabled: true, intensity: .05, textureOpacity: .4, radius: 260, patternScale: 1.2, idleDelayMs: 300, fadeMs: 1200, trailMs: 900, trailStrength: .65, seed: 104729, fieldDensity: 1, settleSpeed: 1, mazeCurve: .7, response: .65, materialDetail: 1 });
	for (let i = 0; i < patterns.length; i++) {
		const pattern = patterns[i];
		await page.locator('#feeler-pattern').selectOption(pattern.id);
		await page.waitForTimeout(45); await move(980 + i % 3, 680 + i % 5);
		const data = await stats();
		const pixels = data.canvases.filter(canvas => canvas.display !== 'none').reduce((sum, canvas) => sum + canvas.count, 0);
		check(pattern.id === 'none' ? data.glow > 0 : pixels > 2, `physical mouse renders ${pattern.name}`, { pixels, data });
		check(data.canvases.every(canvas => canvas.width <= 1024 && canvas.height <= 1024), `${pattern.name} stays within its backing-surface budget`);
		await page.screenshot({ path: resolve(output, `${String(i + 1).padStart(2, '0')}-${pattern.id}.png`), clip: { x: 560, y: 420, width: 820, height: 520 } });
		patternResults.push({ id: pattern.id, name: pattern.name, pixels, screenshot: `${String(i + 1).padStart(2, '0')}-${pattern.id}.png` });
	}
	await page.locator('#feeler-pattern').selectOption('creatures'); await move();
	await page.screenshot({ path: resolve(output, 'pointer-effects-settings.png') });
	await apply({ textureOpacity: .16, intensity: .05, radius: 190, patternScale: 1, idleDelayMs: 90, fadeMs: 520, trailMs: 280, trailStrength: .5 });
	for (const pattern of ['triangles', 'creatures', 'tabletop', 'lattice', 'climb-route', 'water', 'sand']) {
		await apply({ pattern }); await move();
		await page.screenshot({ path: resolve(output, `default-${pattern}.png`) });
	}
	await page.locator('#passthrough').click();
	check((await page.locator('#passthrough').textContent()).trim().endsWith('1'), 'effect overlay never captures underlying button clicks');

	await apply({ pattern: 'sand', idleDelayMs: 30, fadeMs: 150, trailMs: 200, settleSpeed: 4 });
	await move(); await page.waitForTimeout(450);
	let data = await stats(); check(!alive(data) && data.pending === 0, 'material settles completely and stops scheduling frames', data);
	const idleFrames = data.frames;
	await apply({ radius: 240, intensity: .08, textureOpacity: .3, patternScale: 1.1 }); await page.waitForTimeout(100);
	data = await stats(); check(!alive(data) && data.frames === idleFrames, 'settings changes while idle do not create pointer activity', data);
	await apply({ enabled: false }); await apply({ pattern: 'dots', radius: 200 }); await move(); data = await stats();
	check(!alive(data) && data.pending === 0, 'disabled effects remain asleep during movement and settings changes', data);
	check(await page.locator('#feeler-pattern').isDisabled(), 'effect picker is disabled while effects are off');
	await apply({ enabled: true, pattern: 'dots', idleDelayMs: 300, fadeMs: 600, trailMs: 600 }); await move();
	await page.evaluate(() => window.dispatchEvent(new Event('blur'))); const afterBlur = await stats(); await page.waitForTimeout(80); data = await stats();
	check(!alive(data) && data.pending === 0 && data.frames === afterBlur.frames, 'blur cancels pending frames and never resurrects the effect', data);
	await move(1010, 700); await page.evaluate(() => window.__pointerSmoke.hidden(true)); const afterHide = await stats(); await page.waitForTimeout(80); data = await stats();
	check(!alive(data) && data.pending === 0 && data.frames === afterHide.frames, 'hidden-document transition cancels drawing and pending frames', data);
	await page.evaluate(() => window.__pointerSmoke.hidden(false)); await move(1020, 700);
	await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(50); data = await stats();
	check(!alive(data) && data.pending === 0, 'reduced motion immediately clears active rendering', data);
	check(await page.getByRole('button', { name: 'Draw a sample sweep' }).isDisabled(), 'settings explain and disable sample sweep under reduced motion');
	await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.waitForTimeout(50);

	await apply({ pattern: 'water', idleDelayMs: 90, fadeMs: 520, trailMs: 500 });
	const beforeDemo = JSON.stringify((await stats()).settings);
	await page.getByRole('button', { name: 'Draw a sample sweep' }).click(); await page.waitForTimeout(100);
	check((await stats()).running && await page.getByRole('button', { name: 'Stop sample sweep' }).count() === 1, 'settings sample button starts a visible sweep with Stop state');
	await page.getByRole('button', { name: 'Stop sample sweep' }).click(); data = await stats();
	check(!data.running && !alive(data), 'Stop sample sweep cancels the demo and clears its tail', data);
	await page.getByRole('button', { name: 'Draw a sample sweep' }).click(); await page.waitForTimeout(70); await page.mouse.move(1100, 780); await page.waitForTimeout(50); data = await stats();
	check(!data.running && data.glowRect && Math.abs(data.glowRect.x + data.settings.radius - 1100) < 2, 'real mouse takes over sample sweep at the exact physical position', data);
	check(data.canvases.every(canvas => canvas.display === 'none' || canvas.rect.x > 600), 'real takeover starts a new stroke without connecting to the artificial settings trail', data);
	await page.getByRole('button', { name: 'Draw a sample sweep' }).click(); await page.keyboard.press('Escape'); await page.waitForTimeout(25); data = await stats();
	check(!data.running && !alive(data), 'Escape cancels a sample sweep and its historical tail', data);
	check(JSON.stringify(data.settings) === beforeDemo, 'sample sweeps never change saved preferences');

	// Physical input across the page after importing through the real settings controls.
	await apply({ pattern: 'triangles', enabled: true, idleDelayMs: 300, fadeMs: 700, trailMs: 300 });
	await page.getByLabel('Import pointer image', { exact: true }).setInputFiles({ name: 'rectangle.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#00d9ff"/></svg>') });
	await page.getByRole('button', { name: 'Use rectangle', exact: true }).waitFor();
	check((await stats()).settings.pattern === 'local' && (await stats()).settings.enabled, 'successful image import selects the new image and preserves the enabled state');
	await page.getByRole('button', { name: 'Use rectangle', exact: true }).click(); await page.waitForTimeout(80); await move(); data = await stats();
	check(data.settings.pattern === 'local' && data.canvases.some(canvas => canvas.count > 10 && canvas.blue > canvas.red), 'Use activates the imported rectangle through the production host', data);
	const imageSelection = (await stats()).settings.customEffectId;
	await page.getByLabel('Import pointer shader', { exact: true }).setInputFiles({ name: 'local-wake.frag', mimeType: 'text/plain', buffer: Buffer.from('void mainImage(out vec4 color,in vec2 pixel){color=vec4(0.2,0.8,1.0,0.5);}') });
	await page.getByRole('button', { name: 'Use local-wake', exact: true }).waitFor();
	check((await stats()).settings.customEffectId !== imageSelection && (await stats()).settings.enabled, 'successful shader import selects the new shader and preserves the enabled state');
	await page.getByRole('button', { name: 'Use local-wake', exact: true }).click(); await page.waitForTimeout(80); await move(); data = await stats();
	check(data.canvases.some(canvas => canvas.count > 20), 'imported shader renders through the production host', data);
	await apply({ enabled: false });
	await page.getByLabel('Import pointer image', { exact: true }).setInputFiles({ name: 'disabled-art.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#22aaff"/></svg>') });
	await page.getByRole('button', { name: 'Use disabled-art', exact: true }).waitFor(); await move(); data = await stats();
	check(!data.settings.enabled && data.settings.pattern === 'local' && !alive(data), 'importing while disabled selects the library item without turning effects on', data);
	await apply({ enabled: true });

	await apply({ pattern: 'triangles' });
	const [red, blue] = await page.evaluate(async () => [await window.__pointerSmoke.import('slow-red', '#ff0000'), await window.__pointerSmoke.import('fast-blue', '#0000ff')]);
	await page.evaluate(id => { window.__pointerSmoke.delay(id, 230); window.__pointerSmoke.clearAllocations(); }, red.id);
	await apply({ pattern: 'local', customEffectId: red.id }); await apply({ customEffectId: blue.id }); await page.waitForTimeout(300); await move(); data = await stats();
	const allocations = await page.evaluate(() => window.__pointerSmoke.allocations());
	check(data.canvases.some(canvas => canvas.blue > canvas.red) && allocations.every(source => !source.includes('#ff0000')), 'late imported-image reads cannot overwrite a newer selection or allocate stale URLs', { data, allocations });
	await apply({ pattern: 'triangles' }); await page.evaluate(() => window.__pointerSmoke.clearAllocations()); await apply({ pattern: 'local', customEffectId: red.id }); await page.evaluate(() => window.__pointerSmoke.unmount()); await page.waitForTimeout(300);
	check((await page.evaluate(() => window.__pointerSmoke.allocations())).length === 0, 'unmounted host cannot allocate an object URL from a delayed image read');
	await apply({ pattern: 'creatures' }); await page.evaluate(() => window.__pointerSmoke.remount()); await move();

	const storedBeforeTheme = JSON.stringify((await stats()).settings);
	await page.evaluate(() => { localStorage.setItem('theme_ambient', 'sakura-fixture'); document.documentElement.dataset.theme = 'warm-fixture'; document.documentElement.style.setProperty('--accent-primary-color', '#ffcc88'); }); await move();
	check(JSON.stringify((await stats()).settings) === storedBeforeTheme && await page.evaluate(() => localStorage.getItem('theme_ambient')) === 'sakura-fixture', 'theme changes and pointer settings remain independent');

	const coarse = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	await coarse.goto(origin + '/__pointer_effects'); await coarse.waitForFunction(() => window.__pointerSmoke?.ready);
	check(await coarse.evaluate(() => matchMedia('(pointer: coarse)').matches), 'mobile acceptance uses a real coarse-pointer browser context');
	await coarse.mouse.move(180, 380); await coarse.evaluate(() => window.__pointerSmoke.demo()); await coarse.waitForTimeout(100);
	const coarseStats = await coarse.evaluate(() => window.__pointerSmoke.stats());
	check(!alive(coarseStats) && !coarseStats.running && coarseStats.pending === 0, 'coarse pointers suppress real movement and sample sweeps', coarseStats);
	check(await coarse.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'settings fit the narrow mobile viewport without horizontal scrolling');
	await coarse.screenshot({ path: resolve(output, 'pointer-effects-mobile.png') }); await coarse.close();
	check((await stats()).errors.length === 0, 'all integrated effects complete without visible runtime errors', (await stats()).errors);
	await page.getByLabel('Import pointer shader', { exact: true }).setInputFiles({ name: 'invalid-shader.frag', mimeType: 'text/plain', buffer: Buffer.from('void mainImage(out vec4 color,in vec2 pixel){ INVALID_SHADER; }') });
	await page.getByRole('alert').waitFor();
	check((await page.getByRole('alert').textContent()).length > 10, 'shader compilation failures appear visibly in Pointer Effects settings');
	await page.evaluate(() => window.__pointerSmoke.remountSettings()); await page.getByRole('alert').waitFor();
	check((await page.getByRole('alert').textContent()).length > 10, 'reopening Pointer Effects restores the current host error');
	await apply({ pattern: 'creatures' });
	check(await page.getByRole('alert').count() === 0, 'choosing a working built-in clears the runtime error');
	const report = { status: failures.length ? 'failed' : 'passed', browser: browser.version(), checks: results.length, results, failures, patterns: patternResults };
	writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
	// Contact sheet uses unmodified browser screenshots inside a simple review page.
	const gallery = '<!doctype html><style>body{margin:0;padding:32px;background:#10131b;color:#e4e8f4;font:14px system-ui}h1{font-weight:500}p{color:#96a0b9}main{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}figure{margin:0;background:#202637;border:1px solid #353e55;border-radius:8px;overflow:hidden}img{width:100%;display:block}figcaption{padding:10px}</style><h1>Wabi pointer effects · all 40 production patterns</h1><p>Inspection strength: 40%; radius: 260 px. Captured from the production effect host with real mouse input.</p><main>' + patternResults.map(pattern => `<figure><img src="/@fs/${output}/${pattern.screenshot}"><figcaption>${pattern.name}</figcaption></figure>`).join('') + '</main>';
	const review = await browser.newPage({ viewport: { width: 1800, height: 1200 } }); await review.goto(origin + '/__pointer_effects'); await review.setContent(gallery); await review.evaluate(() => Promise.all([...document.images].map(image => image.decode()))); await review.screenshot({ path: resolve(output, 'pointer-effects-contact-sheet.png'), fullPage: true }); await review.close();
	console.log(JSON.stringify(report, null, 2)); if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
