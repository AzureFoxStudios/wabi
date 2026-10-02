import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
const base = 'http://localhost:8080';
const out = process.argv[2] ?? '../../docs/screenshots';
const pages = (process.argv[3] ?? '').split(',').filter(Boolean);
const user = process.argv[4] ?? 'owner';
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror ${page.url()}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${page.url()}: ${m.text()}`); });
await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
await page.evaluate(async (u, LOC) => {
  await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'demo1234' }) });
  localStorage.setItem('sabi.locale', LOC);
}, user, process.env.LOC ?? 'en');
for (const spec of pages) {
  const name = spec.slice(0, spec.indexOf('='));
  let path = spec.slice(spec.indexOf('=') + 1);
  const full = path.endsWith('=full') ? 'full' : '';
  if (full) path = path.slice(0, -5);
  await page.goto(base + path, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full === 'full' });
  console.log('shot', name);
}
console.log(errors.join('\n') || 'no errors');
await browser.close();
