#!/usr/bin/env node
// Linux equivalent-desktop smoke: real Tauri webview, IPC, Authority and isolated
// OS-profile data. Requires WebKitWebDriver and a display. No mocked host bridge.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

assert.ok(process.argv[2], 'Usage: node scripts/desktop-host-native-smoke.mjs /absolute/wabi-desktop');
const binary = resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), 'wabi-native-host-'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
for (const name of ['data', 'config', 'cache']) await mkdir(join(scratch, name));
const driver = spawn(process.env.WABI_WEBKIT_DRIVER || 'WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], {
  env: { ...process.env, XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    TAURI_WEBVIEW_AUTOMATION: 'true', WABI_SKIP_VIEWER_TEST: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
driver.stdout.on('data', data => output += data); driver.stderr.on('data', data => output += data);
let session;
let peerBrowser;
let secondClientJoined = false;
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
async function waitFor(check, description, timeout = 60000) {
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
async function click(label) {
  await waitFor(() => execute('return Array.from(document.querySelectorAll("button")).some(button=>button.textContent.trim()===arguments[0]&&!button.disabled)', [label]), `button ${label}`);
  await execute('Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()===arguments[0]&&!button.disabled).click()', [label]);
}
async function navigate(path) { await request('POST', `/session/${session}/url`, { url: `tauri://localhost${path}` }); }
async function startApp() {
  const value = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'webkitgtk:browserOptions': { binary }, timeouts: { implicit: 0, pageLoad: 60000, script: 80000 } } } });
  session = value.sessionId;
  await waitFor(() => execute('return Boolean(window.__TAURI_INTERNALS__)'), 'native bridge');
  await waitFor(() => execute('return document.body.innerText.includes("My communities")'), 'desktop entry');
  await waitFor(() => execute('return !document.getElementById("wabi-boot-shell")'), 'initial boot overlay dismissed');
}
async function screenshot(name) {
  // WebKitWebDriver's screenshot endpoint can stall after close/reopen on some
  // desktops even while script execution and the native bridge still work.
  // Keep the normal visual evidence path; allow a separate functional run.
  if (process.env.WABI_NATIVE_SKIP_SCREENSHOTS === '1') return;
  const data = await request('GET', `/session/${session}/screenshot`);
  await writeFile(join(scratch, `${name}.png`), Buffer.from(data, 'base64'));
}
try {
  await waitFor(async () => { try { return (await request('GET', '/status')).ready; } catch { if (driver.exitCode !== null) throw new Error(output); return false; } }, 'WebKit driver');
  await startApp();
  await click('Host a community');
	await waitFor(() => execute('return Boolean(document.querySelector(".mode-choice"))'), 'Simple or Configurable choice');
	await screenshot('setup-choices');
	await execute('document.querySelector(".mode-choice").click()');
  await waitFor(() => execute('return Boolean(document.querySelector("#owner-name"))'), 'owner form');
  const credentials = { username: 'native_host_owner', password: 'Disposable-Native-Host-2026!' };
  await execute(`for(const [id,value] of Object.entries(arguments[0])){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}`, [{ 'community-name': 'Native smoke community', 'owner-name': credentials.username, 'owner-password': credentials.password, 'owner-confirm': credentials.password }]);
  await screenshot('first-owner');
  await click('Host Server');
	await waitFor(() => execute('return document.body.innerText.includes("Invite a friend")'), 'ready community offers invitation immediately');
	await click('Open community');
  await waitFor(() => execute('return location.pathname === "/" && !document.querySelector("#owner-name")'), 'owner enters workspace');
  await waitFor(() => execute('return Boolean(document.querySelector(".app-container"))'), 'working community shell');
  const first = await invoke('host_status');
  assert.equal(first.ready, true); assert.equal(first.setupRequired, false); assert.equal(first.sharing, 'local');
  assert.equal(first.communityName, 'Native smoke community');
  const profile = JSON.parse(await readFile(join(first.dataDirectory, '..', 'host.json'), 'utf8'));
  assert.equal(profile.server_id, first.serverId);
  await screenshot('community');
  // Exercise real window close policy; hidden main webview remains controllable.
  await invoke('plugin:window|close', { label: 'main' });
  assert.equal((await fetch(first.localUrl + '/readyz')).ok, true, 'closing the window keeps community running');
  if (process.env.WABI_EXPECT_PRECACHE === '1') {
    const manifestResponse = await fetch(first.localUrl + '/precache-manifest.json');
    assert.equal(manifestResponse.status, 200, 'bundled Authority serves the PWA precache manifest');
    const manifest = await manifestResponse.json();
    assert.ok(manifest.assets.length > 100, 'bundled Authority has lazy frontend assets');
    const worker = await fetch(first.localUrl + '/sw.js').then(response => response.text());
    assert.ok(worker.includes(`const BUILD_ID = '${manifest.buildId}'`), 'bundled Authority serves the matching worker');
  }
  await invoke('plugin:window|show', { label: 'main' });
  await navigate('/host'); await click('Host a community');
  // Optional second real client on this same machine's private interface. This
  // proves the LAN listener and join route, not another physical device/network.
  const privateAddress = Object.values(networkInterfaces()).flat().find(address => address && !address.internal && address.family === 'IPv4'
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))?.address;
  if (privateAddress) {
		const detected = await invoke('host_lan_addresses');
		assert.ok(detected.length, 'native interface discovery offers private addresses');
		for (const address of detected) {
			assert.equal(new URL(address).port, new URL(first.localUrl).port);
			assert.ok(Object.values(networkInterfaces()).flat().some(item => item?.address === new URL(address).hostname), 'discovered address belongs to a real local interface');
		}
		await click('Create invitation');
    // Select the confirmation inside the shared dialog, not the underlying CTA.
    await waitFor(() => execute('return Boolean(document.querySelector("[role=dialog]"))'), 'LAN confirmation');
    await execute('Array.from(document.querySelectorAll("[role=dialog] button")).find(button=>button.textContent.trim()==="Enable LAN sharing").click()');
    await waitFor(async () => (await invoke('host_status')).sharing === 'lan', 'explicit LAN listener');
		if (detected.length > 1) {
			await waitFor(() => execute('return Boolean(document.getElementById("lan-address"))'), 'detected network choice');
			await execute('const field=document.getElementById("lan-address");field.value=arguments[0];field.dispatchEvent(new Event("change",{bubbles:true}));', [detected[0]]);
			await click('Create invitation');
		}
    await waitFor(() => execute('return Boolean(document.getElementById("invite-result"))'), 'native invitation');
		await waitFor(() => execute('return document.activeElement?.id === "copy-invitation"'), 'invitation copy action brought into view');
    const invitation = await execute('return document.getElementById("invite-result").value');
		assert.ok(detected.includes(new URL(invitation).origin), 'invitation uses the detected address without IP entry');
		await screenshot('simple-invitation');
    const require = createRequire(new URL('../frontend/package.json', import.meta.url));
    const { chromium } = require('playwright');
    peerBrowser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
    const page = await peerBrowser.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(invitation, { waitUntil: 'domcontentloaded' });
    await page.locator('#new-name').fill('native_invited_member');
    await page.locator('#new-password').fill('Disposable-Native-Peer-2026!');
    await page.locator('#repeat-password').fill('Disposable-Native-Peer-2026!');
    await page.getByRole('button', { name: 'Accept invitation & create account' }).click();
    await page.locator('.app-container').waitFor();
    assert.equal(await page.locator('#owner-name').count(), 0, 'Join never creates another Authority');
    await page.screenshot({ path: join(scratch, 'invited-client.png') });
    secondClientJoined = true;
    await peerBrowser.close(); peerBrowser = undefined;
  }
	await click('Open hosting settings');
  await click('Restart'); await click('Continue');
  await waitFor(async () => (await invoke('host_status')).ready, 'native restart');
  assert.equal((await invoke('host_status')).localUrl, first.localUrl);
  await click('Backup'); await click('Continue');
  await waitFor(async () => (await invoke('host_status')).backupIds.length === 1, 'native stopped backup');
  const backedUp = await invoke('host_status');
  assert.equal(backedUp.ready, true);
  await invoke('host_restore', { id: backedUp.backupIds[0], confirm: true });
  const restored = await invoke('host_status');
  assert.equal(restored.serverId, first.serverId); assert.equal(restored.ready, true);
  const account = await invoke('host_account', { ...credentials, register: false });
  assert.ok(account.accessToken, 'owner signs in after native restore');
  await click('Stop'); await click('Continue');
  await waitFor(async () => !(await invoke('host_status')).running, 'native stop');
  await click('Start & open');
  await waitFor(() => execute('return Boolean(document.querySelector(".app-container"))'), 'restarted workspace');
  await waitFor(async () => (await invoke('host_status')).ready, 'native start');
  await invoke('host_quit').catch(() => {}); // Window can close before IPC reply.
  await waitFor(async () => { try { await fetch(first.localUrl + '/readyz', { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }, 'explicit quit drains Authority');
  await request('DELETE', `/session/${session}`).catch(() => {}); session = undefined;
  await startApp();
  const reopened = await invoke('host_status');
  assert.equal(reopened.hasCommunity, true); assert.equal(reopened.running, false);
  assert.equal(reopened.serverId, first.serverId); assert.equal(reopened.localUrl, first.localUrl);
  await click('Start & open');
  await waitFor(() => execute('return Boolean(document.querySelector(".app-container"))'), 'reopened workspace');
  await waitFor(async () => (await invoke('host_status')).ready, 'reopened same community');
  const signedIn = await invoke('host_account', { ...credentials, register: false });
  assert.equal(signedIn.user.id, account.user.id);
  await screenshot('reopened');
  await invoke('host_quit').catch(() => {});
  await writeFile(join(scratch, 'report.json'), JSON.stringify({ passed: true, runtime: 'real Linux Tauri/WebKit + bundled Authority', binary, serverId: first.serverId,
		frontendScope: process.env.WABI_NATIVE_SMOKE_FRONTEND_SCOPE || 'working-tree frontend',
		firstOwnerAndName: true, simpleSetup: true, automaticLanInvitation: secondClientJoined, workspaceRendered: true, closeKeepsHosting: true, stopRestart: true, nativeBackupRestore: true, quitAndReopen: true, secondClientJoined,
    limits: ['Built executable with staged Authority, not installed package', 'No Windows/macOS, physical-device LAN, remote access or calling acceptance'] }, null, 2));
  console.log(`PASS real native host UI, owner, workspace, close, stop/restart, backup/restore, quit/reopen. Second browser joined: ${secondClientJoined}. Evidence: ${scratch}`);
} catch (error) {
  if (session) {
    await screenshot('failure').catch(() => {});
    const state = await execute('return {url:location.href,text:document.body.innerText}').catch(() => null);
    await writeFile(join(scratch, 'failure.json'), JSON.stringify(state, null, 2));
  }
  throw error;
} finally {
  await peerBrowser?.close().catch(() => {});
  if (session) {
    await invoke('host_quit').catch(() => {});
    await request('DELETE', `/session/${session}`).catch(() => {});
  }
  if (driver.exitCode === null) { const exited = once(driver, 'exit'); driver.kill(); await exited; }
  await writeFile(join(scratch, 'native.log'), output);
  console.log(`Native evidence retained: ${scratch}`);
}
