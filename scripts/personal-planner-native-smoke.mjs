#!/usr/bin/env node
// Real Linux WebKit/Tauri acceptance. All files/processes use disposable profiles.
// UI forms, imports and downloads remain real. The emitted Blob and downloaded
// file are both checked without replacing persistence or IPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, rename, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';

assert.ok(process.argv[2], 'Usage: node scripts/personal-planner-native-smoke.mjs /absolute/wabi-desktop');
const source = resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), 'wabi-personal-native-'));
for (const name of ['bin', 'data', 'config', 'cache', 'home']) await mkdir(join(scratch, name));
const binary = join(scratch, 'bin', 'wabi-desktop');
const sidecar = join(scratch, 'bin', 'wabi-server');
await copyFile(source, binary); await chmod(binary, 0o755);
await copyFile(join(dirname(source), 'wabi-server'), sidecar); await chmod(sidecar, 0o755);
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const driver = spawn(process.env.WABI_WEBKIT_DRIVER || 'WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], {
  cwd: scratch,
  env: { ...process.env, HOME: join(scratch, 'home'), XDG_DATA_HOME: join(scratch, 'data'),
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    GDK_BACKEND: 'x11', TAURI_WEBVIEW_AUTOMATION: 'true', WEBKIT_DISABLE_DMABUF_RENDERER: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '', session, hidden = false;
driver.stdout.on('data', data => log += data); driver.stderr.on('data', data => log += data);
driver.on('error', error => log += String(error));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
const execute = (script, args = []) => request('POST', `/session/${session}/execute/sync`, { script, args });
async function invoke(command, args = {}) {
  const result = await request('POST', `/session/${session}/execute/async`, {
    script: 'const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));', args: [command, args] });
  if (result.error) throw new Error(result.error);
  return result.value;
}
async function waitFor(check, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (error) { if (!String(error).includes('no such frame')) throw error; }
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(selector) {
  await waitFor(() => execute('const el=document.querySelector(arguments[0]);return Boolean(el&&!el.disabled)', [selector]), selector);
  await execute('document.querySelector(arguments[0]).click()', [selector]);
}
async function button(text) {
  await waitFor(() => execute('return Array.from(document.querySelectorAll("button")).some(el=>el.textContent.trim()===arguments[0]&&!el.disabled)', [text]), text);
  await execute('Array.from(document.querySelectorAll("button")).find(el=>el.textContent.trim()===arguments[0]&&!el.disabled).click()', [text]);
}
async function fill(selector, value) {
  await waitFor(() => execute('return Boolean(document.querySelector(arguments[0]))', [selector]), selector);
  await execute('const el=document.querySelector(arguments[0]);el.value=arguments[1];el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));', [selector, value]);
}
async function open() {
  const result = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry',
    'webkitgtk:browserOptions': { binary }, timeouts: { pageLoad: 60000, script: 45000, implicit: 0 } } } });
  session = result.sessionId;
  await waitFor(() => execute('return Boolean(window.__TAURI_INTERNALS__)'), 'actual native bridge');
  // Explicitly navigate to the same independent entry that the Login link uses.
  await request('POST', `/session/${session}/url`, { url: 'tauri://localhost/personal' });
  await waitFor(() => execute('return document.body.innerText.includes("Saved in your personal workspace")'), 'personal storage');
  assert.equal((await invoke('host_status')).hasCommunity, false, 'personal does not bootstrap a community');
}
async function quit() {
  await invoke('host_quit').catch(() => {});
  await request('DELETE', `/session/${session}`).catch(() => {}); session = undefined;
}
async function screenshot(name) {
  if (process.env.WABI_NATIVE_SKIP_SCREENSHOTS === '1') return;
  const data = await request('GET', `/session/${session}/screenshot`);
  await writeFile(join(scratch, `${name}.png`), Buffer.from(data, 'base64'));
}
const scope = 'planner:personal-desktop:v1';
async function read() {
  // A read probe may overlap the UI's autosave OS lock. Retry only this
  // read-only contention; mutations and other storage failures are not retried.
  for (let attempt = 0; ; attempt++) {
    try { return await invoke('personal_planner_request', { request: { scope, operation: 'read' } }); }
    catch (error) {
      if (attempt >= 10 || !String(error).includes('Personal Planner is busy. Retry saving.')) throw error;
      await sleep(100);
    }
  }
}
async function saved(check, label) { await waitFor(async () => check((await read())?.data), label); }
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const code = 'Native journal proof\n\n```ts\nconst posters = 3;\n```';
let report;
try {
  await waitFor(async () => {
    if (driver.exitCode !== null) throw new Error(log);
    try { return (await request('GET', '/status')).ready; } catch { return false; }
  }, 'WebKitWebDriver');
  await open();
  assert.equal(await read(), null, 'fresh native profile');
  await click('[role=tablist] button:nth-child(4)');
  await click('button[aria-label="Create project"]');
  await fill('#projectName', 'Native poster season');
  await click('.modal button[type=submit]');
  await saved(data => data?.projects.some(row => row.name === 'Native poster season'), 'project persisted');
  await click('[role=tablist] button:nth-child(2)');
  await click('button[aria-label="Add board task"]');
  await fill('#title', 'Prepare poster proofs');
  await click('.modal button[type=submit]');
  await saved(data => data?.todos.some(row => row.title === 'Prepare poster proofs'), 'task persisted');
  await click('[role=tablist] button:nth-child(1)');
  await click('button[aria-label="Add calendar event"]');
  await fill('#title', 'Print deadline');
  await click('.modal button[type=submit]');
  await saved(data => data?.calendarEvents.some(row => row.title === 'Print deadline'), 'event persisted');
  await click('[role=tablist] button:nth-child(3)');
  await click('button[aria-label="New journal entry for today"]');
  await fill('textarea[aria-label="Journal entry content"]', code);
  // Real image paste event -> FileReader -> editor -> native snapshot.
  await execute(`const raw=atob(arguments[0].split(',')[1]);const file=new File([Uint8Array.from(raw,c=>c.charCodeAt(0))],'pixel.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);document.querySelector('textarea[aria-label="Journal entry content"]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));`, [image]);
  await waitFor(() => execute('return Boolean(document.querySelector(".image-preview-grid img")?.complete)'), 'pasted image');
  await button('Save Entry');
  await saved(data => data?.diaryEntries.some(row => row.content === code && row.images?.length === 1), 'journal code and image persisted');
  const initial = await read();
  await screenshot('journal');
  await quit(); await open();
  assert.deepEqual(await read(), initial, 'quit/reopen exact native snapshot');
  await click('[role=tablist] button:nth-child(3)');
  await waitFor(() => execute('return document.body.innerText.includes("Native journal proof")'), 'saved journal rendered');
  await screenshot('reopened');
  // Observe the real Export button payload; do not replace persistence or IPC.
  await execute('const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.exportedPlannerBlob=blob;return create(blob)}');
  await click('button[aria-label="Planner options"]');
  await click('.planner-overflow-menu button:first-of-type');
  const backup = await request('POST', `/session/${session}/execute/async`, {
    script: 'const done=arguments[arguments.length-1];window.exportedPlannerBlob.text().then(done);', args: [] });
  assert.equal(JSON.parse(backup).sourceScope, scope);
  assert.deepEqual(JSON.parse(backup).diaryEntries, initial.data.diaryEntries);
  await writeFile(join(scratch, 'exported-backup.json'), backup);
  await waitFor(async () => {
    try { return await readFile(join(scratch, 'wabi-planner-backup.json'), 'utf8') === backup; } catch { return false; }
  }, 'native backup download completed');
  const imported = JSON.parse(backup);
  imported.projects[0] = { ...imported.projects[0], id: 'native-import-copy', name: 'Imported poster copy' };
  await execute(`const transfer=new DataTransfer();transfer.items.add(new File([arguments[0]],'backup.json',{type:'application/json'}));const el=document.querySelector('input[accept="application/json,.json"]');el.files=transfer.files;el.dispatchEvent(new Event('change',{bubbles:true}));`, [JSON.stringify(imported)]);
  await saved(data => data?.projects.some(row => row.id === 'native-import-copy') && data.projects.some(row => row.name === 'Native poster season'), 'additive backup import');
  const beforeFailure = await read();
  // Hide only our copied sidecar. Never mutate the installed/staged executable.
  await rename(sidecar, `${sidecar}.offline`); hidden = true;
  await click('[role=tablist] button:nth-child(2)');
  await click('button[aria-label="Add board task"]');
  await fill('#title', 'Retained offline draft');
  await click('.modal button[type=submit]');
  await waitFor(() => execute('return Boolean(document.querySelector(".storage-notice[role=alert]"))'), 'storage failure shown');
  await button('Export draft');
  const draft = await request('POST', `/session/${session}/execute/async`, {
    script: 'const done=arguments[arguments.length-1];window.exportedPlannerBlob.text().then(done);', args: [] });
  assert.ok(JSON.parse(draft).todos.some(row => row.title === 'Retained offline draft'));
  await writeFile(join(scratch, 'unsaved-draft.json'), draft);
  await waitFor(async () => {
    try { return await readFile(join(scratch, 'wabi-planner-draft.json'), 'utf8') === draft; } catch { return false; }
  }, 'native recovery download completed');
  await screenshot('sidecar-unavailable');
  await rename(`${sidecar}.offline`, sidecar); hidden = false;
  assert.deepEqual(await read(), beforeFailure, 'failed save leaves accepted snapshot untouched');
  await button('Retry save');
  await saved(data => data?.todos.some(row => row.title === 'Retained offline draft'), 'retry saves retained draft');
  const entries = await execute('return performance.getEntriesByType("resource").map(entry=>entry.name)');
  const external = entries.filter(url => /^https?:/.test(url) && !url.startsWith('http://tauri.localhost/'));
  assert.deepEqual(external, [], 'no observed external resource requests on personal document');
  const final = await read();
  await quit(); await open();
  assert.deepEqual(await read(), final, 'recovered draft survives restart');
  const profiles = await readdir(join(scratch, 'data'));
  report = { passed: true, runtime: 'Linux Tauri/WebKit, actual IPC and matching staged sidecar',
    source, scratch, profiles, projectTaskEventJournal: true, codeAndImagePayload: true,
    quitReopen: true, backupDownloadAndAdditiveImport: true, missingSidecarDraftAndRetry: true,
    observedExternalResources: external, limits: ['Built executable, not installed package',
      'Resource timing observation, not kernel-level network isolation',
      'No non-Linux or physical power-loss acceptance'] };
  console.log(`PASS personal native save/reopen, backup/import, missing-sidecar draft/retry. Evidence: ${scratch}`);
} catch (error) {
  report = { passed: false, scratch, error: String(error) };
  console.error(`FAIL ${error}. Evidence: ${scratch}`); process.exitCode = 1;
} finally {
  if (hidden) await rename(`${sidecar}.offline`, sidecar).catch(() => {});
  if (session) await quit().catch(() => {});
  driver.kill('SIGTERM');
  await Promise.race([once(driver, 'exit'), sleep(3000)]);
  if (driver.exitCode === null) driver.kill('SIGKILL');
  await writeFile(join(scratch, 'native.log'), log);
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
}
