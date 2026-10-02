// UI flow (owner): turn on the corrections password, post a manual journal entry (the password prompt must appear),
// reverse it, then import two customers from a CSV file. Run against a freshly seeded demo on :8080.
import { writeFileSync } from 'node:fs';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
const base = 'http://localhost:8080';
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && errors.push(m.text()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name) => { await sleep(700); await page.screenshot({ path: `./books-${name}.png`, fullPage: true }); console.log('step', name, page.url()); };
const text = () => page.evaluate(() => document.body.innerText);
async function clickText(sel, t) {
  const ok = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled);
    if (el) el.click();
    return !!el;
  }, sel, t);
  if (!ok) throw new Error(`no enabled ${sel} containing "${t}"`);
}
const expect = async (t, why) => { if (!(await text()).includes(t)) throw new Error(`expected "${t}" — ${why}`); };

await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('sabi.locale', 'en'));
await page.reload({ waitUntil: 'networkidle0' });
await page.type('input[autocomplete=username]', 'owner');
await page.type('input[type=password]', 'demo1234');
await page.keyboard.press('Enter');
await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});

// 1. Corrections password
await page.goto(`${base}/settings#controls`, { waitUntil: 'networkidle2' });
await sleep(500);
await page.type('input[autocomplete=current-password]', 'demo1234');
await page.type('input[autocomplete=new-password]', 'fix-it-9876');
await clickText('button', 'Turn on');
await sleep(900);
await expect('on', 'corrections password is on');
await step('1-controls');

// 2. Manual journal entry → prompt → posted
await page.goto(`${base}/books`, { waitUntil: 'networkidle2' });
await clickText('button', 'New journal entry');
await sleep(300);
await page.type('.jeform input[required]:not([type=date])', 'Depreciation September — truck');
const selects = await page.$$('.jelines select');
await selects[0].select('5250').catch(async () => { const v = await selects[0].evaluate((s) => s.options[s.options.length - 1].value); await selects[0].select(v); });
await selects[1].select('1110').catch(() => {});
const nums = await page.$$('.jelines input[type=number]');
await nums[0].type('2500');
await nums[3].type('2500');
await step('2-form');
await clickText('button', 'Post entry');
await page.waitForSelector('dialog[open]', { timeout: 5000 });
await step('3-prompt');
await page.type('dialog[open] input[type=password]', 'fix-it-9876');
await clickText('dialog[open] button', 'Continue');
await sleep(1200);
await expect('Depreciation September', 'entry listed');
await step('4-posted');

// 3. Reverse it (password is cached for a few minutes, so no prompt)
await clickText('button', 'Reverse…');
await sleep(200);
await page.type('input[placeholder=Reason]', 'Wrong month');
await clickText('.entry button.danger', 'Reverse');
await sleep(1200);
await expect('reversed', 'reversal shown');
await page.goto(`${base}/books?t=corrections`, { waitUntil: 'networkidle2' });
await sleep(600);
await expect('Manual journal entry', 'manual entry in corrections report');
await expect('Reversed journal entry', 'reversal in corrections report');
await step('5-corrections');

// 4. CSV import: one bad row first (all-or-nothing), then fixed
const csv = (rows) => '\ufeffname,roles,tax_id,branch_code,phone,province\r\n' + rows.join('\r\n');
writeFileSync('/tmp/sabi-import.csv', csv(['"Wattana Steel Co., Ltd.",customer,,00000,02-111-2222,Bangkok', 'Bad Tax Id Shop,customer,123,00000,,Nonthaburi']));
await page.goto(`${base}/settings#import`, { waitUntil: 'networkidle2' });
await sleep(400);
let input = await page.$('input[type=file]');
await input.uploadFile('/tmp/sabi-import.csv');
await sleep(500);
await clickText('button', 'Import 2 rows');
await sleep(900);
await expect('Row 2', 'bad row reported');
await step('6-import-error');
writeFileSync('/tmp/sabi-import.csv', csv(['"Wattana Steel Co., Ltd.",customer,,00000,02-111-2222,Bangkok', 'Good Tax Id Shop,customer;supplier,,00000,,Nonthaburi']));
input = await page.$('input[type=file]');
await input.uploadFile('/tmp/sabi-import.csv');
await sleep(500);
await clickText('button', 'Import 2 rows');
await sleep(900);
await expect('Imported 2', 'import succeeded');
await page.goto(`${base}/parties`, { waitUntil: 'networkidle2' });
await sleep(500);
await expect('Wattana Steel', 'imported party listed');
await step('7-parties');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
await browser.close();
