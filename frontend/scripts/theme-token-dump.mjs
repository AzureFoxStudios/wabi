// Dumps every computed --* custom property on <html> for a set of themes, plus
// contrast ratios for the design roles. Needs the dev server (default :5173).
//   node scripts/theme-token-dump.mjs out.json [theme-id ...]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const [out = 'theme-tokens.json', ...ids] = process.argv.slice(2);
const themes = ids.length ? ids : ['dark', 'light', 'blue', 'high-contrast', 'joker'];
const base = process.env.WABI_FRONT ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
	executablePath: process.env.WABI_BROWSER ?? '/usr/bin/brave-browser',
	headless: false
});
const result = {};
for (const id of themes) {
	const page = await (await browser.newContext()).newPage();
	await page.addInitScript((themeId) => {
		localStorage.setItem('wabi-theme', JSON.stringify({ theme_id: themeId, custom_theme: null }));
	}, id);
	await page.goto(base);
	await page.waitForFunction((themeId) => document.documentElement.dataset.theme === themeId, id, { timeout: 15000 }).catch(() => {});
	result[id] = await page.evaluate(() => {
		const cs = getComputedStyle(document.documentElement);
		const vars = {};
		for (const name of document.documentElement.style) if (name.startsWith('--')) vars[name] = cs.getPropertyValue(name).trim();
		return { char: document.documentElement.dataset.char, mode: document.documentElement.dataset.mode, vars };
	});
	await page.close();
}
await browser.close();
writeFileSync(out, JSON.stringify(result, null, 2));
for (const [id, r] of Object.entries(result)) console.log(id, r.char, r.mode, Object.keys(r.vars).length, 'vars');
