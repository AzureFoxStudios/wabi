// Real application routes in headful Chromium, with an isolated browser profile.
// Run: node scripts/public-route-boot-smoke.mjs (after svelte-kit sync).
// API responses are local fixtures; this checks route/shell ownership, not auth.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = await mkdtemp('/tmp/wabi-public-route-boot-');
process.env.VITE_SOCKET_URL = '';
process.env.VITE_WABI_LOCAL_MOCK = '0';
const vite = await createServer({
	root,
	// The pending-workspace case holds a lazy import; do not speculatively
	// crawl the full workspace while its response is deliberately blocked.
	server: { host: '127.0.0.1', port: 0, open: false, preTransformRequests: false }
});
let browser;
let releaseAppModule = () => {};
try {
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
	await context.route(url => url.pathname.startsWith('/api/'), route => {
		const path = new URL(route.request().url()).pathname;
		const body = path === '/api/setup/status' ? { setupRequired: false }
			: path === '/api/public/launch-page' ? { enabled: false, brandName: 'Wabi' }
			: path === '/api/public/auth-policy' ? { guestAccessEnabled: true }
			: {};
		return route.fulfill({ json: body });
	});
	await context.route('**/socket.io/**', route => route.abort());
	const page = await context.newPage();
	page.setDefaultTimeout(60_000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	for (const [path, title, width, height] of [
		['/privacy', 'Privacy', 390, 844],
		['/terms', 'Terms', 1440, 1000],
		['/missing-boot-fixture', 'This page wandered off.', 390, 844]
	]) {
		await page.setViewportSize({ width, height });
		await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
		await page.locator('#wabi-boot-shell').waitFor({ state: 'detached' });
		await page.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'visible' });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${path}: fits viewport`);
		for (const theme of ['default', 'highContrastTheme', 'lightTheme']) {
			if (theme !== 'default') await page.evaluate(async name => {
				const { applyTheme } = await import('/src/lib/theme/themeManager.ts');
				const themes = await import('/src/lib/theme/themes.ts');
				applyTheme(themes[name]);
			}, theme);
			await page.locator('.public-page').evaluate(node => Promise.all(
				node.getAnimations({ subtree: true })
					.filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations))
					.map(animation => animation.finished.catch(() => {}))
			));
			const presentation = await page.evaluate(() => {
				const luminance = color => {
					const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
						const channel = value / 255;
						return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
					});
					return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
				};
				const background = luminance(getComputedStyle(document.querySelector('.public-page')).backgroundColor);
				const text = [...document.querySelectorAll('.public-reading p, .public-header a')].map(node => {
					const foreground = luminance(getComputedStyle(node).color);
					return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
				});
				return {
					background: getComputedStyle(document.querySelector('.public-page')).backgroundColor,
					bodyColor: getComputedStyle(document.querySelector('.public-reading p')).color,
					minimumContrast: Math.min(...text),
					width: document.documentElement.scrollWidth,
					viewport: innerWidth,
					readingOverflow: document.querySelector('.public-page').scrollWidth > document.querySelector('.public-page').clientWidth,
					targets: [...document.querySelectorAll('.public-header a, .public-footer a, .public-actions > *')].map(node => {
						const box = node.getBoundingClientRect();
						return { name: node.textContent.trim(), width: box.width, height: box.height };
					})
				};
			});
			await page.screenshot({ path: `${evidence}${path}-${theme}.png` });
			assert.ok(presentation.minimumContrast >= 4.5, `${path}/${theme}: readable body/navigation contrast (${JSON.stringify(presentation)})`);
			assert.ok(presentation.width <= presentation.viewport, `${path}/${theme}: no horizontal overflow`);
			assert.equal(presentation.readingOverflow, false, `${path}/${theme}: reading surface has no horizontal scroll`);
			for (const target of presentation.targets) assert.ok(target.width >= 44 && target.height >= 44, `${path}/${theme}: ${target.name} touch target`);
		}
		await page.keyboard.press('Tab');
		assert.equal(await page.locator('.public-skip').evaluate(node => node === document.activeElement), true, `${path}: keyboard reaches skip link first`);
		await page.keyboard.press('Enter');
		assert.equal(await page.locator('#main-content').evaluate(node => node === document.activeElement), true, `${path}: skip link focuses reading content`);
		const nav = page.getByRole('navigation', { name: 'Project information' });
		await nav.getByRole('link', { name: 'Source code' }).focus();
		assert.equal(await nav.getByRole('link', { name: 'Source code' }).evaluate(node => getComputedStyle(node).outlineStyle), 'solid', `${path}: visible keyboard focus`);
		if (path !== '/missing-boot-fixture') {
			await page.mouse.move(width / 2, height / 2);
			await page.mouse.wheel(0, 600);
			await page.waitForFunction(() => document.querySelector('.public-page').scrollTop > 100);
			await page.getByRole('link', { name: 'Back to top' }).click();
			await page.waitForFunction(() => document.querySelector('.public-page').scrollTop === 0);
		}
	}

	// A public page's link uses the persistent layout, and returning home still
	// hands anonymous startup to the existing root page.
	await page.goto(`${origin}/privacy`, { waitUntil: 'domcontentloaded' });
	await page.locator('#wabi-boot-shell').waitFor({ state: 'detached' });
	await page.getByRole('navigation', { name: 'Project information' }).getByRole('link', { name: 'Terms', exact: true }).focus();
	await page.keyboard.press('Enter');
	await page.getByRole('heading', { name: 'Terms', exact: true }).waitFor({ state: 'visible' });
	await page.getByRole('link', { name: 'Back to Wabi' }).click();
	await page.getByPlaceholder('Username or @handle').waitFor({ state: 'visible' });
	await page.goto(origin, { waitUntil: 'domcontentloaded' });
	await page.locator('#wabi-boot-shell').waitFor({ state: 'detached' });
	await page.getByPlaceholder('Username or @handle').waitFor({ state: 'visible' });
	await page.screenshot({ path: `${evidence}/login-mobile.png`, fullPage: true });
	assert.deepEqual(errors, [], 'public routes and anonymous startup have no page errors');

	// A session loads the workspace lazily. Hold that real import to prove the
	// layout cannot reveal unfinished root content merely because it mounted.
	const sessionPage = await context.newPage();
	sessionPage.setDefaultTimeout(60_000);
	await sessionPage.addInitScript(({ origin }) => {
		const scope = encodeURIComponent(origin);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, 'local-boot-fixture');
		localStorage.setItem(`wabi_username:${scope}`, 'boot_fixture');
		localStorage.setItem('notificationsEnabled', 'false');
	}, { origin });
	const appModuleGate = new Promise(resolve => { releaseAppModule = resolve; });
	await sessionPage.route('**/src/lib/components/LayoutRouter.svelte*', async route => {
		await appModuleGate;
		await route.abort();
	});
	await sessionPage.goto(origin, { waitUntil: 'domcontentloaded' });
	await sessionPage.waitForFunction(() => performance.getEntriesByName('wabi:start:page:layout-module:await:start').length > 0);
	await sessionPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	assert.equal(await sessionPage.locator('#wabi-boot-shell').isVisible(), true, 'root shell remains until workspace bootstrap finishes');
	assert.equal(await sessionPage.locator('#wabi-boot-shell').getAttribute('data-boot-brand'), 'wabi', 'default branding remains available');
	await sessionPage.screenshot({ path: `${evidence}/root-pending.png` });

	// Navigate away while the root still owns a pending startup. The mounted
	// standalone page must retire that shell without waiting for the app import.
	await sessionPage.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/privacy';
		document.body.append(link);
		link.click();
		link.remove();
	});
	await sessionPage.getByRole('heading', { name: 'Privacy', exact: true }).waitFor({ state: 'visible' });
	await sessionPage.locator('#wabi-boot-shell').waitFor({ state: 'detached' });
	await sessionPage.screenshot({ path: `${evidence}/privacy-after-pending-root.png` });
	console.log(`Public route boot smoke passed. Headful screenshots: ${evidence}`);
} finally {
	releaseAppModule();
	await browser?.close();
	await vite.close();
}
