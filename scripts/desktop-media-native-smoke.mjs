#!/usr/bin/env node
// Linux desktop media smoke: real Tauri webview, real WebKitGTK, isolated
// OS-profile data. Proves that the shell's permission handler is what lets the
// app's own page capture a microphone: the same debug binary runs once with the
// handler (capture must work, device list must carry labels) and once without
// it (WebKit must refuse).
//
// It uses the debug-only self-test in src-tauri/src/linux_media.rs rather than
// WebDriver, because WebKit's automation mode answers media permission itself
// and never consults the embedder. It only asks for audio, so it cannot raise
// the desktop's camera prompt. Requires a display and one audio input.
//
// Usage: dbus-run-session -- node scripts/desktop-media-native-smoke.mjs /absolute/target/debug/wabi-desktop
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.ok(process.argv[2], 'Usage: dbus-run-session -- node scripts/desktop-media-native-smoke.mjs /absolute/target/debug/wabi-desktop');
const binary = resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), 'wabi-native-media-'));
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function selfTest(name, withHandler) {
  const home = join(scratch, name);
  for (const dir of ['data', 'config', 'cache']) await mkdir(join(home, dir), { recursive: true });
  const reportPath = join(home, 'report.json');
  let output = '';
  const app = spawn(binary, [], {
    env: { ...process.env, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
      WABI_SKIP_VIEWER_TEST: '1', WABI_MEDIA_SELFTEST: reportPath, ...(withHandler ? {} : { WABI_MEDIA_SELFTEST_NO_HANDLER: '1' }) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stdout.on('data', data => output += data); app.stderr.on('data', data => output += data);
  const exited = once(app, 'exit');
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const text = await readFile(reportPath, 'utf8').catch(() => null);
      if (text) return JSON.parse(text);
      if (app.exitCode !== null || app.signalCode !== null) throw new Error(`${name}: app exited before reporting\n${output.slice(-2000)}`);
      await sleep(250);
    }
    throw new Error(`${name}: no self-test report within 90s. Is this a debug build?\n${output.slice(-2000)}`);
  } finally {
    app.kill('SIGTERM');
    await Promise.race([exited, sleep(10000).then(() => app.kill('SIGKILL'))]);
  }
}

try {
  const granted = await selfTest('with-handler', true);
  assert.equal(granted.origin, 'tauri://localhost', 'the smoke must run in the packaged app origin, not a dev server');
  assert.equal(granted.secureContext, true, 'the app origin must be a secure context');
  assert.equal(granted.mediaDevices, 'object', 'navigator.mediaDevices must exist');
  assert.equal(granted.microphoneError, undefined, `microphone capture failed with the handler installed: ${granted.microphoneError}`);
  assert.equal(granted.microphone?.state, 'live', 'microphone track must be live');
  assert.ok(granted.labelledAudioInputs > 0, 'the device list must carry labels after capture');

  // Control: without the handler WebKit refuses, so the pass above is the handler's doing.
  const refused = await selfTest('without-handler', false);
  assert.equal(refused.microphoneError, 'NotAllowedError', 'without the handler WebKit must refuse capture');

  console.log(JSON.stringify({ result: 'PASS', scratch, granted, refused }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', scratch, error: String(error.message || error) }));
  process.exit(1);
}
