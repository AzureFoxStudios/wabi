#!/usr/bin/env node
// Linux desktop voice smoke: the real Tauri app hosts a community, a Chromium
// client joins it by invitation, and both enter the same voice channel. Passes
// only when each side has decoded and rendered audio from the other that is
// not silence, with no decode failures.
//
// Requires WebKitWebDriver, a display (run it inside `cage` to keep it off the
// desktop), Playwright's Chromium, `dbus-daemon`, and PipeWire with `pactl`,
// `pw-loopback` and `pw-cat`.
//
//   WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- \
//     node scripts/desktop-voice-native-smoke.mjs /absolute/wabi-desktop
//
// The desktop side gets a temporary virtual PipeWire microphone carrying
// bursts of noise, selected through the app's own microphone preference; it is removed
// afterwards and the default devices are not changed. The app runs on a
// private session bus with no secret service: on a real session the keyring
// lookup can wait on a wallet unlock prompt, and it would store throwaway
// tokens in the person's wallet. WABI_SMOKE_VIDEO=1 also turns on Chromium's
// fake camera so the desktop decodes relay video.
//
// WABI_SMOKE_NATIVE_VOICE=1 runs the desktop on the shell's native voice engine
// (WABI_NATIVE_VOICE=1) instead of the webview's audio path, and then checks
// that the engine's microphone closes when the page reloads, or, with
// WABI_SMOKE_HOT_MIC=watchdog, when the page merely stops polling.
//
// WABI_SMOKE_GPU_RENDERER=1 leaves WebKit's default (DMABUF) renderer on; the
// default here is WEBKIT_DISABLE_DMABUF_RENDERER=1, as in the host smoke.
//
// WABI_SMOKE_CHECKPOINT=/path/to/command runs `command <driver pid> <label>`
// after the app has settled at "entry", "workspace", "call", "call-late" (75 s
// further into the call) and "video", for
// memory measurements of the app's process tree.
//
// Limits: WebKit's automation mode grants microphone permission itself, so
// this does not test the shell's permission handler
// (desktop-media-native-smoke.mjs does). Both clients are on one machine. The
// Chromium client loads the frontend embedded in the staged Authority, which
// must be built from the same source to report its counters.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

assert.ok(process.argv[2], 'Usage: node scripts/desktop-voice-native-smoke.mjs /absolute/wabi-desktop');
const binary = resolve(process.argv[2]);
const withVideo = process.env.WABI_SMOKE_VIDEO === '1';
const scratch = await mkdtemp(join(tmpdir(), 'wabi-native-voice-'));
const listener = createServer();
await new Promise(done => listener.listen(0, '127.0.0.1', done));
const port = listener.address().port;
await new Promise(done => listener.close(done));
for (const name of ['data', 'config', 'cache']) await mkdir(join(scratch, name));

const sleep = ms => new Promise(done => setTimeout(done, ms));
const pactl = (...args) => execFileSync('pactl', args, { encoding: 'utf8' }).trim();

// A camera source would make WebKit raise the desktop's camera prompt, and an
// unanswered prompt is stored as a refusal.
const videoSources = JSON.parse(execFileSync('pw-dump', { encoding: 'utf8', maxBuffer: 64 << 20 }))
  .filter(node => node.info?.props?.['media.class'] === 'Video/Source');
assert.equal(videoSources.length, 0, 'A PipeWire camera is present; run this by hand with someone at the desktop prompt');

