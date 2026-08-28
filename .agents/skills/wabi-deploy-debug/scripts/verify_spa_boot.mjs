// verify_spa_boot.mjs — headless SPA-boot outcome check for the Wabi deploy skill.
// argv[1] = port the static build is served on (default 8099).
// exit 0 = GOOD (boot shell hidden OR login form present)
// exit 1 = BAD  (renderer crashed OR boot shell stuck with no login)
//
// Detects the Wabi SPA boot failure modes:
//  - renderer crash (page closed / page.on('crash'))
//  - stuck "#wabi-boot-shell" overlay (boot IIFE died before dismissDocumentBootShell)
// Set env API_PROXY=1 (default) to proxy /api/* to https://wabi.chat so boot proceeds
// like production. Set API_PROXY=0 to let /api 404 (a WORKING build then reads "stuck",
// useful only to distinguish crash vs stuck).
import pkg from '/var/home/Ronin/wabi/frontend/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const PORT = process.argv[2] || '8099';
const PROXY = process.env.API_PROXY !== '0';

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu', '--no-sandbox'] });
  const page = await browser.newPage();
  let crashed = false;
  page.on('crash', () => { crashed = true; });

  if (PROXY) {
    await page.route('**/api/**', async (route) => {
      const u = route.request().url().replace(new RegExp(`^https?://127\\.0\\.0\\.1:${PORT}`), 'https://wabi.chat');
      try {
        const r = await fetch(u, { method: route.request().method(), headers: route.request().headers(), body: route.request().postData() });
        const b = await r.text();
        return route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: b });
      } catch (e) { return route.fulfill({ status: 502, body: String(e) }); }
    });
  }

  try { await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 25000 }); }
  catch (e) { console.log('GOTO_FAIL ' + e.message); }

  await new Promise(r => setTimeout(r, 8000));

  if (crashed) { console.log('RESULT BAD crash'); try { await browser.close(); } catch {} process.exit(1); }

  let state;
  try {
    state = await page.evaluate(() => {
      const shell = document.getElementById('wabi-boot-shell');
      const hidden = shell ? shell.classList.contains('is-hidden') : true;
      const hasLogin = !!document.querySelector('input[type="password"], button');
      return { hidden, hasLogin };
    });
  } catch (e) { console.log('RESULT BAD page-dead ' + e.message); try { await browser.close(); } catch {} process.exit(1); }

  const good = state.hidden || state.hasLogin;
  console.log('RESULT ' + (good ? 'GOOD' : 'BAD') + ' ' + JSON.stringify(state));
  try { await browser.close(); } catch {}
  process.exit(good ? 0 : 1);
})();
