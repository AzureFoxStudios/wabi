// UI flow: nok creates a customer + job via the browser, drafts a quotation, adds a line with the picker, saves with ⌘S, issues it.
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
const base = 'http://localhost:8080';
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name) => { await sleep(700); await page.screenshot({ path: `./flow-${name}.png`, fullPage: true }); console.log('step', name, page.url()); };
async function clickText(sel, text) {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text));
    if (el) el.click();
    return !!el;
  }, sel, text);
  if (!ok) throw new Error(`no ${sel} containing "${text}"`);
}
await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('sabi.locale', 'en'));
await page.reload({ waitUntil: 'networkidle0' });
await page.type('input[autocomplete=username]', 'nok');
await page.type('input[type=password]', 'demo1234');
await page.keyboard.press('Enter');
await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
await step('1-today');

// New customer
await page.goto(`${base}/parties/new?role=customer`, { waitUntil: 'networkidle2' });
await page.type('form input[required]', 'Pranee Garage');
await page.type('input[inputmode=tel]', '081-555-0101');
await clickText('button', 'Create');
await sleep(900);
const partyUrl = page.url();
await step('2-party');

// New job for the customer
await clickText('a', 'New job');
await page.waitForSelector('form');
await sleep(400);
await page.type('input[placeholder^="e.g."]', 'Garage roof replacement');
await step('3-newjob');
await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
await sleep(1200);
const jobUrl = page.url();
await step('4-job');

// Create a quotation from the job's documents tab
await page.goto(`${jobUrl.split('#')[0]}#documents`, { waitUntil: 'networkidle2' });
await sleep(500);
await step('5-jobdocs');
await clickText('button, a', 'Quotation');
await sleep(1200);
await step('6-draft');
// add a line with the picker
await clickText('button', 'Add line');
await sleep(300);
const pickers = await page.$$('.lines .picker input');
await pickers[pickers.length - 1].type('SVC-INSTALL');
await sleep(700);
await page.keyboard.press('Enter');
await sleep(400);
const qtys = await page.$$('.lines td.c-q input');
await qtys[qtys.length - 1].evaluate((e) => e.select());
await qtys[qtys.length - 1].type('42');
await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
await sleep(1200);
await step('7-saved');
await clickText('button', 'Issue');
await sleep(1200);
await step('8-issued');
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no errors');
await browser.close();