// 48 kHz mono 16-bit: noise in syllable-length bursts. A steady tone would be
// removed as noise by the native engine's noise suppression.
function burstsWav(seconds) {
  const rate = 48000, samples = rate * seconds, data = Buffer.alloc(samples * 2);
  let state = 0x2545f491, lowPass = 0;
  for (let i = 0; i < samples; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    lowPass += ((state / 0xffffffff) * 2 - 1 - lowPass) * 0.3;
    const phase = (i % (rate * 0.4)) / (rate * 0.4); // 400 ms cycle, 250 ms of sound
    const envelope = phase < 0.625 ? Math.sin(Math.PI * phase / 0.625) : 0;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, lowPass * envelope * 1.2)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const micName = `wabi_smoke_mic_${process.pid}`;
const micLabel = `Wabi-smoke-tone-${process.pid}`;
const defaultSourceBefore = pactl('get-default-source');
const defaultSinkBefore = pactl('get-default-sink');
let loopback;
let outputSink;
const nativeVoice = process.env.WABI_SMOKE_NATIVE_VOICE === '1';
const sinkName = `wabi_smoke_out_${process.pid}`;
let bus;
const peerConsole = [];
let tonePlayer;
let driver;
let output = '';
let session;
let peerBrowser;

async function request(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
const execute = (script, args = []) => request('POST', `/session/${session}/execute/sync`, { script, args });
async function executeAsync(script, args = []) {
  const result = await request('POST', `/session/${session}/execute/async`, { script, args });
  if (result?.error) throw new Error(result.error);
  return result?.value;
}
const invoke = (command, args = {}) => executeAsync(
  'const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));', [command, args]);
async function waitFor(check, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { if (!String(error).includes('no such frame')) throw error; }
    await sleep(200);
  }
  throw new Error(`Timed out: ${description}`);
}
async function click(label) {
  await waitFor(() => execute('return Array.from(document.querySelectorAll("button")).some(button=>button.textContent.trim()===arguments[0]&&!button.disabled)', [label]), `button ${label}`);
  await execute('Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()===arguments[0]&&!button.disabled).click()', [label]);
}

let peerPage;
async function checkpoint(label) {
  if (!process.env.WABI_SMOKE_CHECKPOINT) return;
  await sleep(Number(process.env.WABI_SMOKE_SETTLE_MS || 15000));
  if (peerPage) {
    // The browser client's JavaScript heap after a forced collection, to set
    // beside the desktop's figure: growth in both points at the app's code.
    const cdp = await peerPage.context().newCDPSession(peerPage);
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    await cdp.detach();
    console.log(`chromium-${label}: JS heap ${(usedSize / 1048576).toFixed(1)} MB`);
  }
  execFileSync(process.env.WABI_SMOKE_CHECKPOINT, [String(driver.pid), label], { stdio: 'inherit' });
}

// Whether the native engine holds a microphone stream open, as the audio server sees it.
function engineMicrophoneOpen() {
  // Only streams on this run's virtual microphone: another run or the person's
  // own Wabi may have one open too.
  const source = JSON.parse(pactl('-f', 'json', 'list', 'sources')).find(candidate => candidate.name === micName)?.index;
  return JSON.parse(pactl('-f', 'json', 'list', 'source-outputs'))
    .some(output => output.source === source && output.properties?.['media.name'] === 'Wabi microphone');
}

// Page-side helpers shared by both clients, passed as source text.
const VOICE_ROOMS = `Array.from(document.querySelectorAll('.voice-section [data-channel-id]')).map(row => ({ id: row.dataset.channelId, name: row.querySelector('.channel-btn')?.textContent.trim() ?? '' }))`;
const ROSTER = `Array.from(document.querySelectorAll('.voice-member-item')).map(item => ({ name: item.querySelector('.voice-member-name')?.textContent.trim() ?? '', speaking: item.classList.contains('speaking') }))`;
const JOIN = `document.querySelector('.voice-section [data-channel-id="' + CSS.escape(roomId) + '"] .channel-btn').click()`;

try {
  // pw-loopback's playback side, given a source class, is a microphone other
  // apps can open; the tone is played into its capture side.
  loopback = spawn('pw-loopback', ['--channels', '1',
    '--capture-props', `media.class=Audio/Sink node.name=${micName}_in node.description=${micLabel}-input`,
    '--playback-props', `media.class=Audio/Source node.name=${micName} node.description=${micLabel}`], { stdio: 'ignore' });
  // The desktop app plays into a throwaway sink, not the person's speakers.
  outputSink = spawn('pw-loopback', ['--channels', '1',
    '--capture-props', `media.class=Audio/Sink node.name=${sinkName} node.description=${micLabel}-output`,
    '--playback-props', `media.class=Audio/Source node.name=${sinkName}_tap`], { stdio: 'ignore' });
  await waitFor(() => pactl('list', 'short', 'sources').includes(micName) && pactl('list', 'short', 'sinks').includes(sinkName), 'virtual microphone and output', 10000);
  await writeFile(join(scratch, 'tone.wav'), burstsWav(600));
  tonePlayer = spawn('pw-cat', ['--playback', '--target', `${micName}_in`, join(scratch, 'tone.wav')], { stdio: 'ignore' });

  await writeFile(join(scratch, 'bus.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><keep_umask/><listen>unix:tmpdir=${scratch}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`);
  bus = spawn('dbus-daemon', ['--nofork', '--print-address=1', `--config-file=${join(scratch, 'bus.conf')}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [busAddress] = await once(bus.stdout, 'data');

  driver = spawn(process.env.WABI_WEBKIT_DRIVER || 'WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], {
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: String(busAddress).trim(), XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
      TAURI_WEBVIEW_AUTOMATION: 'true', WABI_SKIP_VIEWER_TEST: '1', PULSE_SINK: sinkName,
      ...(nativeVoice ? { WABI_NATIVE_VOICE: '1', WABI_VOICE_SOURCE: micName, WABI_VOICE_SINK: sinkName } : {}),
      ...(process.env.WABI_SMOKE_GPU_RENDERER === '1' ? {} : { WEBKIT_DISABLE_DMABUF_RENDERER: '1' }) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  driver.stdout.on('data', data => output += data); driver.stderr.on('data', data => output += data);
  await waitFor(async () => { try { return (await request('GET', '/status')).ready; } catch { if (driver.exitCode !== null) throw new Error(output); return false; } }, 'WebKit driver');

  const created = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'webkitgtk:browserOptions': { binary }, timeouts: { implicit: 0, pageLoad: 60000, script: 80000 } } } });
  session = created.sessionId;
  await waitFor(() => execute('return Boolean(window.__TAURI_INTERNALS__)'), 'native bridge');
  await waitFor(() => execute('return document.body.innerText.includes("My communities")'), 'desktop entry');
  await waitFor(() => execute('return !document.getElementById("wabi-boot-shell")'), 'boot overlay dismissed');

  await checkpoint('entry');

  // Host a community (same steps as desktop-host-native-smoke.mjs).
  await click('Host a community');
  await waitFor(() => execute('return Boolean(document.querySelector(".mode-choice"))'), 'setup choice');
  await execute('document.querySelector(".mode-choice").click()');
  await waitFor(() => execute('return Boolean(document.querySelector("#owner-name"))'), 'owner form');
  const owner = { username: 'voice_smoke_owner', password: 'Disposable-Voice-Host-2026!' };
  await execute(`for(const [id,value] of Object.entries(arguments[0])){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}`,
    [{ 'community-name': 'Voice smoke community', 'owner-name': owner.username, 'owner-password': owner.password, 'owner-confirm': owner.password }]);
  await click('Host Server');
  await waitFor(() => execute('return document.body.innerText.includes("Invite a friend")'), 'community ready');

  // Invitation over the machine's private address.
  const privateAddress = Object.values(networkInterfaces()).flat().find(address => address && !address.internal && address.family === 'IPv4'
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))?.address;
  assert.ok(privateAddress, 'This check needs a private IPv4 address for the second client');
  const detected = await invoke('host_lan_addresses');
  await click('Create invitation');
  await waitFor(() => execute('return Boolean(document.querySelector("[role=dialog]"))'), 'LAN confirmation');
  await execute('Array.from(document.querySelectorAll("[role=dialog] button")).find(button=>button.textContent.trim()==="Enable LAN sharing").click()');
  await waitFor(async () => (await invoke('host_status')).sharing === 'lan', 'LAN listener');
  if (detected.length > 1) {
    await waitFor(() => execute('return Boolean(document.getElementById("lan-address"))'), 'network choice');
    await execute('const field=document.getElementById("lan-address");field.value=arguments[0];field.dispatchEvent(new Event("change",{bubbles:true}));', [detected[0]]);
    await click('Create invitation');
  }
  await waitFor(() => execute('return Boolean(document.getElementById("invite-result"))'), 'invitation');
  const invitation = await execute('return document.getElementById("invite-result").value');

  // Point the app at the tone microphone before it enters the workspace.
  const picked = await executeAsync(`const done=arguments[arguments.length-1];(async()=>{
    const stream=await Promise.race([navigator.mediaDevices.getUserMedia({audio:true}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('getUserMedia timed out')),20000))]);
    const devices=await navigator.mediaDevices.enumerateDevices();
    stream.getTracks().forEach(track=>track.stop());
    const inputs=devices.filter(device=>device.kind==='audioinput');
    const tone=inputs.find(device=>device.label.includes(arguments[0]));
    if(tone) localStorage.setItem('wabi_preferred_mic_device_id',tone.deviceId);
    return {found:Boolean(tone),labels:inputs.map(device=>device.label),peerConnection:typeof RTCPeerConnection};
  })().then(value=>done({value}),error=>done({error:String(error)}));`, [micLabel]);
  assert.ok(picked.found, `Tone microphone not offered to the app. Inputs: ${JSON.stringify(picked.labels)}`);

  await click('Open community');
  await waitFor(() => execute('return Boolean(document.querySelector(".app-container"))'), 'owner workspace');

  await checkpoint('workspace');
  // Further samples of the idle workspace, 75 s apart: the baseline for call growth.
  for (let sample = 2; sample <= Number(process.env.WABI_SMOKE_WORKSPACE_SAMPLES || 1); sample++) {
    await sleep(60000);
    await checkpoint(`workspace-${sample}`);
  }

  const require = createRequire(new URL('../frontend/package.json', import.meta.url));
  const { chromium } = require('playwright');
  peerBrowser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH,
    // A plain-HTTP LAN address is not a secure context, so Chromium would hide the microphone API.
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--unsafely-treat-insecure-origin-as-secure=${new URL(invitation).origin}`] });
  const page = await peerBrowser.newPage();
  page.setDefaultTimeout(60000);
  page.on('console', message => peerConsole.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', error => peerConsole.push(`pageerror: ${error.message}`));
  await page.goto(invitation, { waitUntil: 'domcontentloaded' });
  const member = 'voice_smoke_member';
  await page.locator('#new-name').fill(member);
  await page.locator('#new-password').fill('Disposable-Voice-Peer-2026!');
  await page.locator('#repeat-password').fill('Disposable-Voice-Peer-2026!');
  await page.getByRole('button', { name: 'Accept invitation & create account' }).click();
  await page.locator('.app-container').waitFor();
  peerPage = page;

  // Both join the first voice room.
  await waitFor(async () => (await execute(`return ${VOICE_ROOMS}`)).length > 0, 'a voice room in the desktop sidebar');
  const room = (await execute(`return ${VOICE_ROOMS}`))[0];
  await execute(`const roomId=arguments[0]; ${JOIN}`, [room.id]);
  await waitFor(async () => (await execute(`return ${ROSTER}`)).some(person => person.name.startsWith(owner.username)), 'desktop in the voice roster');
  await page.locator(`.voice-section [data-channel-id="${room.id}"] .channel-btn`).click();
  await waitFor(async () => (await execute(`return ${ROSTER}`)).some(person => person.name.startsWith(member)), 'Chromium client in the desktop roster');

  // Each side must decode and render non-silent audio from the other within 30 seconds.
  const DIAGNOSTICS = `(typeof __wabiCallDiagnostics === 'function' ? __wabiCallDiagnostics() : null)`;
  const audio = diagnostics => {
    const total = { sent: 0, received: 0, decoded: 0, decodeFailed: 0, audible: 0, played: 0, context: null, nativeEngine: false };
    for (const relay of diagnostics?.relays ?? []) {
      total.sent += relay.sentEnvelopes ?? 0; total.received += relay.recvEnvelopes ?? 0; total.decoded += relay.decodeOk ?? 0;
      total.decodeFailed += relay.decodeFail ?? 0; total.audible += relay.audibleChunks ?? 0; total.played += relay.playedChunks ?? 0;
      total.context ??= relay.audioContextState ?? null;
      total.nativeEngine ||= relay.nativeEngine === true;
    }
    return total;
  };
  const hears = side => side.audible >= 50 && side.played >= 50;
  let desktopAudio, chromiumAudio;
  const deadline = Date.now() + 30000;
  do {
    await sleep(500);
    desktopAudio = audio(await execute(`return ${DIAGNOSTICS}`));
    chromiumAudio = audio(await page.evaluate(DIAGNOSTICS));
  } while (Date.now() < deadline && !(hears(desktopAudio) && hears(chromiumAudio)));

  console.log(JSON.stringify({ desktopAudio, chromiumAudio }));
  await checkpoint('call');
  if (process.env.WABI_SMOKE_CHECKPOINT) {
    // Later samples of the same call, 75 s apart, to tell a plateau from growth.
    for (let sample = 1; sample <= Number(process.env.WABI_SMOKE_LATE_SAMPLES || 1); sample++) {
      await sleep(60000);
      await checkpoint(sample === 1 ? 'call-late' : `call-late-${sample}`);
    }
  }

  let video = null;
  if (withVideo) {
    // Chromium's fake camera through the relay. The desktop must decode frames and
    // stay alive: the driver sets WEBKIT_DISABLE_DMABUF_RENDERER=1, where WebKitGTK
    // 2.54 aborts on WebCodecs video unless the page made a WebGL context first.
    await execute(`window.__smokeLog = []; for (const level of ['log', 'info', 'warn', 'error']) { const original = console[level].bind(console);
      console[level] = (...parts) => { if (window.__smokeLog.length < 400) window.__smokeLog.push(level + ': ' + parts.map(part => part instanceof Error ? part.name + ' ' + part.message : typeof part === 'object' ? JSON.stringify(part) : String(part)).join(' ').slice(0, 400)); original(...parts); }; }
      window.addEventListener('error', event => window.__smokeLog.push('uncaught: ' + event.message));
      window.addEventListener('unhandledrejection', event => window.__smokeLog.push('rejection: ' + String(event.reason)));`);
    await page.getByRole('button', { name: 'Call options' }).first().click();
    await page.getByText('Turn on camera').first().click({ timeout: 10000 });
    await waitFor(async () => ((await execute(`return ${DIAGNOSTICS}`))?.video?.receiver?.framesDecoded ?? 0) >= 30, 'desktop decoding relay video', 45000);
    video = (await execute(`return ${DIAGNOSTICS}`)).video.receiver;
    await checkpoint('video');
  }

  const state = await execute(`return { roster: ${ROSTER}, peerConnection: typeof RTCPeerConnection, userAgent: navigator.userAgent, video: ${DIAGNOSTICS}?.video ?? null }`);
  await writeFile(join(scratch, 'chromium-console.log'), peerConsole.join('\n'));
  await page.screenshot({ path: join(scratch, 'chromium.png') });
  let hotMic = null;
  if (nativeVoice) {
    // The engine's microphone must close without the page's help.
    assert.ok(engineMicrophoneOpen(), 'the engine microphone is not open during the call');
    if (process.env.WABI_SMOKE_HOT_MIC === 'watchdog') {
      // The page stops polling (as if its script had hung) but stays loaded.
      await execute('for (let id = 1; id < 200000; id++) clearInterval(id);');
      hotMic = 'closed within 10 s of the page going silent';
    } else {
      await request('POST', `/session/${session}/refresh`, {});
      hotMic = 'closed within 10 s of the page reloading';
    }
    await waitFor(() => !engineMicrophoneOpen(), `engine microphone ${hotMic}`, 10000);
  }

  const passed = hears(desktopAudio) && hears(chromiumAudio) && desktopAudio.decodeFailed === 0 && chromiumAudio.decodeFailed === 0;
  const report = { passed, binary, room, desktopAudio, chromiumAudio, video, hotMic, desktop: state,
    limits: ['WebKit automation grants microphone permission itself', 'Both clients on one machine',
      'Desktop microphone is a virtual PipeWire source carrying noise bursts; Chromium sends its fake-device beep',
      'Counters prove non-silent audio was decoded and rendered on the far side, not how it sounds'] };
  await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(desktopAudio.nativeEngine, nativeVoice, nativeVoice ? 'the desktop did not use the native voice engine' : 'the desktop used the native voice engine unasked');
  assert.equal(state.peerConnection, 'undefined', 'expected the desktop webview to have no RTCPeerConnection (relay-only path)');
  assert.ok(hears(desktopAudio), 'desktop did not decode and render non-silent audio from the Chromium client');
  assert.ok(hears(chromiumAudio), 'Chromium did not decode and render non-silent audio from the desktop client');
  assert.equal(desktopAudio.decodeFailed + chromiumAudio.decodeFailed, 0, 'audio decode failures');
  console.log(`PASS voice channel "${room.name}": non-silent audio rendered in both directions${withVideo ? ', relay video decoded on the desktop' : ''}${hotMic ? `; engine microphone ${hotMic}` : ''}. Evidence: ${scratch}`);
} catch (error) {
  if (session) {
    const state = await execute(`return {url:location.href,text:document.body.innerText,rooms:${VOICE_ROOMS},roster:${ROSTER}}`).catch(failure => ({ unreachable: String(failure) }));
    state.diagnostics = await execute(`return (typeof __wabiCallDiagnostics === 'function' ? __wabiCallDiagnostics() : null)`).catch(failure => String(failure));
    await writeFile(join(scratch, 'chromium-console.log'), peerConsole.join('\n'));
    state.desktopConsole = await execute('return window.__smokeLog || null').catch(failure => String(failure));
    state.videoProbe = await executeAsync(`const done=arguments[arguments.length-1];(async()=>{
      const canvas=document.createElement('canvas'); const gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');
      const support=typeof VideoDecoder==='function'?await VideoDecoder.isConfigSupported({codec:'vp8'}).then(r=>r.supported,e=>String(e)):'no VideoDecoder';
      return {webgl:Boolean(gl),vp8Decode:support};})().then(value=>done({value}),error=>done({error:String(error)}));`).catch(failure => String(failure));
    state.host = await invoke('host_status').catch(failure => String(failure));
    state.html = await execute('return document.querySelector("main,body").innerHTML.slice(0, 6000)').catch(() => null);
    await writeFile(join(scratch, 'failure.json'), JSON.stringify(state, null, 2));
  }
  throw error;
} finally {
  await peerBrowser?.close().catch(() => {});
  if (session) {
    await invoke('host_quit').catch(() => {});
    await request('DELETE', `/session/${session}`).catch(() => {});
  }
  if (driver && driver.exitCode === null) { const exited = once(driver, 'exit'); driver.kill(); await exited; }
  tonePlayer?.kill();
  await rm(join(scratch, 'tone.wav'), { force: true }); // ~58 MB
  loopback?.kill();
  outputSink?.kill();
  bus?.kill();
  const defaultSourceAfter = pactl('get-default-source');
  if (defaultSourceAfter !== defaultSourceBefore) console.error(`Default source changed from ${defaultSourceBefore} to ${defaultSourceAfter}`);
  if (pactl('get-default-sink') !== defaultSinkBefore) console.error(`Default sink changed from ${defaultSinkBefore}`);
  await writeFile(join(scratch, 'native.log'), output);
  console.log(`Evidence retained: ${scratch}`);
}
