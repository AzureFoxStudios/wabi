import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBinaryHeader, stageBinary } from '../stage-desktop-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const linux = 'x86_64-unknown-linux-gnu';
const windows = 'x86_64-pc-windows-msvc';
function elf(machine = 62) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ');
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x00004550, 128);
  bytes.writeUInt16LE(machine, 132);
  return bytes;
}

test('accept supported Linux and Windows CPU headers', () => {
  assert.equal(validateBinaryHeader(elf(), linux).format, 'elf');
  assert.equal(validateBinaryHeader(elf(183), 'aarch64-unknown-linux-gnu').format, 'elf');
  assert.equal(validateBinaryHeader(pe(), windows).format, 'pe');
  assert.equal(validateBinaryHeader(pe(0xaa64), 'aarch64-pc-windows-msvc').format, 'pe');
});
test('reject wrong OS, CPU, malformed files and unsupported targets', () => {
  for (const [bytes, target] of [[pe(), linux], [elf(), windows], [elf(183), linux], [pe(0xaa64), windows], [Buffer.alloc(0), linux], [elf(), '../../unexpected']]) {
    assert.throws(() => validateBinaryHeader(bytes, target));
  }
  const invalid = pe();
  invalid.writeUInt32LE(0xffffffff, 60);
  assert.throws(() => validateBinaryHeader(invalid, windows), /PE header/);
});
test('stage without execution and refuse an accidental overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wabi-host-stage-'));
  try {
    const binary = join(directory, 'input');
    await writeFile(binary, elf());
    const destination = await stageBinary({ binary, target: linux, repositoryRoot: directory });
    assert.match(destination, /wabi-server-x86_64-unknown-linux-gnu$/);
    assert.deepEqual(await readFile(destination), elf());
    await assert.rejects(stageBinary({ binary, target: linux, repositoryRoot: directory }), { code: 'EEXIST' });
    assert.deepEqual(await readFile(destination), elf());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('stage Windows sidecar with the required executable suffix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wabi-host-windows-'));
  try {
    const binary = join(directory, 'server.exe');
    await writeFile(binary, pe());
    const destination = await stageBinary({ binary, target: windows, repositoryRoot: directory });
    assert.match(destination, /wabi-server-x86_64-pc-windows-msvc\.exe$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('desktop entrypoint delegates to the declared library', async () => {
  const [main, cargo] = await Promise.all([
    readFile(join(root, 'src-tauri/src/main.rs'), 'utf8'),
    readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8')
  ]);
  const library = cargo.match(/\[lib\]\s*name\s*=\s*"([^"]+)"/)[1];
  assert.ok(main.includes(`${library}::run();`));
  assert.ok(!main.includes('tauri::Builder'));
});
test('shared initialization retains desktop plugins and private access commands', async () => {
  const lib = await readFile(join(root, 'src-tauri/src/lib.rs'), 'utf8');
  for (const command of ['tailcat_register_key', 'tailcat_connect', 'tailcat_disconnect', 'tailcat_status', 'save_call_recording', 'lore_local_choose', 'open_model_viewer', 'open_external_url']) {
    assert.ok(lib.includes(`::${command}`), `missing registration: ${command}`);
  }
  for (const plugin of ['notification', 'shell', 'fs', 'dialog']) {
    assert.equal(lib.split(`tauri_plugin_${plugin}::init()`).length - 1, 1);
  }
  assert.match(lib, /#\[cfg\(not\(mobile\)\)\]\s*desktop::setup\(app\)/);
});
test('Authority and Anchor use the shared bind policy and actual assigned port', async () => {
  const source = await readFile(join(root, 'core/crates/wabi-server/src/main.rs'), 'utf8');
  assert.equal(source.split('listener::bind_configured(&args.host, args.port)').length - 1, 2);
  assert.ok(!source.includes('SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0]'));
  assert.ok(source.includes('port: bound_addr.port(),'));
  assert.equal(source.split('wait_for_shutdown(args.shutdown_on_stdin_close)').length - 1, 2);
  assert.ok(source.includes('"event": "wabi-listener-bound"'));
});
test('hosting overlay retains the existing Tailcat sidecar', async () => {
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.hosting.conf.json'), 'utf8'));
  assert.deepEqual(config.bundle.externalBin, ['binaries/tailcat', 'binaries/wabi-server']);
});
