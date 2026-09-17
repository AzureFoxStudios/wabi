// Synthetic network/auth fixture; real Gallery Svelte components and stores.
// No Authority, registration, account, password or live-service calls.
// Run from frontend: WABI_SMOKE_CHROMIUM_PATH=/usr/bin/chromium-browser node scripts/gallery-workspace-browser-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-gallery-browser-');
const report = { boundary: 'SYNTHETIC API/auth; real current-source GalleryChannel, GalleryLightbox, stores and API clients; NOT backend/runtime acceptance', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(), assertions: [], screenshots: [], pageErrors: [], consoleErrors: [], requests: [], unexpectedRequests: [] };
let vite, browser, page;
const persist = () => writeFile(`${scratch}/results.json`, JSON.stringify(report, null, 2));
async function shot(name) { const path = `${scratch}/${name}.png`; await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); await persist(); }
async function check(name, action) {
  try { await action(); report.assertions.push({ name, status: 'PASS' }); }
  catch (error) { report.assertions.push({ name, status: 'FAIL', error: error.stack }); await shot(`failure-${report.assertions.length}`); }
  await persist();
}
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#453584"/><circle cx="320" cy="200" r="120" fill="#9cd8cc"/><text x="70" y="370" fill="white" font-size="26">SYNTHETIC GALLERY QA IMAGE</text></svg>');
const albums = [1, 2].map(id => ({ id, scopeType: 'channel', scopeId: 'gallery-fixture', name: `Synthetic album ${id}`, createdBy: 42, createdAt: 1700000000000000, updatedAt: 1700000000000000 }));
const items = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, albumId: i < 7 ? 1 : 2, attachmentUrl: svg, attachmentName: i === 8 ? 'motion.webm' : `study-${i + 1}.svg`, attachmentMime: i === 8 ? 'video/webm' : 'image/svg+xml', caption: i === 7 ? 'older needle' : 'synthetic artwork', uploadedBy: i % 2 ? 77 : 42, uploadedAt: 1800000000000000 - i * 1000000 }));
let mode = 'healthy', saveFail = false, feedback = [], postCount = 0, gate = null, releaseGate = null;
report.fixture = { albums, items, auth: 'noncredential synthetic token; no authentication tested' };
const entry = `
import { mount, unmount } from 'svelte';
import GalleryChannel from '/src/lib/components/GalleryChannel.svelte';
import { currentChannel, channels, users } from '/src/lib/socket';
import { setAuthToken, setStoredDbUserId } from '/src/lib/authSession';
import '/src/styles/styles.css';
import { initI18n } from '/src/lib/i18n';
initI18n();
setAuthToken('synthetic-gallery-only'); setStoredDbUserId(42);
currentChannel.set('gallery-fixture');
channels.set([{ id:'gallery-fixture', name:'Synthetic Gallery', channelType:'gallery' }]);
users.set([{ id:'fixture-42', dbUserId:42, username:'Synthetic Alice', color:'#c2acff' }]);
let center, panel;
window.fixture = {
 async reset() { if(center) await unmount(center); if(panel) await unmount(panel); panel=null; center=mount(GalleryChannel,{target:document.querySelector('#center'),props:{channelId:'gallery-fixture'}}); },
 async panel(open) { if(panel) await unmount(panel); panel=open ? mount(GalleryChannel,{target:document.querySelector('#panel'),props:{channelId:'gallery-fixture'}}) : null; document.querySelector('#panel').hidden=!open; }
};
await window.fixture.reset(); window.fixtureReady=true;
`;
try {
  vite = await createServer({ root, plugins: [{ name: 'gallery-synthetic-browser-fixture',
    resolveId(id) { if (id === 'virtual:gallery-browser-entry') return '\0' + id; },
    load(id) { if (id === '\0virtual:gallery-browser-entry') return entry; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/__gallery-fixture') return next();
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>SYNTHETIC Gallery QA</title><style>body{margin:0}#fixture-label{padding:8px;color:white;background:#382a62;font:14px sans-serif}#surfaces{display:flex;height:calc(100vh - 32px)}#center{flex:1;min-width:0}#panel{width:440px;min-width:0;border-left:2px solid #9cd8cc}#center>.gallery-channel,#panel>.gallery-channel{height:100%}</style></head><body><div id="fixture-label">SYNTHETIC API / AUTH — real Gallery components, NOT live-server acceptance</div><div id="surfaces"><main id="center"></main><aside id="panel" hidden></aside></div><script type="module" src="/@id/virtual:gallery-browser-entry"></script></body></html>';
      res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html));
    }); }
  }], server: { host: '127.0.0.1', port: 0, open: false } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  report.origin = origin;
  browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH || '/usr/bin/chromium-browser' });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => { report.pageErrors.push(e.message); });
  page.on('console', msg => { if(msg.type() === 'error') report.consoleErrors.push(msg.text()); });
  await page.addInitScript(() => { sessionStorage.setItem('wabi.serverUrlSession', location.origin); localStorage.setItem('notificationsEnabled', 'false'); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !url.protocol.startsWith('data')) { report.unexpectedRequests.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    report.requests.push({ method: request.method(), path: url.pathname + url.search, mode });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const join = url.pathname.match(/^\/api\/channels\/([^/]+)\/join$/);
    if (join) return json({ joined: true, channelId: decodeURIComponent(join[1]) });
    if (url.pathname === '/api/albums') return json({ albums });
    const album = url.pathname.match(/^\/api\/albums\/(\d+)\/items$/);
    if (album) {
      const id = Number(album[1]);
      if(mode === 'total' || (mode === 'partial' && id === 2)) return json({ error: 'Explicit synthetic album 503' }, 503);
      return json({ album: albums.find(a => a.id === id), items: items.filter(i => i.albumId === id) });
    }
    const work = url.pathname.match(/^\/api\/gallery\/([^/]+)\/works\/([^/]+)\/feedback$/);
    if(work) {
      const workId = decodeURIComponent(work[2]), channelId = decodeURIComponent(work[1]);
      if(request.method() === 'GET') return json({ feedback: feedback.filter(f => f.workId === workId && f.channelId === channelId) });
      if(request.method() === 'POST') {
        postCount++; const body = request.postDataJSON();
        if(saveFail) return json({ error: 'Explicit synthetic save 503' }, 503);
        if(gate) await gate;
        const row = { ...body, workId, channelId, feedbackId: `synthetic-${postCount}`, authorUserId: 42, createdAtMicros: 1800000000000000, isDeleted: false };
        feedback.push(row); return json({ feedbackId: row.feedbackId });
      }
    }
    report.unexpectedRequests.push(request.url()); return json({ error: 'Unconfigured fixture API' }, 501);
  });
  await page.goto(`${origin}/__gallery-fixture`);
  await page.waitForFunction(() => window.fixtureReady === true, { timeout: 60000 });
  const center = page.locator('#center'), panel = page.locator('#panel');
  const cards = surface => surface.locator('.recent-card, .gallery-card');
  async function count(surface, n) { await page.waitForFunction(({ selector, n }) => document.querySelectorAll(selector + ' .recent-card, ' + selector + ' .gallery-card').length === n, { selector: surface === center ? '#center' : '#panel', n }); }
  async function reset(nextMode = 'healthy') { mode = nextMode; await page.evaluate(() => window.fixture.reset()); await center.locator('.gallery-loading').waitFor({ state: 'hidden' }); }
  async function open(name = 'study-1.svg', surface = center) { await surface.getByRole('button', { name: `Open ${name}`, exact: true }).click(); await surface.locator('.lightbox-feedback-input').waitFor(); }
  async function close(surface = center) { await surface.getByRole('button', { name: 'Close lightbox', exact: true }).click(); await surface.locator('.lightbox-backdrop').waitFor({ state: 'hidden' }); }
  const input = surface => surface.locator('.lightbox-feedback-input');
  await count(center, 9); await shot('01-initial');
  await check('Initial render: nine works, six recent and three older', async () => { assert.equal(await center.locator('.recent-card').count(), 6); assert.equal(await center.locator('.gallery-card').count(), 3); });
  await check('Search filters FULL collection before recent split: older caption match is reachable', async () => { await center.getByPlaceholder('Search works...').fill('older needle'); await count(center, 1); assert.equal(await cards(center).getAttribute('aria-label'), 'Open study-8.svg'); });
  await check('Nonempty matching results must not simultaneously claim no works match', async () => { assert.equal(await center.getByText('No works match these filters', { exact: true }).count(), 0); });
  await shot('02-single-match');
  await check('No-match state and Clear filters restore all nine works', async () => { await center.getByPlaceholder('Search works...').fill('no-such-work-qa'); await center.getByText('No works match these filters', { exact: true }).waitFor(); await count(center, 0); await shot('03-no-match'); await center.getByRole('button', { name:'Clear filters', exact:true }).click(); await count(center, 9); });
  await check('Media filters: Images = eight; Video = one; All = nine', async () => { await center.getByRole('button', {name:'Images', exact:true}).click(); await count(center, 8); await center.getByRole('button', {name:'Video', exact:true}).click(); await count(center, 1); assert.equal(await cards(center).getAttribute('aria-label'), 'Open motion.webm'); await center.getByRole('button', {name:'All', exact:true}).click(); await count(center, 9); });
  await check('Offline creator stable-id filter yields four works and Show all restores nine', async () => { await center.locator('.creator-chip[title="User #77"]').click(); await count(center, 4); await center.getByRole('button', {name:'Show all',exact:true}).click(); await count(center, 9); });
  await check('Partial album 503 keeps seven works, explicit warning; Retry restores nine', async () => { await reset('partial'); await center.locator('.gallery-warning').waitFor(); await count(center, 7); assert.match(await center.locator('.gallery-warning').innerText(), /1 of 2 albums failed/); await shot('04-partial-failure'); mode='healthy'; await center.locator('.gallery-warning').getByRole('button',{name:'Retry',exact:true}).click(); await count(center,9); assert.equal(await center.locator('.gallery-warning').count(),0); });
  await check('Total album 503 shows error not empty; Retry restores nine', async () => { await reset('total'); await center.locator('.gallery-error').waitFor(); assert.match(await center.locator('.gallery-error').innerText(), /2 of 2 albums/); assert.equal(await center.getByText('No works yet',{exact:true}).count(),0); await shot('05-total-failure'); mode='healthy'; await center.locator('.gallery-error').getByRole('button',{name:'Retry',exact:true}).click(); await count(center,9); });
  await reset();
  await check('Feedback unsent marker/text survives work navigation and close/reopen', async () => { await open(); await center.getByRole('button',{name:'Place feedback marker on media',exact:true}).click({ position: { x: 50, y: 50 } }); await input(center).fill('Center synthetic draft'); await center.getByRole('button',{name:'Next',exact:true}).click(); assert.equal(await input(center).inputValue(),''); await center.getByRole('button',{name:'Previous',exact:true}).click(); assert.equal(await input(center).inputValue(),'Center synthetic draft'); await close(); await open(); assert.equal(await input(center).inputValue(),'Center synthetic draft'); assert.equal(await input(center).isEnabled(),true); await shot('06-feedback-draft-reopen'); });
  await check('Feedback failed save retains draft; Send retry persists to synthetic API and clears submitted draft', async () => { saveFail=true; await center.getByRole('button',{name:'Send feedback',exact:true}).click(); await center.getByText('Failed to add feedback (503).',{exact:true}).waitFor(); assert.equal(await input(center).inputValue(),'Center synthetic draft'); await shot('07-feedback-save-failure'); saveFail=false; await center.getByRole('button',{name:'Send feedback',exact:true}).click(); await center.locator('.lightbox-feedback-comment').filter({hasText:'Center synthetic draft'}).waitFor(); await page.waitForFunction(() => document.querySelector('#center .lightbox-feedback-input')?.value === ''); assert.equal(feedback.length,1); assert.equal(feedback[0].workId,'album-1-item-1'); assert.ok(Number.isFinite(feedback[0].xPercent) && feedback[0].xPercent >= 0 && feedback[0].xPercent <= 100); await close(); await open(); assert.equal(await center.locator('.lightbox-feedback-comment').innerText(),'Center synthetic draft'); await shot('08-feedback-saved-reopen'); });
  await close();
  await check('Two mounted Gallery surfaces maintain independent filters and survive panel disposal', async () => { await page.evaluate(() => window.fixture.panel(true)); await count(panel,9); await center.getByPlaceholder('Search works...').fill('study-1'); await count(center,1); await panel.getByRole('button',{name:'Images',exact:true}).click(); await count(panel,8); assert.equal(await center.getByPlaceholder('Search works...').inputValue(),'study-1'); await shot('09-independent-surfaces'); await page.evaluate(() => window.fixture.panel(false)); await count(center,1); await center.getByPlaceholder('Search works...').fill(''); await count(center,9); });
  await check('Existing saved marker must not block placing a second marker', async () => { await open(); await center.getByRole('button',{name:'Place feedback marker on media',exact:true}).click({ position: { x: 140, y: 140 } }); assert.equal(await input(center).isEnabled(),true); });
  await close();
  await check('Panel feedback draft does not replace center feedback draft on same work', async () => { await open('study-2.svg'); await center.getByRole('button',{name:'Place feedback marker on media',exact:true}).click({ position: { x: 140, y: 140 } }); await input(center).fill('Independent center unsent'); await close(); await page.evaluate(() => window.fixture.panel(true)); await count(panel,9); await open('study-2.svg',panel); await panel.getByRole('button',{name:'Place feedback marker on media',exact:true}).click({ position: { x: 140, y: 140 } }); await input(panel).fill('Independent panel unsent'); await close(panel); await open('study-2.svg'); assert.equal(await input(center).inputValue(),'Independent center unsent'); await close(); await open('study-2.svg',panel); assert.equal(await input(panel).inputValue(),'Independent panel unsent'); await shot('10-independent-feedback'); await close(panel); await page.evaluate(() => window.fixture.panel(false)); });
  await check('No uncaught browser page errors', async () => assert.deepEqual(report.pageErrors, []));
  await check('No unconfigured API or off-origin requests escaped the synthetic boundary', async () => assert.deepEqual(report.unexpectedRequests, []));
} catch(error) {
  report.blocker = error.stack;
  if(page) await shot('fixture-blocker').catch(() => {});
} finally {
  releaseGate?.();
  await browser?.close(); await vite?.close();
  report.counts = { passed: report.assertions.filter(a=>a.status==='PASS').length, failed: report.assertions.filter(a=>a.status==='FAIL').length };
  await persist();
  console.log(JSON.stringify({ ...report.counts, blocker: report.blocker || null, evidence: scratch }, null, 2));
  if(report.blocker || report.counts.failed) process.exitCode=1;
}
