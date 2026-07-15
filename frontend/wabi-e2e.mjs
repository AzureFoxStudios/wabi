import { chromium } from 'playwright';
import { io } from 'socket.io-client';

const BASE = 'http://localhost:3001';
const FRONT = 'http://localhost:5173';
const CHROME = '/usr/lib64/chromium-browser/chromium-browser';
const CH = 'ch_2'; // general (text)

const out = {};
const consoleErrors = [];
function rec(item, pass, note) {
  out[item] = { pass, note };
  console.log(`\n===== ${item} : ${pass ? 'PASS' : 'FAIL'} =====`);
  console.log('  ' + note);
}
async function api(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
async function tokenFor(name, pass = 'hy3pass123') {
  let j = await api('/api/auth/login', { username: name, password: pass }).catch(() => ({}));
  if (j && j.token) return j.token;
  j = await api('/api/auth/register', { username: name, password: pass, handle: name });
  return j.token;
}

const LAUNCH = {
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote']
};
let browser;
const ONLY = process.argv[2] || '';

async function setServer(page) {
  await page.evaluate(() => {
    const s = 'http://localhost:3001';
    sessionStorage.setItem('wabi.serverUrlSession', s);
    localStorage.setItem('wabi.serverUrl', s);
    localStorage.setItem('wabi.serverUrlRemember', 'true');
  });
}
async function makeSession(username, password) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERR: ' + e.message));
  await page.goto(FRONT, { waitUntil: 'domcontentloaded' });
  await setServer(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.getByPlaceholder(/username|handle/i).first().fill(username);
  await page.getByPlaceholder(/password/i).first().fill(password);
  await page.getByRole('button', { name: /^login$/i }).click();
  await page.waitForFunction(
    () => !!document.querySelector('textarea') || document.querySelectorAll('.message').length > 0 || !!document.querySelector('[class*="composer"]'),
    { timeout: 20000 }
  ).catch(() => {});
  return { ctx, page };
}
async function makeGuest(username) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERR: ' + e.message));
  await page.goto(FRONT, { waitUntil: 'domcontentloaded' });
  await setServer(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /guest/i }).click();
  await page.waitForFunction(
    () => !!document.querySelector('textarea') || document.querySelectorAll('.message').length > 0,
    { timeout: 20000 }
  ).catch(() => {});
  return { ctx, page };
}
async function gotoChannel(page) {
  await page.goto(FRONT + '/#channel/' + CH, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.waitForFunction(
    () => !!document.querySelector('textarea') || document.querySelectorAll('.message').length > 0,
    { timeout: 20000 }
  ).catch(() => {});
}
async function sendMessage(page, text) {
  await gotoChannel(page);
  const ta = page.locator('textarea').last();
  await ta.click();
  await ta.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((t) =>
    Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t)),
    text, { timeout: 12000 }).catch(() => {});
}
function ownMsg(page, text) { return page.locator('.message', { hasText: text }).last(); }
function menuItem(page, label) {
  return page.locator('.context-menu-surface .menu-item', { hasText: label }).first();
}

// A. Context menu
try {
  if (ONLY && ONLY !== 'A') { rec('A', true, 'skipped'); }
  else {
  browser = await chromium.launch(LAUNCH);
  const A = await makeSession('hy3new', 'hy3pass123');
  await gotoChannel(A.page);
  const tag = 'A_ctx_' + Date.now();
  await sendMessage(A.page, tag);
  const msg = ownMsg(A.page, tag);
  await msg.click({ button: 'right' });
  await A.page.waitForSelector('.context-menu-surface', { timeout: 5000 });
  const items = await A.page.locator('.context-menu-surface .menu-item').allInnerTexts();
  const menuOk = items.some((t) => /reply/i.test(t)) && items.some((t) => /edit message/i.test(t)) && items.some((t) => /delete message/i.test(t));
  await A.page.keyboard.press('Escape');
  await A.page.waitForTimeout(300);
  const more = A.page.locator('.message-actions .action-btn').last();
  await more.click();
  await A.page.waitForSelector('.context-menu-surface', { timeout: 5000 });
  const items2 = await A.page.locator('.context-menu-surface .menu-item').allInnerTexts();
  const moreOk = items2.some((t) => /reply/i.test(t)) && items2.some((t) => /edit message/i.test(t));
  await A.page.keyboard.press('Escape');
  rec('A', menuOk && moreOk, `items=[${items.join(' | ')}]; More->same=${moreOk}`);
  A.ctx.close();
  }
} catch (e) { rec('A', false, 'exception: ' + e.message); }
await browser.close().catch(() => {});

