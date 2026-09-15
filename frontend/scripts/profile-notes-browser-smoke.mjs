import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
let vite, browser;
try {
 vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0, open: false }, plugins: [{ name: 'profile-note-fixture', configureServer(server) {
  server.middlewares.use('/favicon.ico', (_req, res) => { res.statusCode = 204; res.end(); });
  server.middlewares.use('/profile-note-fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Profile annotation storage</title><p>Testing isolated profile notes.</p>'); });
 } }] });
 await vite.listen();
 browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
 const context = await browser.newContext();
 const a = await context.newPage(), b = await context.newPage();
 for (const page of [a, b]) {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/profile-note-fixture`);
  await page.evaluate(async () => { window.notes = await import('/src/lib/userNotes.ts'); window.active = true; window.owner = { scopeId: 'server-a:account-1', isCurrent: () => window.active }; });
 }
 const original = await a.evaluate(() => window.notes.setUserNote(window.owner, '10', 'Original prose\nsecond line', 0));
 assert.equal(original.revision, 1);
 const concurrent = await Promise.all([a, b].map((page, i) => page.evaluate(async i => { try { return { ok: true, note: await window.notes.setUserNote(window.owner, '10', `Writer ${i}`, 1) }; } catch(error) { return { ok: false, code: error.code }; } }, i)));
 assert.equal(concurrent.filter(r => r.ok).length, 1);
 assert.equal(concurrent.find(r => !r.ok).code, 'conflict');
 assert.equal(await b.evaluate(async () => (await window.notes.getUserNote({ scopeId: 'server-b:account-1', isCurrent: () => true }, '10')).text), '');
 assert.equal(await b.evaluate(async () => (await window.notes.getUserNote({ scopeId: 'server-a:account-2', isCurrent: () => true }, '10')).text), '');
 const cleared = await a.evaluate(() => window.notes.clearUserNote(window.owner, '10', 2));
 assert.equal(cleared.revision, 3);
 assert.equal(cleared.text, '');
 assert.equal(await b.evaluate(async () => { try { await window.notes.setUserNote(window.owner, '10', 'resurrect stale', 0); return false; } catch(error) { return error.code === 'conflict'; } }), true);
 const failures = await a.evaluate(async () => {
  const { openNotebookDatabase } = await import('/src/lib/notes/db.ts');
  const db = await openNotebookDatabase(); const original = db.transaction.bind(db);
  window.notes.retainUserNoteDraft(window.owner, '10', { text: 'Keep my failed draft', baseRevision: 3 });
  db.transaction = (...args) => { const tx = original(...args); if (args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; };
  let aborted = false; try { await window.notes.setUserNote(window.owner, '10', 'Keep my failed draft', 3); } catch { aborted = true; } finally { db.transaction = original; }
  const saved = await window.notes.getUserNote(window.owner, '10');
  const retained = window.notes.getUserNoteDraft(window.owner, '10');
  const invisible = window.notes.getUserNoteDraft({ scopeId: 'server-a:account-2', isCurrent: () => true }, '10');
  window.active = false; let retired = false; try { await window.notes.setUserNote(window.owner, '10', 'wrong account', 3); } catch(error) { retired = error.code === 'retired'; }
  return { aborted, saved: saved.text, retained: retained.text, invisible: invisible === undefined, retired };
 });
 assert.deepEqual(failures, { aborted: true, saved: '', retained: 'Keep my failed draft', invisible: true, retired: true });
 const legacy = await b.evaluate(async () => {
  const raw = '{"socket-id":"ambiguous old prose"';
  localStorage.setItem(window.notes.USER_NOTES_STORAGE_KEY, raw);
  const found = window.notes.hasLegacyUserNotes();
  const saved = await window.notes.getUserNote(window.owner, '99');
  return { found, preserved: localStorage.getItem(window.notes.USER_NOTES_STORAGE_KEY) === raw, empty: saved.text === '', rejected: window.notes.stableUserNoteSubject('socket-id') === null };
 });
 assert.deepEqual(legacy, { found: true, preserved: true, empty: true, rejected: true });
 console.log('PASS: profile note CAS, scope separation, clear tombstones, aborted writes, retained drafts, retired owners and untouched ambiguous legacy bytes.');
} finally { await browser?.close(); await vite?.close(); }
