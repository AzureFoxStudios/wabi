#!/usr/bin/env node
// Linux equivalent-desktop smoke: real Tauri webview, IPC, Authority and isolated
// OS-profile data. Requires WebKitWebDriver and a display. No mocked host bridge.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { measureDesktopIdle } from './desktop-idle-metrics.mjs';

assert.ok(process.argv[2], 'Usage: dbus-run-session -- node scripts/desktop-shell-native-smoke.mjs /absolute/wabi-desktop');
const binary = resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), 'wabi-native-host-'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
for (const name of ['data', 'config', 'cache']) await mkdir(join(scratch, name));
const driver = spawn(process.env.WABI_WEBKIT_DRIVER || 'WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], {
  env: { ...process.env, XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    GDK_BACKEND: 'x11', TAURI_WEBVIEW_AUTOMATION: 'true', WABI_SKIP_VIEWER_TEST: '1',
    ...(process.env.WABI_NATIVE_DEFAULT_RENDERER === '1' ? {} : { WEBKIT_DISABLE_DMABUF_RENDERER: '1' }) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
driver.stdout.on('data', data => output += data); driver.stderr.on('data', data => output += data);
let session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
async function execute(script, args = []) { return request('POST', `/session/${session}/execute/sync`, { script, args }); }
async function invoke(command, args = {}) {
  const result = await request('POST', `/session/${session}/execute/async`, { script: `const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));`, args: [command, args] });
  if (result.error) throw new Error(`${command}: ${result.error}`);
  return result.value;
}
async function waitFor(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) {
      // Start & open performs a real document navigation. Retry only the
      // driver's document-retirement signal, not application/IPC failures.
      if (!String(error).includes('no such frame')) throw error;
    }
    await sleep(200);
  }
  throw new Error(`Timed out: ${description}`);
}
async function startApp() {
  const value = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'webkitgtk:browserOptions': { binary }, timeouts: { implicit: 0, pageLoad: 60000, script: 80000 } } } });
  session = value.sessionId;
  await waitFor(() => execute('return Boolean(window.__TAURI_INTERNALS__)'), 'native bridge');
  await waitFor(() => execute('return document.body.innerText.includes("My communities")'), 'desktop entry');
  await waitFor(() => execute('return !document.getElementById("wabi-boot-shell")'), 'initial boot overlay dismissed');
}
async function screenshot(name) {
  const data = await request('GET', `/session/${session}/screenshot`);
  await writeFile(join(scratch, `${name}.png`), Buffer.from(data, 'base64'));
}
async function nativeAppPid() {
  const children = (await readFile(`/proc/${driver.pid}/task/${driver.pid}/children`, 'utf8')).trim().split(/\s+/);
  for (const pid of children) {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (command.split('\0')[0] === binary) return pid;
  }
  throw new Error('driver does not own native process');
}
async function pageFootprint() {
  return execute('return { nodes: document.querySelectorAll("*").length, canvases: [...document.querySelectorAll("canvas")].map(canvas => ({width: canvas.width, height: canvas.height})), resources: performance.getEntriesByType("resource").length }');
}
// Run under dbus-run-session to isolate single-instance ownership from real Wabi.
let localUrl;
try {
  await waitFor(async () => { try { return (await request('GET', '/status')).ready; } catch { return false; } }, 'WebKit driver');
  await startApp();
  const entrySeconds = Number(process.env.WABI_ENTRY_BENCHMARK_SECONDS || 0);
  if (entrySeconds > 0) {
    const entryPid = await nativeAppPid();
    await sleep(3000);
    const entryIdle = await measureDesktopIdle(entryPid, entrySeconds);
    console.log('Entry idle:', JSON.stringify(entryIdle));
    console.log('Entry footprint:', JSON.stringify(await pageFootprint()));
    await writeFile(join(scratch, 'entry-idle.json'), JSON.stringify(entryIdle, null, 2));
  }
  await waitFor(() => execute('return Boolean(document.querySelector(".desktop-titlebar"))'), 'custom titlebar');
  await waitFor(async () => !(await invoke('plugin:window|is_decorated', { label: 'main' })), 'native chrome hands off to custom titlebar');
  async function clickControl(label) { await execute('document.querySelector(`[aria-label="${arguments[0]}"]`).click()', [label]); }
  await clickControl('Wabi menu');
  await screenshot('wabi-menu');
  await clickControl('Zoom in');
  assert.equal(Math.round((await invoke('desktop_action', { action: 'zoom-level' })) * 100), 110);
  await clickControl('Reset zoom');
  await execute('document.querySelector(".desktop-app-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await execute('return document.activeElement?.getAttribute("aria-label")'), 'Wabi menu');
  assert.equal(await invoke('plugin:notification|is_permission_granted'), true, 'native notification permission is accessible');
  async function clickText(text) {
    await waitFor(() => execute('return Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === arguments[0] && !button.disabled)', [text]), `button ${text}`);
    await execute('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === arguments[0] && !button.disabled).click()', [text]);
  }
  await clickText('Host a community');
  await waitFor(() => execute('return Boolean(document.querySelector(".mode-choice"))'), 'hosting choice');
  await execute('document.querySelector(".mode-choice").click()');
  await waitFor(() => execute('return Boolean(document.querySelector("#owner-name"))'), 'owner form');
  await execute(`for(const [id,value] of Object.entries(arguments[0])){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}`, [{ 'community-name': 'Titlebar test', 'owner-name': 'titlebar_tester', 'owner-password': 'Disposable-Titlebar-2026!', 'owner-confirm': 'Disposable-Titlebar-2026!' }]);
  await clickText('Host Server');
  await waitFor(() => execute('return document.body.innerText.includes("Invite a friend")'), 'community ready');
  await clickText('Open community');
  await waitFor(() => execute('return Boolean(document.querySelector(".app-container")) && Boolean(document.querySelector(".desktop-titlebar"))'), 'workspace and custom chrome');
  await waitFor(() => execute('return !document.getElementById("wabi-boot-shell")'), 'workspace boot completes');
  await waitFor(async () => !(await invoke('plugin:window|is_decorated', { label: 'main' })), 'workspace custom chrome ready');
  await sleep(300);
  assert.equal(await execute('return document.querySelector(".app-container").getBoundingClientRect().top >= 44'), true, 'workspace clears titlebar');
  assert.equal(await execute('return document.querySelector(".channel-sidebar").getBoundingClientRect().bottom <= innerHeight + 1'), true, 'sidebar footer fits below titlebar');
  await execute('document.querySelector(".server-identity").click()');
  await waitFor(() => execute('return Boolean(document.querySelector(".server-hub h1"))'), 'current-server hub opens from server name');
  assert.equal(await execute('return document.querySelector(".server-identity").getAttribute("aria-current")'), 'page', 'server identity marks the active hub');
  await screenshot('server-hub');
  await clickText('Server settings');
  await waitFor(() => execute('return Boolean(document.querySelector(".wabi-settings-modal .settings-tab.active"))'), 'server settings open');
  assert.match(await execute('return document.querySelector(".wabi-settings-modal .settings-tab.active").textContent.trim()'), /Server/i, 'server settings tab is selected');
  await execute('document.querySelector(".wabi-settings-modal .close-btn").click()');
  await clickText('Browse channels');
  await waitFor(() => execute('return !document.querySelector(".server-hub")'), 'browse returns to channel stage');
  await clickControl('Wabi menu');
  await waitFor(() => execute('return Boolean(document.querySelector(".desktop-menu-item"))'), 'workspace menu opens');
  await execute('Array.from(document.querySelectorAll(".desktop-menu-item")).find(button => button.textContent.includes("All servers"))?.click()');
  await waitFor(() => execute('return Boolean(document.querySelector(".server-switcher-overlay .switcher-close"))'), 'menu opens full server list');
  assert.equal(await execute('return document.activeElement?.getAttribute("aria-label")'), 'Close server switcher', 'server switcher receives focus');
  await clickControl('Close server switcher');
  await clickControl('Wabi menu');
  await execute('Array.from(document.querySelectorAll(".desktop-menu-item")).find(button => button.textContent.includes("Pin server rail"))?.click()');
  assert.equal(await execute('return localStorage.getItem("wabi.desktop.serverRailPinned")'), 'true', 'server rail preference persists');
  await execute('Array.from(document.querySelectorAll(".desktop-menu-item")).find(button => button.textContent.includes("Settings"))?.click()');
  await waitFor(() => execute('return Boolean(document.querySelector(".wabi-settings-modal"))'), 'menu opens real Settings');
  assert.equal(await execute('return document.querySelector(".wabi-settings-overlay").getBoundingClientRect().top >= 44'), true, 'settings clears titlebar');
  await screenshot('settings-with-titlebar');
  await execute('document.querySelector(".wabi-settings-modal .close-btn").click()');
  await waitFor(() => execute('return !document.querySelector(".wabi-settings-modal")'), 'close Settings');
  assert.equal(await execute('return [...document.querySelectorAll(".desktop-titlebar button")].every(button => !button.closest("[data-tauri-drag-region]"))'), true, 'interactive controls are not draggable regions');
  const host = await invoke('host_start');
  assert.equal(host.ready, true); localUrl = host.localUrl;
  const appPid = await nativeAppPid();
  console.log('Workspace footprint:', JSON.stringify(await pageFootprint()));
  const idleSeconds = Number(process.env.WABI_IDLE_BENCHMARK_SECONDS || 0);
  if (idleSeconds > 0) {
    const animations = await execute('return document.getAnimations().map(animation => ({ name: animation.animationName || "transition", target: animation.effect?.target?.className || animation.effect?.target?.tagName }))');
    console.log('Running animations:', JSON.stringify(animations));
    if (process.env.WABI_DISABLE_CSS_ANIMATIONS === '1') {
      await execute('document.getAnimations().forEach(animation => animation.pause())');
    }
    await sleep(Number(process.env.WABI_VISIBLE_WARMUP_SECONDS || 3) * 1000);
    const visibleSamples = Number(process.env.WABI_VISIBLE_SAMPLES || 1);
    assert.ok(Number.isInteger(visibleSamples) && visibleSamples > 0, 'positive visible sample count');
    for (let sample = 1; sample <= visibleSamples; sample++) {
      const visibleIdle = await measureDesktopIdle(appPid, idleSeconds);
      console.log(`Visible idle ${sample}/${visibleSamples}:`, JSON.stringify(visibleIdle));
      await writeFile(join(scratch, visibleSamples === 1 ? 'visible-idle.json' : `visible-idle-${sample}.json`), JSON.stringify(visibleIdle, null, 2));
    }
  }
  if (process.env.WABI_RESOURCE_ONLY === '1' && process.env.WABI_VISIBLE_ONLY === '1') {
    console.log(`PASS native visible resource sampling. Evidence: ${scratch}`);
  } else if (process.env.WABI_RESOURCE_ONLY === '1') {
    await clickControl('Minimize window');
    await sleep(3000);
    const backgroundSeconds = Number(process.env.WABI_BACKGROUND_SAMPLE_SECONDS || idleSeconds || 10);
    const backgroundSamples = Number(process.env.WABI_BACKGROUND_SAMPLES || 1);
    assert.ok(Number.isFinite(backgroundSeconds) && backgroundSeconds > 0, 'positive background sample duration');
    assert.ok(Number.isInteger(backgroundSamples) && backgroundSamples > 0, 'positive background sample count');
    for (let sample = 1; sample <= backgroundSamples; sample++) {
      const backgroundIdle = await measureDesktopIdle(appPid, backgroundSeconds);
      console.log(`Background idle ${sample}/${backgroundSamples}:`, JSON.stringify(backgroundIdle));
      await writeFile(join(scratch, `background-idle-${sample}.json`), JSON.stringify(backgroundIdle, null, 2));
    }
    await invoke('desktop_action', { action: 'show' });
    if (process.env.WABI_TEST_RIGHT_PANEL === '1') {
      await waitFor(() => execute('return Boolean(document.querySelector(".stub[aria-label=People]"))'), 'People panel stub');
      await execute('document.querySelector(".stub[aria-label=People]").click()');
      await waitFor(() => execute('return Boolean(document.querySelector(".right-panel .panel-stack-content"))'), 'lazy People panel');
      console.log('Right panel footprint:', JSON.stringify(await pageFootprint()));
      const panelIdle = await measureDesktopIdle(appPid, idleSeconds || 10);
      console.log('Right panel idle:', JSON.stringify(panelIdle));
      await writeFile(join(scratch, 'right-panel-idle.json'), JSON.stringify(panelIdle, null, 2));
    }
    console.log(`PASS native resource sampling. Evidence: ${scratch}`);
  } else {
  const entry = execFileSync('wmctrl', ['-lp'], { encoding: 'utf8' }).split('\n').find(line => line.trim().split(/\s+/)[2] === appPid);
  assert.ok(entry, 'managed main window exists');
  const windowId = entry.trim().split(/\s+/)[0];
  function wm(...args) { execFileSync('wmctrl', ['-ir', windowId, ...args]); }
  const state = name => invoke(`plugin:window|${name}`, { label: 'main' });
  await clickControl('Maximize window');
  await waitFor(() => state('is_maximized'), 'custom maximize');
  await waitFor(() => execute(`return Boolean(document.querySelector('[aria-label="Restore window"]'))`), 'restore icon state');
  await clickControl('Restore window');
  await waitFor(async () => !(await state('is_maximized')), 'custom restore');
  // Tauri's installed drag-region handler owns double-click, not a duplicate
  // DOM toggle that could maximize twice. Exercise its real IPC permission.
  await execute('document.querySelector(".desktop-drag").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }))');
  await waitFor(() => state('is_maximized'), 'titlebar double-click maximize');
  await clickControl('Restore window');
  await waitFor(async () => !(await state('is_maximized')), 'restore after double-click');
  await clickControl('Minimize window');
  await waitFor(() => state('is_minimized'), 'custom minimize');
  await invoke('desktop_action', { action: 'show' });
  wm('-e', '0,-1,-1,480,360');
  await waitFor(() => execute('return window.innerWidth <= 500'), 'small viewport');
  assert.equal(await execute('return [...document.querySelectorAll(".desktop-window-controls button")].every(button => { const r=button.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.height>=40; })'), true, 'all controls remain usable');
  await screenshot('small-native-window');
  wm('-e', '0,-1,-1,1200,800');
  // A real window-manager close request exercises the same path as native X.
  await clickControl('Close window to background');
  await waitFor(() => state('is_minimized'), 'close minimizes');
  assert.equal((await fetch(localUrl + '/readyz')).ok, true, 'close preserves owned server');
  if (idleSeconds > 0) {
    await sleep(3000);
    const backgroundIdle = await measureDesktopIdle(appPid, idleSeconds);
    console.log('Background idle:', JSON.stringify(backgroundIdle));
    await writeFile(join(scratch, 'background-idle.json'), JSON.stringify(backgroundIdle, null, 2));
  }
  const second = spawn(binary, [], { env: { ...process.env, GDK_BACKEND: 'x11',
    ...(process.env.WABI_NATIVE_DEFAULT_RENDERER === '1' ? {} : { WEBKIT_DISABLE_DMABUF_RENDERER: '1' }) }, stdio: 'ignore' });
  const [code] = await Promise.race([once(second, 'exit'), sleep(15000).then(() => { second.kill(); throw new Error('second instance did not exit'); })]);
  assert.equal(code, 0);
  await waitFor(async () => !(await state('is_minimized')) && await state('is_visible'), 'second launch restores first instance');
  assert.equal((await invoke('host_status')).localUrl, localUrl, 'same Authority after second launch');
  execFileSync('import', ['-window', windowId, join(scratch, 'whole-window.png')]);
  console.log('Native evidence:', scratch);
  await clickControl('Wabi menu');
  await execute('Array.from(document.querySelectorAll(".desktop-menu-item")).find(button => button.textContent.includes("Fullscreen")).click()');
  await waitFor(() => state('is_fullscreen'), 'custom menu fullscreen');
  await execute('window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", bubbles: true }))');
  await waitFor(async () => !(await state('is_fullscreen')), 'F11 leaves fullscreen');
  await screenshot('native-shell');
  await clickControl('Wabi menu');
  await screenshot('workspace-menu');
  await execute('document.querySelector(".desktop-app-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  // Explicit Quit must drain; window close above must not.
  await clickControl('Wabi menu');
  await execute('Array.from(document.querySelectorAll(".desktop-menu-item")).find(button => button.textContent.includes("Quit Wabi")).click()').catch(() => {});
  await waitFor(async () => { try { await readFile(`/proc/${appPid}/status`); return false; } catch { return true; } }, 'Quit exits original process');
  await waitFor(async () => { try { await fetch(localUrl + '/readyz'); return false; } catch { return true; } }, 'Quit stops owned Authority');
  console.log(JSON.stringify({ result: 'PASS', scratch, checks: ['custom titlebar with native startup fallback', 'notification permission', 'custom minimize/maximize/restore and double-click', 'workspace/settings offsets and small window', 'close minimizes without stopping Authority', 'second launch exits and restores first', 'custom menu zoom, keyboard dismissal, fullscreen and F11', 'Quit exits and stops Authority'] }, null, 2));
  }
} finally {
  if (session) {
    await invoke('host_quit').catch(() => {});
    await request('DELETE', `/session/${session}`).catch(() => {});
  }
  driver.kill();
  await writeFile(join(scratch, 'driver.log'), output);
}
