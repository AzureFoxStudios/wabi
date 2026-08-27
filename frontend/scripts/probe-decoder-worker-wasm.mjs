/**
 * Run: node scripts/probe-decoder-worker-wasm.mjs (from frontend/)
 * Proves the bundled decoder worker loads its wasm via the Module.locateFile
 * prelude (control reproduces the SPA-fallback "magic number" abort).
 */
/**
 * Runtime proof for the decoder-worker wasm fix (no browser in this sandbox).
 * Runs the REAL opus-recorder decoderWorker.min.js in a `node:vm` worker-like
 * sandbox. CONTROL reproduces the production failure (SPA-fallback HTML for
 * the sibling wasm -> magic-number abort). FIX uses the Module.locateFile
 * prelude pointing at a hashed-asset URL backed by the REAL wasm file.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSrc = readFileSync('node_modules/opus-recorder/dist/decoderWorker.min.js', 'utf8');
const wasmBytes = readFileSync('node_modules/opus-recorder/dist/decoderWorker.min.wasm');
const htmlBytes = Buffer.from('<!doctype html><html><body>index</body></html>', 'utf8');

const WASM_URL = 'https://example.test/_app/immutable/a1b2c3/decoderWorker.min.DFIXED12.wasm';
const SIBLING_URL = 'https://example.test/_app/immutable/a1b2c3/decoderWorker.min.wasm';

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(String(e)));

function makeSandbox(mode) {
  const log = [];
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: (...a) => log.push(['err', a.map(String).join(' ')]) },
    WebAssembly,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    URL,
    location: { href: 'https://example.test/_app/immutable/a1b2c3/decoderWorker.min.HASHED.js' },
    importScripts: () => {},
    onmessage: null,
    postMessage: (m) => log.push(['postMessage', m === null ? 'null' : 'decoded-buffers']),
    fetch: async (url) => {
      const u = String(url);
      log.push(['fetch', u]);
      if (mode === 'fix' && u === WASM_URL) {
        return { ok: true, headers: { get: () => 'application/wasm' }, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) };
      }
      if (mode === 'control' && u === SIBLING_URL) {
        return { ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => htmlBytes.buffer.slice(htmlBytes.byteOffset, htmlBytes.byteOffset + htmlBytes.byteLength) };
      }
      throw new Error('unexpected fetch: ' + u);
    },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    performance: { now: () => Date.now() },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, log };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drive(mode) {
  const { sandbox, log } = makeSandbox(mode);
  const prelude = mode === 'fix'
    ? `var Module={locateFile:function(path,prefix){return path.endsWith('.wasm') ? ${JSON.stringify(WASM_URL)} : prefix+path;}};`
    : '';
  vm.createContext(sandbox);
  try {
    vm.runInContext(prelude + '\n' + workerSrc, sandbox);
  } catch (e) {
    log.push(['loadThrew', String(e).slice(0, 120)]);
  }
  // Wait for async wasm instantiation to settle (either exports appear or abort).
  for (let i = 0; i < 120; i++) {
    await sleep(25);
    const M = sandbox.Module;
    // Module.asm is ONLY bound inside receiveInstance() — wasm instantiate
    // succeeded. (The _opus_* stubs exist at load time regardless.)
    if (M?.asm || log.some((l) => l[0] === 'err' && l[1].includes('Aborted'))) break;
  }
  const M = sandbox.Module;
  const wasmLive = Boolean(M?.asm) && typeof M?._opus_decoder_create === 'function';
  const result = { mode, wasmLive, log };
  if (!wasmLive) {
    result.verdict = 'DEAD — ' + (log.some((l) => l[0] === 'err') ? log.find((l) => l[0] === 'err')[1].slice(0, 90) : 'no exports');
    return result;
  }
  // Positive drive: init + decode through the worker's self.onmessage.
  const decodeReplies = [];
  sandbox.postMessage = (m) => decodeReplies.push(m === null ? 'flush' : 'buffers');
  try {
    sandbox.onmessage({ data: { command: 'init', decoderSampleRate: 48000, decoderChannels: 1, outputBufferLength: 4096 } });
    await sleep(200);
    // Valid OggS page header with no segments — exercises page boundary scan,
    // header parse and the decode path without feeding garbage PCM.
    const page = new Uint8Array(27);
    page.set([0x4f, 0x67, 0x67, 0x53, 0, 0]); // "OggS", version 0, header type 0
    page[18] = 1; // page sequence
    page[26] = 0; // segment count 0
    sandbox.onmessage({ data: { command: 'decode', pages: page } });
    await sleep(200);
  } catch (e) {
    result.verdict = 'wasm LIVE but command drive threw: ' + String(e).slice(0, 90);
    return result;
  }
  result.verdict = `ALIVE — wasm exports bound, init accepted, decode consumed without throwing (replies: ${decodeReplies.length})`;
  return result;
}

const control = await drive('control');
const fix = await drive('fix');

console.log('\n=== CONTROL (current prod shape: sibling wasm -> SPA index.html) ===');
console.log('  fetches:', control.log.filter((l) => l[0] === 'fetch').map((l) => l[1]).join(', ') || '(none)');
console.log('  verdict:', control.verdict);

console.log('\n=== FIX (Module.locateFile prelude -> hashed wasm asset) ===');
console.log('  fetches:', fix.log.filter((l) => l[0] === 'fetch').map((l) => l[1]).join(', ') || '(none)');
console.log('  verdict:', fix.verdict);

const ok = fix.wasmLive && !control.wasmLive;
console.log('\nRESULT:', ok ? '✅ control aborts exactly like production; fix instantiates the real wasm' : '❌ unexpected');
process.exit(ok ? 0 : 1);