// B. Edit (context / pencil / ArrowUp)
try {
  if (ONLY && ONLY !== 'B') { rec('B', true, 'skipped'); }
  else {
  browser = await chromium.launch(LAUNCH);
  const B = await makeSession('hy3new', 'hy3pass123');
  await gotoChannel(B.page);
  const tag = 'B_edit_' + Date.now();
  await sendMessage(B.page, tag);
  const msg = ownMsg(B.page, tag);
  await msg.click({ button: 'right' });
  await B.page.waitForSelector('.context-menu-surface', { timeout: 5000 });
  await menuItem(B.page, 'Edit Message').click();
  await B.page.waitForSelector('.edit-textarea', { timeout: 5000 });
  const edited = tag + '_EDITED';
  await B.page.locator('.edit-textarea').fill(edited);
  await B.page.locator('.edit-save').click();
  await B.page.waitForFunction((t) =>
    Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t) && m.textContent.includes('(edited)')),
    edited, { timeout: 12000 }).catch(() => {});
  const b1 = (await B.page.locator('.message', { hasText: edited }).count()) > 0;

  const pencil = B.page.locator('.message-actions .action-btn[title="Edit Message"]').first();
  let b2 = false, note2 = 'pencil button absent (messageUtilities off?)';
  if (await pencil.count()) {
    await msg.hover();
    await pencil.click({ timeout: 5000 }).catch(async () => { await pencil.click({ force: true }); });
    await B.page.waitForSelector('.edit-textarea', { timeout: 5000 }).catch(() => {});
    if (await B.page.locator('.edit-textarea').count()) {
      const e2 = edited + '_PEN';
      await B.page.locator('.edit-textarea').fill(e2);
      await B.page.keyboard.press('Enter');
      await B.page.waitForFunction((t) => Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t)), e2, { timeout: 10000 }).catch(() => {});
      b2 = (await B.page.locator('.message', { hasText: e2 }).count()) > 0;
      note2 = 'pencil edit worked';
    }
  }
  const lastText = 'B_arrow_' + Date.now();
  await sendMessage(B.page, lastText);
  const ta = B.page.locator('textarea').last();
  await ta.click();
  await B.page.keyboard.press('ArrowUp');
  await B.page.waitForSelector('.edit-textarea', { timeout: 5000 }).catch(() => {});
  let b3 = false;
  if (await B.page.locator('.edit-textarea').count()) {
    const e3 = lastText + '_UP';
    await B.page.locator('.edit-textarea').fill(e3);
    await B.page.keyboard.press('Enter');
    await B.page.waitForFunction((t) => Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t)), e3, { timeout: 10000 }).catch(() => {});
    b3 = (await B.page.locator('.message', { hasText: e3 }).count()) > 0;
  }
  rec('B', b1 > 0 && b2 && b3, `context-edit (edited)=${b1 > 0}; pencil=${note2}; ArrowUp=${b3}`);
  B.ctx.close();
  }
} catch (e) { rec('B', false, 'exception: ' + e.message); }
await browser.close().catch(() => {});

// C. Delete
try {
  if (ONLY && ONLY !== 'C') { rec('C', true, 'skipped'); }
  else {
  browser = await chromium.launch(LAUNCH);
  const C = await makeSession('hy3new', 'hy3pass123');
  await gotoChannel(C.page);
  const tag = 'C_del_' + Date.now();
  await sendMessage(C.page, tag);
  const before = await C.page.locator('.message', { hasText: tag }).count();
  const msg = ownMsg(C.page, tag);
  await msg.click({ button: 'right' });
  await C.page.waitForSelector('.context-menu-surface', { timeout: 5000 });
  await menuItem(C.page, 'Delete Message').click();
  const confirmBtn = C.page.getByRole('button', { name: /delete/i }).last();
  await confirmBtn.click().catch(async () => { await C.page.locator('button:has-text("Delete")').last().click(); });
  await C.page.waitForFunction((t) => !Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t)), tag, { timeout: 12000 }).catch(() => {});
  const after = await C.page.locator('.message', { hasText: tag }).count();
  rec('C', before > 0 && after === 0, `before=${before}, after=${after} (vanished=${after === 0})`);
  C.ctx.close();
  }
} catch (e) { rec('C', false, 'exception: ' + e.message); }
await browser.close().catch(() => {});

