// Worst-case embedding: cross-site iframe, a proxy that strips Cookie/Authorization/Set-Cookie and
// rewrites Host, and a browser that blocks sessionStorage/localStorage. Then use the app by clicking only.
import http from 'node:http';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
const STRIP_STORAGE = process.env.STORAGE !== 'ok';
const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers, host: 'localhost:8080', 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http' };
  delete headers.cookie; delete headers.authorization;
  const up = http.request({ host: '127.0.0.1', port: 8080, path: req.url, method: req.method, headers }, (r) => {
    const h = { ...r.headers }; delete h['set-cookie'];
    res.writeHead(r.statusCode, h); r.pipe(res);
  });
  req.pipe(up);
}).listen(8092);
const parent = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<iframe id=f src="http://localhost:8092/login" style="width:1300px;height:850px"></iframe>'); }).listen(8093);
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--disable-features=site-per-process,IsolateOrigins', '--disable-site-isolation-trials'], headless: true, defaultViewport: { width: 1360, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { console.log('console', m.type(), m.text()); }); page.on('pageerror', (e) => console.log('pageerror', e.message));
if (STRIP_STORAGE) await page.evaluateOnNewDocument(() => {
  for (const k of ['sessionStorage', 'localStorage']) Object.defineProperty(window, k, { get() { throw new DOMException('blocked', 'SecurityError'); } });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto('http://127.0.0.1:8093/', { waitUntil: 'networkidle2' });
const frame = await (await page.$('#f')).contentFrame();
const storageBlocked = await frame.evaluate(() => { try { sessionStorage.length; return false; } catch { return true; } });
console.log('storage blocked in frame:', storageBlocked);
await frame.waitForSelector('input');
const inputs = await frame.$$('input');
await inputs[0].type('owner'); await inputs[1].type('demo1234');
await frame.$eval('form', (f) => f.requestSubmit());
await sleep(2500);
console.log('after login:', frame.url(), '| shell:', !!(await frame.$('nav, aside')));
console.log('frame text:', (await frame.evaluate(() => document.body.innerHTML)).slice(0, 400));
await frame.$eval('a[href="/jobs"]', (a) => a.click());
await sleep(1500);
console.log('jobs:', frame.url());
await frame.$eval('a.job', (a) => a.click());
await sleep(2000);
console.log('job:', frame.url());
await frame.evaluate(() => [...document.querySelectorAll('button[role=tab]')].find((b) => /Tasks|งานย่อย/.test(b.textContent))?.click());
await sleep(800);
const title = 'Hostile-proxy task ' + Date.now();
await frame.type('form.add input:not([type])', title);
await frame.$eval('form.add', (f) => f.requestSubmit());
await sleep(2000);
const ok = (await frame.evaluate(() => document.body.innerText)).includes(title);
console.log('task created via button:', ok);
console.log('console errors:', errors.length ? errors : 'none');
await page.screenshot({ path: './embed.png' });
await browser.close(); proxy.close(); parent.close();
process.exit(ok ? 0 : 1);
