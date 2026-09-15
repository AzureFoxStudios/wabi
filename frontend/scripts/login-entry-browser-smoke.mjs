// Full application entry, headful browser, disposable profiles and fixture APIs.
// No live account creation or production traffic. Screenshots are acceptance evidence.
// Run from frontend: node scripts/login-entry-browser-smoke.mjs
// Requires DISPLAY and an installed Playwright Chromium. If needed, set
// WABI_CHROMIUM_PATH=/absolute/path/to/chrome. WABI_LOGIN_SCENARIOS=light,neutral
// selects a focused subset; omit it for all entry variants.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = await mkdtemp('/tmp/wabi-login-entry-');
process.env.VITE_SOCKET_URL = '';
process.env.VITE_WABI_LOCAL_MOCK = '0';
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false, preTransformRequests: false } });
let browser;
const results = [];
try {
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
	for (const scenario of [
		{ name: 'desktop', width: 1440, height: 1000 },
		{ name: 'mobile', width: 390, height: 844, touch: true },
		{ name: 'short-mobile', width: 390, height: 620, touch: true },
		{ name: 'light', width: 1440, height: 1000, theme: 'light' },
		{ name: 'tablet', width: 820, height: 900 },
		{ name: 'custom', width: 1440, height: 1000, custom: true },
		{ name: 'neutral', width: 390, height: 844, neutral: true, custom: true, story: true },
		{ name: 'launch', width: 1440, height: 1000, custom: true, story: true },
		{ name: 'wizard', width: 390, height: 844, wizard: true },
		{ name: 'closed', width: 390, height: 844, closed: true }
	].filter(scenario => !process.env.WABI_LOGIN_SCENARIOS || process.env.WABI_LOGIN_SCENARIOS.split(',').includes(scenario.name))) {
		const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, hasTouch: Boolean(scenario.touch), isMobile: Boolean(scenario.touch), serviceWorkers: 'block', reducedMotion: 'reduce' });
		await context.addInitScript(({ origin, neutral, theme }) => {
			localStorage.setItem('notificationsEnabled', 'false');
			if (theme) localStorage.setItem('wabi-theme', JSON.stringify({ theme_id: theme }));
			if (neutral) localStorage.setItem('wabi.savedServers.v1', JSON.stringify({ entries: [{ url: origin, useNeutralBranding: true, order: 0 }], folders: [] }));
		}, { origin, neutral: scenario.neutral, theme: scenario.theme });
		await context.route('**/fixture-host-logo.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60"><rect width="100" height="60" rx="12" fill="#c15f92"/><text x="50" y="40" text-anchor="middle" font-family="sans-serif" font-size="30" fill="white">AC</text></svg>' }));
		await context.route(url => url.pathname.startsWith('/api/'), route => {
			const path = new URL(route.request().url()).pathname;
			if (path === '/api/auth/login') return route.fulfill({ status: 401, json: { error: 'Fixture: sign-in rejected. Try again.' } });
			const body = path === '/api/setup/status' ? { setupRequired: Boolean(scenario.wizard) }
				: path === '/api/public/launch-page' ? { enabled: Boolean(scenario.story), brandName: scenario.custom ? 'Acorn Club' : 'Wabi', logoUrl: scenario.custom ? '/fixture-host-logo.svg' : '/wabi-logo-small.webp', heroTitle: scenario.story ? 'Acorn’s community story' : null, heroBody: scenario.story ? 'A configured welcome from the server owner.' : null, highlights: [], palette: {} }
				: path === '/api/public/auth-policy' ? { mode: 'open', allowGuest: !scenario.closed, allowRegister: !scenario.closed, emailVerifyRequired: false }
				: path === '/api/auth/register' ? { accessToken: 'fixture-owner-token', refreshToken: 'fixture-refresh-token', user: { id: 1, username: 'fixture_owner' } }
				: {};
			return route.fulfill({ json: body });
		});
		await context.route('**/socket.io/**', route => route.abort());
		const page = await context.newPage();
		page.setDefaultTimeout(60_000);
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(origin, { waitUntil: 'domcontentloaded' });
		await page.locator('#wabi-boot-shell').waitFor({ state: 'detached' });
		await page.locator('.login-auth-panel input').first().waitFor({ state: 'visible' });
		await page.evaluate(() => document.fonts.ready);
		await page.locator('.login-container').evaluate(node => { node.scrollTop = 0; });
		if (scenario.theme) await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, scenario.theme);
		if (scenario.neutral) {
			assert.equal(await page.locator('html').getAttribute('data-neutral-branding'), '');
			assert.equal(await page.locator('.launch-panel').count(), 0, 'neutral suppresses custom launch story');
			assert.equal(await page.locator('.login-title').count(), 0, 'neutral suppresses product/custom wordmark');
			assert.equal(await page.locator('.login-logo').isVisible(), false, 'neutral suppresses custom image');
		} else if (scenario.custom) {
			await page.locator('.login-logo[src="/fixture-host-logo.svg"]').waitFor();
			assert.equal(await page.locator('.login-logo').evaluate(node => getComputedStyle(node).filter), 'none');
		}
		if (scenario.story && !scenario.neutral) await page.getByRole('heading', { name: 'Acorn’s community story' }).waitFor();
		if (scenario.closed) {
			await page.getByText('Registration is closed on this server.').waitFor();
			assert.equal(await page.locator('.guest-expand').count(), 0);
		}
		const geometry = await page.evaluate(() => {
			const container = document.querySelector('.login-container');
			const primary = document.querySelector('.auth-btn-primary');
			const style = primary ? getComputedStyle(primary) : null;
			const luminance = color => {
				const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
				return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
			};
			const fg = luminance(style.color), bg = luminance(style.backgroundColor);
			return { documentFits: document.documentElement.scrollWidth <= innerWidth, containerFits: container.scrollWidth <= container.clientWidth + 1, foreground: style?.color, background: style?.backgroundColor, contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), randomAmbient: document.documentElement.hasAttribute('data-login-ambient') };
		});
		assert.equal(geometry.documentFits && geometry.containerFits, true, `${scenario.name}: no horizontal overflow`);
		assert.equal(geometry.randomAmbient, false, 'login does not install a random ambient theme');
		assert.ok(geometry.contrast >= 4.5, `${scenario.name}: primary action contrast ${geometry.contrast}`);
		if (scenario.width <= 700) {
			const targets = await page.locator('.login-footer-links > a, .login-change-server, .login-locale-control, .remember-row, .password-toggle').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { label: node.textContent?.trim() || node.getAttribute('aria-label'), width: rect.width, height: rect.height }; }));
			for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44, `${scenario.name}: ${target.label} target ${target.width}×${target.height}`);
		}
		if (scenario.theme) assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wabi-theme')).theme_id), scenario.theme, 'selected theme remains selected');
		await page.screenshot({ path: `${evidence}/${scenario.name}.png` });
		// Wheel input must scroll the actual overflow container while body is fixed.
		await page.mouse.move(scenario.width / 2, Math.min(scenario.height - 50, 550));
		await page.mouse.wheel(0, 1800);
		await page.waitForFunction(() => { const footer = document.querySelector('.login-footer'); const rect = footer.getBoundingClientRect(); return rect.bottom <= innerHeight + 1; });
		await page.screenshot({ path: `${evidence}/${scenario.name}-footer.png` });
		// Sample actual composited backgrounds for meaningful secondary copy.
		// Text is hidden without changing layout; center pixels in these crops
		// can be compared to the recorded foreground independently of CSS layers.
		const textSamples = [];
		const sampleStyle = await page.addStyleTag({ content: '.login-contrast-sample, .login-contrast-sample::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }' });
		await page.evaluate(() => document.activeElement?.blur());
		for (const [name, selector, pseudo] of [
			['placeholder', '.login-auth-panel input[placeholder]', '::placeholder'],
			['guest-label', '.auth-divider span', null],
			['footer-copy', '.login-footer > p', null]
		]) {
			const target = page.locator(selector).first();
			if (!await target.count()) continue;
			const foreground = await target.evaluate((node, pseudo) => getComputedStyle(node, pseudo).color, pseudo);
			await target.evaluate(node => node.classList.add('login-contrast-sample'));
			const backgroundFile = `${evidence}/${scenario.name}-${name}-background.png`;
			await target.screenshot({ path: backgroundFile });
			await target.evaluate(node => node.classList.remove('login-contrast-sample'));
			textSamples.push({ name, foreground, backgroundFile });
		}
		await sampleStyle.evaluate(node => node.remove());
		if (scenario.name === 'desktop') {
			await page.getByLabel('Username or handle', { exact: true }).fill('fixture');
			await page.getByPlaceholder('Password', { exact: true }).fill('fixture-password');
			await page.getByRole('button', { name: 'Show password', exact: true }).click();
			assert.equal(await page.getByPlaceholder('Password', { exact: true }).getAttribute('type'), 'text');
			await page.getByLabel('Remember me on this device').check();
			await page.getByRole('button', { name: 'Login', exact: true }).click();
			await page.getByRole('alert').waitFor();
			await page.getByRole('button', { name: 'Create a registered account' }).click();
			await page.getByRole('heading', { name: 'Find your place here.' }).waitFor();
			await page.screenshot({ path: `${evidence}/registration.png` });
			await page.getByRole('button', { name: 'Log in', exact: true }).click();
			await page.locator('.guest-expand').click();
			await page.getByLabel('Guest display name').waitFor();
			await page.locator('#locale-picker').selectOption('es');
			assert.match(await page.locator('.login-locale-control').innerText(), /Espa/);
			await page.locator('#locale-picker').selectOption('en');
			await page.locator('.login-change-server').click();
			await page.getByRole('heading', { name: 'Connect to a Wabi domain' }).waitFor();
			await page.screenshot({ path: `${evidence}/server-selection.png` });
		}
		if (scenario.wizard) {
			const fields = page.locator('.wizard form input');
			await fields.nth(0).fill('fixture_owner');
			await fields.nth(1).fill('fixture_owner');
			await fields.nth(2).fill('fixture-password');
			await fields.nth(3).fill('fixture-password');
			await page.locator('.wizard form button[type="submit"]').click();
			await page.getByRole('radiogroup').waitFor();
			await page.getByRole('radio').nth(1).check();
			await page.screenshot({ path: `${evidence}/wizard-policy.png` });
		}
		assert.deepEqual(errors, [], `${scenario.name}: no uncaught errors`);
		results.push({ scenario: scenario.name, ...geometry, textSamples });
		await context.close();
	}
	await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
	console.log(`Login entry smoke passed. Screenshots and results: ${evidence}`);
} finally { await browser?.close(); await vite.close(); }