// D. Auth edges (other users' messages + guest own)
try {
  if (ONLY && ONLY !== 'D') { rec('D', true, 'skipped'); }
  else {
  browser = await chromium.launch(LAUNCH);
  const A = await makeSession('hy3new', 'hy3pass123');
  await gotoChannel(A.page);
  const tagA = 'D_a_' + Date.now();
  await sendMessage(A.page, tagA); // persisted in general

  const B = await makeSession('hy3b', 'hy3pass123');
  await gotoChannel(B.page); // B views A's persisted message
  let sawOther = false;
  for (let i = 0; i < 6 && !sawOther; i++) {
    await B.page.waitForTimeout(1500);
    await B.page.goto(FRONT + '/#channel/' + CH, { waitUntil: 'load' }).catch(() => {});
    await B.page.waitForTimeout(1500);
    sawOther = await B.page.evaluate((t) =>
      Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t)), tagA);
  }
  const otherMsg = B.page.locator('.message', { hasText: tagA }).last();
  await otherMsg.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await otherMsg.click({ button: 'right', timeout: 15000 }).catch(() => {});
  await B.page.waitForSelector('.context-menu-surface', { timeout: 5000 });
  const items = await B.page.locator('.context-menu-surface .menu-item').allInnerTexts();
  const editHidden = !items.some((t) => /edit message/i.test(t));
  const delItem = B.page.locator('.context-menu-surface .menu-item', { hasText: /delete message/i }).first();
  const delDisabled = await delItem.isDisabled().catch(() => false);
  const hint = await B.page.locator('.context-menu-surface .menu-hint').first().innerText().catch(() => '');
  await B.page.keyboard.press('Escape');

  const G = await makeGuest('hy3guest');
  await gotoChannel(G.page);
  const gtag = 'D_guest_' + Date.now();
  await sendMessage(G.page, gtag);
  const gmsg = ownMsg(G.page, gtag);
  await gmsg.click({ button: 'right' });
  await G.page.waitForSelector('.context-menu-surface', { timeout: 5000 });
  const gitems = await G.page.locator('.context-menu-surface .menu-item').allInnerTexts();
  const guestEdit = gitems.some((t) => /edit message/i.test(t));
  const guestDelDisabled = await G.page.locator('.context-menu-surface .menu-item', { hasText: /delete message/i }).first().isDisabled().catch(() => true);
  await G.page.keyboard.press('Escape');
  G.ctx.close();

  const ok = sawOther && editHidden && delDisabled && /own/i.test(hint) && guestEdit && !guestDelDisabled;
  rec('D', ok, `sawOther=${sawOther}; otherUser: editHidden=${editHidden}, deleteDisabled=${delDisabled}, hint="${hint}"; guest: ownEdit=${guestEdit}, ownDeleteEnabled=${!guestDelDisabled}`);
  A.ctx.close(); B.ctx.close();
  }
} catch (e) { rec('D', false, 'exception: ' + e.message); }
await browser.close().catch(() => {});

// E. Timed delete
try {
  if (ONLY && ONLY !== 'E') { rec('E', true, 'skipped'); }
  else {
  browser = await chromium.launch(LAUNCH);
  const tok = await tokenFor('hy3new');
  const E = await makeSession('hy3new', 'hy3pass123');
  await gotoChannel(E.page);
  const sock = io(BASE, { auth: { token: tok }, transports: ['websocket'] });
  await new Promise((res) => sock.on('connect', res));
  sock.emit('update-channel-settings', { channelId: CH, settings: { autoDeleteAfter: '5s' } });
  await new Promise((r) => setTimeout(r, 600));
  const tag = 'E_ttl_' + Date.now();
  await sendMessage(E.page, tag);
  await E.page.waitForFunction((t) => !Array.from(document.querySelectorAll('.message')).some((m) => m.textContent.includes(t)), tag, { timeout: 13000 }).catch(() => {});
  const stillThere = await E.page.locator('.message', { hasText: tag }).count();
  sock.emit('update-channel-settings', { channelId: CH, settings: { autoDeleteAfter: null } });
  sock.close();
  rec('E', stillThere === 0, `channel=${CH}; after 5s present=${stillThere} (expired=${stillThere === 0})`);
  E.ctx.close();
  }
} catch (e) { rec('E', false, 'exception: ' + e.message); }
await browser.close().catch(() => {});

// F. Regressions
try {
  if (ONLY && ONLY !== 'F') { rec('F', true, 'skipped'); }
  else {
  browser = await chromium.launch(LAUNCH);
  const F = await makeSession('hy3new', 'hy3pass123');
  await gotoChannel(F.page);
  const tag = 'F_cozy_' + Date.now();
  await sendMessage(F.page, tag);
  const rightPanel = await F.page.locator('.right-panel').count();
  const cozy = await F.page.evaluate(() => {
    const m = document.querySelector('.message');
    return m ? getComputedStyle(m).paddingTop : 'no-message';
  });
  await F.page.waitForTimeout(1500);
  rec('F', rightPanel > 0, `rightPanel present=${rightPanel > 0}; cozy message padding="${cozy}"; consoleErrors=${consoleErrors.length}`);
  F.ctx.close();
  }
} catch (e) { rec('F', false, 'exception: ' + e.message); }
await browser.close().catch(() => {});

console.log('\n\n############ FINAL REPORT ############');
for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const r = out[k];
  console.log(`${k}: ${r ? (r.pass ? 'PASS' : 'FAIL') : 'SKIP'} — ${r ? r.note : ''}`);
}
console.log(`\nconsoleErrors captured total: ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.slice(0, 40).join('\n'));
process.exit(0);
