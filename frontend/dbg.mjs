import { chromium } from 'playwright';

const BASE = 'http://localhost:3001';
const FRONT = 'http://localhost:5173';
const CHROME = '/usr/lib64/chromium-browser/chromium-browser';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote']
});

async function probe(name, token) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message));
  await page.goto(FRONT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const scope = 'http://localhost:3001';
    const sk = 'wabi_auth_token:' + encodeURIComponent(scope);
    const pk = 'wabi_persisted_auth_token:' + encodeURIComponent(scope);
    sessionStorage.setItem('wabi.serverUrlSession', scope);
    localStorage.setItem('wabi.serverUrl', scope);
    localStorage.setItem('wabi.serverUrlRemember', 'true');
    sessionStorage.setItem(sk, t);
    localStorage.setItem(pk, t);
  }, token);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => ({
    url: location.href,
    messages: document.querySelectorAll('.message').length,
    textareas: document.querySelectorAll('textarea').length,
    channelBtns: document.querySelectorAll('.channel-btn').length,
    rightPanel: document.querySelectorAll('.right-panel').length,
    bodyText: document.body ? document.body.innerText.slice(0, 400) : 'NO BODY',
    hasComposer: !!document.querySelector('.chat-composer, [class*="composer"]')
  }));
  console.log(`\n--- ${name} ---`);
  console.log(JSON.stringify(info, null, 2));
  console.log('consoleErrors:', errs.slice(0, 8));
  await ctx.close();
}

// get a token
async function api(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
let j = await api('/api/auth/login', { username: 'hy3new', password: 'hy3pass123' });
if (!j.token) j = await api('/api/auth/register', { username: 'hy3new', password: 'hy3pass123', handle: 'hy3new' });
console.log('token?', !!j.token, 'user', j.user && j.user.username);
await probe('hy3new', j.token);

await browser.close();
console.log('\nDONE');
process.exit(0);
