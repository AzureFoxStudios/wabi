#!/usr/bin/env node
// Disposable Authority + two Anchor integration check. Default: loopback.
// WABI_THREE_SITE_FIELD_CONFIG enables supervised remote processes; physical
// network and desktop-client acceptance still require separate evidence.
// Remote debug builds need --features field-embed: ordinary rust-embed debug
// binaries read frontend/build from the build machine and serve an empty shell
// when that tree is absent on a remote host.
// WABI_PASSIVE_MOVE_ONLY=1 exercises guarded activation of a caught-up receiver.
import assert from 'node:assert/strict';
import { runRoomLoad, validateOptions } from './geographic-acceptance/room-load.mjs';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { io } = require('socket.io-client');
assert.ok(process.argv[2], 'Supply a freshly built wabi-server binary');
const binary = resolve(process.argv[2]);
const snapshotBinary = process.argv[3] ? resolve(process.argv[3]) : null;
const replicaBinary = process.argv[4] ? resolve(process.argv[4]) : null;
assert.ok(!replicaBinary || snapshotBinary, 'A replica receiver needs the snapshot binary');
assert.ok(process.env.WABI_PASSIVE_MOVE_ONLY !== '1' || replicaBinary,
  'A passive move check needs the replica receiver binary');
const loadOptions = process.env.WABI_THREE_SITE_LOAD_OPTIONS
  ? validateOptions(JSON.parse(process.env.WABI_THREE_SITE_LOAD_OPTIONS)) : null;
let loadEvidence = null;
const fieldConfigPath = process.env.WABI_THREE_SITE_FIELD_CONFIG;
const fieldSites = fieldConfigPath ? JSON.parse(await readFile(fieldConfigPath, 'utf8')).sites : null;
if (fieldSites) {
  for (const role of ['authority', 'materials', 'equipment']) {
    const site = fieldSites[role];
    assert.ok(site && typeof site.bind === 'string', `${role} needs a bind address`);
    if (site.ssh) {
      assert.match(site.ssh, /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/);
      assert.match(site.root, /^\/tmp\/wabi-three-site-field-[A-Za-z0-9_-]+$/);
      assert.equal(site.binary, `${site.root}/wabi-server`);
      if (snapshotBinary && ['authority', 'materials'].includes(role))
        assert.equal(site.snapshotBinary, `${site.root}/wabi-instance-snapshot`);
      if (replicaBinary && role === 'materials') {
        assert.equal(site.replicaBinary, `${site.root}/wabi-db-replica-dev`);
        assert.ok(Number.isInteger(site.replicaPort) && site.replicaPort > 1024 && site.replicaPort < 65536);
      }
    }
  }
}
const execFileAsync = promisify(execFile);
const meterSource = await readFile(new URL('./three-site-tcp-meter.py', import.meta.url), 'utf8');
const remoteClientSource = await readFile(new URL('./three-site-remote-client.cjs', import.meta.url), 'utf8');
const localClientBundle = fileURLToPath(new URL('../frontend/node_modules/socket.io-client/dist/socket.io.js', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'wabi-three-site-'));
const running = new Set();
const remoteInstances = new Set();
const sockets = new Set();
let remoteClientProbes = [];
let materialsMeter;
let equipmentMeter;
let liveReceiver;
let cacheOriginBytes;
let staticOriginBytes;
let replicaEvidence;
let passiveCutoverStartedAt;
let deletedMessageId;
let revokedFileUrl;
let clearedChannelId;
let expiredChannelId;
const pause = ms => new Promise(done => setTimeout(done, ms));
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const bounded = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
};

async function launch(role, authorityOrigin, options = {}) {
  const site = options.site ?? fieldSites?.[role];
  const siteRoot = site?.ssh ? site.root : root;
  const data = options.data ?? join(siteRoot, role === 'authority' ? 'authority-data' : `${role}-unused-data`);
  if (role === 'authority' && !site?.ssh) await mkdir(data, { recursive: true });
  const bootstrapToken = randomBytes(32).toString('hex');
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'USERPROFILE']
      .filter(key => process.env[key])
      .map(key => [key, process.env[key]])
  );
  Object.assign(env, {
    WABI_SERVER_ROLE: role === 'authority' ? 'authority' : 'anchor',
    WABI_LOG_DIR: join(siteRoot, `${role}-logs`),
    WABI_MESH_ENABLED: 'false',
  });
  if (fieldSites) env.WABI_ANCHOR_ALLOW_PRIVATE_HTTP = 'true';
  if (role === 'authority') {
    env.WABI_UPLOADS_DIR = options.uploadsDir ?? join(data, 'uploads');
    env.WABI_DESKTOP_BOOTSTRAP_TOKEN = bootstrapToken;
  } else {
    env.WABI_AUTHORITY_URL = authorityOrigin;
    if (role === 'equipment') env.WABI_ANCHOR_UPLOAD_CACHE_MB = '1';
  }
  Object.assign(env, options.extraEnv ?? {});
  const args = ['--host', options.bind ?? site?.bind ?? '127.0.0.1', '--port', String(options.port ?? site?.port ?? 0), '--data-dir', data,
    '--print-bound-address', '--shutdown-on-stdin-close'];
  if (role === 'authority') args.push('--desktop-managed');
  const child = site?.ssh
    ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', site.ssh,
      `env ${Object.entries(env).filter(([key]) => key.startsWith('WABI_') || key.startsWith('WABIDB_'))
        .map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ')} ${[site.binary, ...args].map(shellQuote).join(' ')}`],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(binary, args, { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-8000); });
  running.add(child);
  const exited = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const announced = new Promise((done, reject) => {
    lines.on('line', line => {
      try {
        const record = JSON.parse(line);
        if (record.event === 'wabi-listener-bound') done(record);
      } catch { /* server logs are not protocol records */ }
    });
    exited.then(result => reject(new Error(`${role} exited before binding: ${JSON.stringify(result)}; ${diagnostic.replaceAll(bootstrapToken, '[REDACTED]')}`)), reject);
  });
  const bound = await bounded(announced, 60_000, `${role} listener`);
  const origin = `http://${bound.address}`;
  const instance = { role, data, origin, bootstrapToken, child, exited, lines,
    site, remotePid: bound.pid };
  if (site?.ssh) {
    assert.ok(Number.isInteger(bound.pid) && bound.pid > 0,
      'remote test server must report its PID for cleanup');
    remoteInstances.add(instance);
  }
  if (!options.skipReady) await waitReady(origin, role);
  return instance;
}

async function waitReady(origin, role) {
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch(`${origin}${role === 'authority' ? '/readyz' : '/health'}`,
        { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* listener or tunnel is still starting */ }
    await pause(100);
  }
  assert.fail(`${role} readiness`);
}

async function unusedLocalPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startAuthorityMeter(site, authorityOrigin) {
  const target = new URL(authorityOrigin);
  assert.equal(target.protocol, 'http:', 'the disposable TCP meter requires private HTTP');
  assert.ok(target.port, 'the Authority must have an explicit test port');
  const meterArgs = [target.hostname, target.port];
  const child = site?.ssh
    ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', site.ssh,
      `python3 -u -c ${shellQuote(meterSource)} ${meterArgs.map(shellQuote).join(' ')}`],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('python3', ['-u', new URL('./three-site-tcp-meter.py', import.meta.url).pathname,
      ...meterArgs], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1000); });
  const waiting = [];
  let announce;
  const announced = new Promise((done, reject) => { announce = { done, reject }; });
  const exited = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  exited.then(result => {
    announce.reject(new Error(`Authority meter exited before binding: ${JSON.stringify(result)} ${diagnostic}`));
    for (const waiter of waiting.splice(0)) waiter.reject(new Error('Authority meter exited'));
  }, announce.reject);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record.event === 'bound') announce.done(record.port);
    if (record.event === 'snapshot') waiting.shift()?.done(record);
  });
  const port = await bounded(announced, 15_000, 'Authority meter bind');
  return {
    origin: `http://127.0.0.1:${port}`,
    snapshot: () => bounded(new Promise((done, reject) => {
      waiting.push({ done, reject });
      child.stdin.write('snapshot\n');
    }), 5_000, 'Authority meter snapshot'),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end('stop\n');
        assert.deepEqual(await bounded(exited, 8_000, 'Authority meter shutdown'),
          { code: 0, signal: null });
      }
      lines.close();
      running.delete(child);
    },
  };
}

async function bootstrapRemoteAuthority(credentials) {
  const site = fieldSites?.authority;
  assert.ok(site?.ssh, 'remote bootstrap requires an SSH site');
  const bootstrap = await launch('authority', undefined, { bind: '127.0.0.1', skipReady: true });
  let tunnel;
  let tunnelExit;
  try {
    const localPort = await unusedLocalPort();
    const remotePort = Number(new URL(bootstrap.origin).port);
    tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ExitOnForwardFailure=yes', '-N', '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, site.ssh],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(tunnel);
    tunnelExit = once(tunnel, 'exit');
    tunnelExit.catch(() => {});
    const loopbackOrigin = `http://127.0.0.1:${localPort}`;
    await waitReady(loopbackOrigin, 'authority');
    await api(loopbackOrigin, '/api/auth/register', { method: 'POST', body: credentials,
      bootstrap: bootstrap.bootstrapToken });
  } finally {
    if (tunnel) {
      tunnel.kill('SIGTERM');
      await bounded(tunnelExit, 5_000, 'bootstrap tunnel shutdown').catch(() => {});
      running.delete(tunnel);
    }
    await stop(bootstrap);
  }
}

async function stop(instance) {
  instance.child.stdin.end();
  const result = await bounded(instance.exited, 12_000, `${instance.role} shutdown`);
  assert.deepEqual(result, { code: 0, signal: null });
  instance.lines.close();
  running.delete(instance.child);
  remoteInstances.delete(instance);
}

async function clearOwnedStoppedLocks(instance) {
  assert.equal(instance.child.exitCode, 0, 'only a cleanly exited disposable process can release its stale lock');
  assert.ok(!running.has(instance.child));
  for (const lock of [join(instance.data, '.lock'), join(instance.data, 'wabidb', '.lock')]) {
    let metadata;
    try { metadata = await lstat(lock); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'lock must be a regular file');
    assert.equal((await readFile(lock, 'utf8')).trim(), String(instance.child.pid),
      'lock must belong to the exited disposable Authority process');
    await rm(lock);
  }
}

async function api(origin, path, { method = 'GET', body, token, bootstrap, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(bootstrap ? { 'x-wabi-bootstrap-token': bootstrap } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `${method} ${path} returned ${response.status}`);
  return response.json();
}

async function remoteClientProbe(site, origin, credentials, channelId, expectedMessageId, assetPath) {
  // Node -e may wrap source while evaluating it; a file hashbang is invalid
  // inside that wrapper. Keep the executable source file usable directly too.
  const source = remoteClientSource.replace(/^#![^\n]*\n/, '');
  const child = site?.ssh
    ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      site.ssh, `node -e ${shellQuote(source)}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['-e', source], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-1000); });
  child.stdin.end(JSON.stringify({ origin, credentials, channelId, expectedMessageId, assetPath,
    clientBundle: site?.ssh ? `${site.root}/socket.io.cjs` : localClientBundle }));
  try {
    const result = await bounded(new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done({ code, signal }));
    }), 45_000, 'remote client probe');
    assert.deepEqual(result, { code: 0, signal: null }, `remote client probe: ${stderr}`);
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    running.delete(child);
  }
}

async function snapshot(...args) {
  assert.ok(snapshotBinary, 'Supply the snapshot binary for a controlled move');
  return execFileAsync(snapshotBinary, args, { cwd: root, timeout: 120_000 });
}

async function remoteCommand(site, command, timeout = 120_000) {
  assert.ok(site?.ssh, 'remote command needs a configured SSH site');
  return execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    site.ssh, command], { cwd: root, timeout, maxBuffer: 1024 * 1024 });
}

async function stopRemoteTestProcess(instance) {
  const { site, remotePid, data } = instance;
  assert.ok(site?.ssh && Number.isInteger(remotePid) && remotePid > 0);
  assert.ok(data.startsWith(`${site.root}/`));
  const source = `
import os, pathlib, signal, sys, time
pid, expected_exe, expected_data = int(sys.argv[1]), sys.argv[2], sys.argv[3]
proc = pathlib.Path('/proc') / str(pid)
def matches():
    try:
        exe = os.readlink(proc / 'exe')
        args = (proc / 'cmdline').read_bytes().split(b'\\0')
    except FileNotFoundError:
        return False
    return exe == expected_exe and any(
        args[i] == b'--data-dir' and args[i + 1] == expected_data.encode()
        for i in range(len(args) - 1))
if matches():
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        time.sleep(0.1)
        if not matches() or (proc / 'stat').read_text().split()[2] == 'Z': break
    else:
        if matches(): os.kill(pid, signal.SIGKILL)
`;
  await remoteCommand(site, ['python3', '-c', source,
    String(remotePid), site.binary, data].map(shellQuote).join(' '), 15_000);
}

async function receiverTokenOn(site, path) {
  if (!site) {
    const token = randomBytes(32).toString('hex');
    await writeFile(path, token, { mode: 0o600 });
    return token;
  }
  const { stdout } = await remoteCommand(site,
    `umask 077; openssl rand -hex 32 > ${shellQuote(path)}; cat ${shellQuote(path)}`);
  const token = stdout.trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  return token;
}

async function launchReceiver(site, passiveRoot) {
  assert.ok(replicaBinary, 'Supply the development receiver binary');
  const siteRoot = site?.root ?? root;
  const tokenPath = join(siteRoot, 'sync-token');
  const token = await receiverTokenOn(site, tokenPath);
  const binaryPath = site?.replicaBinary ?? replicaBinary;
  const args = [binaryPath, '--data-dir', join(passiveRoot, 'data', 'wabidb'),
    '--uploads-dir', join(passiveRoot, 'data', 'uploads'),
    '--instance-dir', join(passiveRoot, 'data'), '--token-file', tokenPath,
    '--listen', `${site?.bind ?? '127.0.0.1'}:${site?.replicaPort ?? await unusedLocalPort()}`,
    '--experimental-replication'];
  if (site?.ssh) args.push('--allow-remote-listen');
  const logPath = join(siteRoot, 'receiver-stderr.log');
  const supervisor = `
import json, subprocess, sys
with open(sys.argv[2], 'wb') as errors:
    child = subprocess.Popen(json.loads(sys.argv[1]), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=errors, text=True, bufsize=1)
    try:
        line = child.stdout.readline()
        if not line: raise RuntimeError('receiver exited before listening')
        print(line.strip(), flush=True)
        sys.stdin.readline()
    finally:
        if child.poll() is None: child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
`;
  const pythonArgs = ['python3', '-u', '-c', supervisor, JSON.stringify(args), logPath];
  const child = site?.ssh
    ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', site.ssh,
      pythonArgs.map(shellQuote).join(' ')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(pythonArgs[0], pythonArgs.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  const exited = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  exited.catch(() => {});
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2000); });
  const lines = createInterface({ input: child.stdout });
  const announced = new Promise((done, reject) => {
    lines.once('line', done);
    exited.then(result => reject(new Error(`receiver exited before binding: ${JSON.stringify(result)} ${diagnostic}`)), reject);
  });
  const banner = await bounded(announced, 30_000, 'receiver listener');
  const address = banner.match(/^Fenced WabiDB development receiver listening on (.+)$/)?.[1];
  assert.ok(address, `unexpected receiver banner: ${banner}`);
  const origin = `http://${address}`;
  const live = await fetch(`${origin}/livez`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(live.status, 200, 'receiver livez');
  return { child, exited, lines, origin, token };
}

async function stopReceiver(receiver) {
  if (!receiver) return;
  if (receiver.child.exitCode === null && receiver.child.signalCode === null)
    receiver.child.stdin.end();
  const result = await bounded(receiver.exited, 15_000, 'receiver shutdown');
  assert.deepEqual(result, { code: 0, signal: null });
  receiver.lines.close();
  running.delete(receiver.child);
  if (liveReceiver === receiver) liveReceiver = undefined;
}

async function receiverStatus(receiver) {
  const response = await fetch(`${receiver.origin}/api/v1/sync/status`, {
    headers: { 'x-wabi-sync-token': receiver.token },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, 'receiver status');
  return response.json();
}

async function waitReceiver(receiver, predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await receiverStatus(receiver);
    if (predicate(status)) return status;
    await pause(200);
  }
  throw new Error(`receiver did not reach ${label}`);
}

async function snapshotOn(site, ...args) {
  if (!site) return snapshot(...args);
  assert.ok(snapshotBinary && site.snapshotBinary, 'both snapshot binaries are required');
  return remoteCommand(site, [site.snapshotBinary, ...args].map(shellQuote).join(' '));
}

async function transferBetweenSites(sourceSite, sourcePath, destinationSite, destinationPath) {
  const transit = join(root, `encrypted-transfer-${randomUUID()}`);
  const options = ['-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  assert.ok(sourceSite?.ssh || sourcePath.startsWith(`${root}/`),
    'local transfer source stays inside the disposable root');
  assert.ok(destinationSite?.ssh || destinationPath.startsWith(`${root}/`),
    'local transfer destination stays inside the disposable root');
  if (!sourceSite?.ssh && !destinationSite?.ssh) {
    if (sourcePath !== destinationPath) await copyFile(sourcePath, destinationPath);
    return;
  }
  if (!sourceSite?.ssh || !destinationSite?.ssh) {
    const source = sourceSite?.ssh ? `${sourceSite.ssh}:${sourcePath}` : sourcePath;
    const destination = destinationSite?.ssh ? `${destinationSite.ssh}:${destinationPath}` : destinationPath;
    await execFileAsync('scp', [...options, source, destination],
      { cwd: root, timeout: 120_000 });
    return;
  }
  try {
    await execFileAsync('scp', [...options, `${sourceSite.ssh}:${sourcePath}`, transit],
      { cwd: root, timeout: 120_000 });
    await execFileAsync('scp', [...options, transit, `${destinationSite.ssh}:${destinationPath}`],
      { cwd: root, timeout: 120_000 });
  } finally { await rm(transit, { force: true }); }
}

async function clearStoppedLocksOn(site, instance) {
  if (!site) return clearOwnedStoppedLocks(instance);
  assert.equal(instance.child.exitCode, 0, 'only a cleanly exited disposable process can release its stale lock');
  assert.ok(!running.has(instance.child));
  assert.ok(instance.data.startsWith(`${site.root}/`), 'lock cleanup stays within the disposable site root');
  const locks = [join(instance.data, '.lock'), join(instance.data, 'wabidb', '.lock')];
  const command = `for lock in ${locks.map(shellQuote).join(' ')}; do
    if test -e "$lock"; then
      test -f "$lock" && test ! -L "$lock" || exit 2
      pid=$(cat "$lock")
      case "$pid" in ''|*[!0-9]*) exit 3;; esac
      if ps -p "$pid" -o pid= | grep -q '[0-9]'; then exit 4; fi
      rm -- "$lock"
    fi
  done`;
  await remoteCommand(site, command, 15_000);
}

async function publishRoster(origin, token, password, expectedVersion, entries) {
  const proof = await api(origin, '/api/auth/stepup', {
    method: 'POST', body: { password }, token,
  });
  assert.ok(proof.stepupToken, 'owner step-up proof');
  return api(origin, '/api/community/roster', {
    method: 'PUT', body: { expectedVersion, entries }, token,
    headers: { 'x-stepup-token': proof.stepupToken },
  });
}

async function assertAuthorityRefuses(data, uploadsDir, reason) {
  let refused = false;
  try {
    await execFileAsync(binary,
      ['--host', '127.0.0.1', '--port', '0', '--data-dir', data], {
        cwd: root, timeout: 10_000,
        env: { PATH: process.env.PATH ?? '', WABI_SERVER_ROLE: 'authority',
          WABI_UPLOADS_DIR: uploadsDir, WABI_LOG_DIR: join(root, 'rejected-boot-logs'),
          WABI_MESH_ENABLED: 'false' },
      });
  } catch (error) {
    assert.match(String(error.stderr ?? ''), reason,
      'process must refuse the expected durable guard');
    refused = true;
  }
  assert.ok(refused, 'guarded Authority must not start');
}

async function assertAuthorityRefusesOn(site, data, uploadsDir, reason) {
  if (!site) return assertAuthorityRefuses(data, uploadsDir, reason);
  assert.ok(data.startsWith(`${site.root}/`), 'refused startup checks only the disposable tree');
  let refused = false;
  try {
    const env = ['WABI_SERVER_ROLE=authority', 'WABI_MESH_ENABLED=false',
      `WABI_UPLOADS_DIR=${uploadsDir}`, `WABI_LOG_DIR=${site.root}/rejected-boot-logs`];
    const args = [site.binary, '--host', '127.0.0.1', '--port', '0', '--data-dir', data];
    await remoteCommand(site, `env ${env.map(shellQuote).join(' ')} ${args.map(shellQuote).join(' ')}`, 10_000);
  } catch (error) {
    assert.match(String(error.stderr ?? ''), reason,
      'remote process must refuse the expected durable guard');
    refused = true;
  }
  assert.ok(refused, 'guarded remote Authority must not start');
}

async function stoppedDataManifestOn(site, data) {
  const source = `
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
files = {}
for path in sorted(root.rglob('*')):
    if path.is_symlink(): raise AssertionError('symlink in disposable recovery tree')
    if path.is_file() and path.name not in ('.lock', 'writer-fenced-v1'):
        files[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
print(json.dumps(files, sort_keys=True))
`;
  const args = ['python3', '-c', source, data];
  const { stdout } = site
    ? await remoteCommand(site, args.map(shellQuote).join(' '))
    : await execFileAsync('python3', ['-c', source, data], { cwd: root, timeout: 30_000 });
  return JSON.parse(stdout);
}

async function stoppedDirectoryListOn(site, data) {
  const source = `
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
directories = []
for path in root.rglob('*'):
    if path.is_symlink(): raise AssertionError('symlink in disposable recovery tree')
    if path.is_dir(): directories.append(path.relative_to(root).as_posix())
print(json.dumps(sorted(directories)))
`;
  const args = ['python3', '-c', source, data];
  const { stdout } = site
    ? await remoteCommand(site, args.map(shellQuote).join(' '))
    : await execFileAsync('python3', ['-c', source, data], { cwd: root, timeout: 30_000 });
  return JSON.parse(stdout);
}

async function fileDigestOn(site, path) {
  if (!site) return createHash('sha256').update(await readFile(path)).digest('hex');
  const { stdout } = await remoteCommand(site, `sha256sum -- ${shellQuote(path)}`);
  const digest = stdout.split(/\s+/)[0];
  assert.match(digest, /^[a-f0-9]{64}$/);
  return digest;
}

async function projectionSnapshotOn(site, data) {
  const source = `
import hashlib, json, pathlib, sys
path = pathlib.Path(sys.argv[1]) / 'wabidb/projections/snapshot.json'
record = json.loads(path.read_text())
canonical = []
for name, entries in record['indexes']:
    canonical.append([name, sorted(entries, key=lambda entry:
        json.dumps(entry, sort_keys=True, separators=(',', ':')))])
record['indexes'] = sorted(canonical, key=lambda item: item[0])
payload = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
print(json.dumps({'sha256': hashlib.sha256(payload).hexdigest(),
    'watermark': record['watermark'], 'indexes': len(canonical),
    'entries': sum(len(item[1]) for item in canonical)}))
`;
  const args = ['python3', '-c', source, data];
  const { stdout } = site
    ? await remoteCommand(site, args.map(shellQuote).join(' '))
    : await execFileAsync('python3', ['-c', source, data], { cwd: root, timeout: 30_000 });
  return JSON.parse(stdout);
}

async function poll(origin) {
  const response = await fetch(`${origin}/socket.io/?EIO=4&transport=polling&t=${randomUUID()}`,
    { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  assert.equal(response.status, 200, 'Engine.IO polling');
  assert.match(await response.text(), /^0\{/);
}

async function connect(origin, token, label) {
  const socket = io(origin, { auth: { token }, transports: ['websocket'],
    reconnection: false, timeout: 10_000 });
  sockets.add(socket);
  await bounded(new Promise((done, reject) => {
    socket.once('connect', done);
    socket.once('connect_error', reject);
  }), 12_000, `${label} WebSocket`);
  return socket;
}

async function joinChannel(socket, channelId, label) {
  const result = bounded(new Promise((done, reject) => {
    socket.once('channel-messages', done);
    socket.once('join-error', reject);
  }), 10_000, `${label} channel join`);
  socket.emit('join-channel', channelId);
  assert.equal((await result).channelId, channelId);
}

try {
  const ownerCredentials = { username: 'site_owner', password: 'Disposable-Three-Site-Only!',
    communityName: 'Three-site process preflight' };
  if (fieldSites?.authority.ssh) await bootstrapRemoteAuthority(ownerCredentials);
  const authority = await launch('authority');
  materialsMeter = await startAuthorityMeter(fieldSites?.materials, authority.origin);
  const materials = await launch('materials', materialsMeter.origin);
  equipmentMeter = await startAuthorityMeter(fieldSites?.equipment, authority.origin);
  const equipment = await launch('equipment', equipmentMeter.origin);
  const shellResponse = await fetch(authority.origin, { signal: AbortSignal.timeout(10_000) });
  assert.equal(shellResponse.status, 200, 'Authority app shell');
  const shellHtml = await shellResponse.text();
  const assetPaths = [...new Set(shellHtml
    .match(/\/_app\/immutable\/[A-Za-z0-9/_.-]+\.js/g) ?? [])];
  const assetPath = assetPaths.find(path => path.includes('/chunks/')) ?? assetPaths[0];
  assert.ok(assetPath, `Authority shell references a versioned app asset; received ${shellResponse.headers.get('content-type')}, ${shellHtml.length} characters, prefix ${JSON.stringify(shellHtml.slice(0, 160))}`);
  const sourceAssetResponse = await fetch(authority.origin + assetPath,
    { signal: AbortSignal.timeout(10_000) });
  assert.equal(sourceAssetResponse.status, 200, 'Authority versioned asset');
  const sourceAsset = Buffer.from(await sourceAssetResponse.arrayBuffer());
  assert.ok(sourceAsset.length > 0);
  const staticBefore = await Promise.all([materialsMeter.snapshot(), equipmentMeter.snapshot()]);
  for (const site of [materials, equipment]) {
    const response = await fetch(site.origin + assetPath,
      { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `${site.role} versioned asset`);
    assert.equal(response.headers.get('x-wabi-anchor-static'), 'local',
      `${site.role} serves its embedded copy`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sourceAsset);
  }
  const staticAfter = await Promise.all([materialsMeter.snapshot(), equipmentMeter.snapshot()]);
  staticOriginBytes = Object.fromEntries(['materials', 'equipment'].map((site, index) =>
    [site, staticAfter[index].fromAuthority - staticBefore[index].fromAuthority]));
  assert.deepEqual(staticOriginBytes, { materials: 0, equipment: 0 },
    'matching embedded app assets must make no Authority requests');
  const owner = fieldSites?.authority.ssh
    ? await api(materials.origin, '/api/auth/login', { method: 'POST', body: ownerCredentials })
    : await api(materials.origin, '/api/auth/register', {
      method: 'POST', body: ownerCredentials, bootstrap: authority.bootstrapToken,
    });
  const invite = await api(materials.origin, '/api/invites', {
    method: 'POST', body: { expiresInHours: 1 }, token: owner.accessToken,
  });
  const member = await api(equipment.origin, '/api/auth/register', {
    method: 'POST', body: { username: 'site_member', password: ownerCredentials.password,
      inviteToken: invite.token },
  });
  assert.ok(owner.accessToken && member.accessToken, 'both sites authenticated');
  const initialRoster = await publishRoster(materials.origin, owner.accessToken,
    ownerCredentials.password, 0, [
      { nodeId: 'roofing', role: 'authority', url: authority.origin },
      { nodeId: 'materials', role: 'anchor', url: materials.origin },
      { nodeId: 'equipment', role: 'anchor', url: equipment.origin },
    ]);
  assert.equal(initialRoster.body.version, 1);
  assert.equal((await api(equipment.origin, '/api/community/roster',
    { token: member.accessToken })).body.communityId, initialRoster.body.communityId);
  const channel = await api(materials.origin, '/api/channels', {
    method: 'POST', body: { name: 'site-preflight', channel_type: 'text' },
    token: owner.accessToken,
  });
  const channelId = channel.id ?? channel.channel?.id;
  assert.ok(channelId, 'shared channel identity');
  await api(equipment.origin, `/api/channels/${channelId}/join`, {
    method: 'POST', body: {}, token: member.accessToken,
  });
  await api(materials.origin, `/api/channels/${channelId}/retention`, {
    method: 'PUT', body: { retention: 'forever' }, token: owner.accessToken,
  });

  await Promise.all([poll(materials.origin), poll(equipment.origin)]);
  const ownerSocket = await connect(materials.origin, owner.accessToken, 'materials');
  const memberSocket = await connect(equipment.origin, member.accessToken, 'equipment');
  await joinChannel(ownerSocket, channelId, 'materials');
  await joinChannel(memberSocket, channelId, 'equipment');
  const clientMessageId = randomUUID();
  const received = bounded(new Promise(done => memberSocket.on('message', payload => {
    if (payload?.message?.clientMessageId === clientMessageId) done(payload);
  })), 10_000, 'cross-Anchor live message');
  const accepted = bounded(new Promise(done => ownerSocket.on('message-accepted', payload => {
    if (payload?.clientMessageId === clientMessageId) done(payload);
  })), 10_000, 'canonical message acceptance');
  ownerSocket.emit('message', { channelId, text: 'Disposable regional canary',
    type: 'text', clientMessageId });
  const [ack, delivery] = await Promise.all([accepted, received]);
  assert.equal(delivery.message.id, ack.messageId);
  const reverseClientMessageId = randomUUID();
  const reverseReceived = bounded(new Promise(done => ownerSocket.on('message', payload => {
    if (payload?.message?.clientMessageId === reverseClientMessageId) done(payload);
  })), 10_000, 'reverse cross-Anchor live message');
  const reverseAccepted = bounded(new Promise(done => memberSocket.on('message-accepted', payload => {
    if (payload?.clientMessageId === reverseClientMessageId) done(payload);
  })), 10_000, 'reverse canonical message acceptance');
  memberSocket.emit('message', { channelId, text: 'Disposable reverse canary',
    type: 'text', clientMessageId: reverseClientMessageId });
  const [reverseAck, reverseDelivery] = await Promise.all([reverseAccepted, reverseReceived]);
  assert.equal(reverseDelivery.message.id, reverseAck.messageId);
  const history = await api(equipment.origin, `/api/messages/${channelId}`, {
    token: member.accessToken,
  });
  assert.ok(history.messages.some(item => item.id === ack.messageId), 'shared durable history');
  assert.ok(history.messages.some(item => item.id === reverseAck.messageId), 'reverse durable history');
  if (loadOptions) {
    loadEvidence = await runRoomLoad({
      sites: [authority.origin, materials.origin, equipment.origin],
      tokens: [owner.accessToken, member.accessToken], channelId, options: loadOptions,
    });
    assert.equal(loadEvidence.result, 'PASS', `Bounded room workload failed: ${JSON.stringify(loadEvidence)}`);
  }

  {
    const remoteChecks = [
      ['materials', fieldSites?.materials, materials.origin, { username: 'site_member',
        password: ownerCredentials.password }],
      ['authority', fieldSites?.authority, authority.origin, ownerCredentials],
    ];
    remoteClientProbes = await Promise.all(remoteChecks.map(async ([role, site, origin, credentials]) => {
      const result = await remoteClientProbe(site, origin, credentials, channelId,
        ack.messageId, assetPath);
      assert.equal(result.assetSha256, createHash('sha256').update(sourceAsset).digest('hex'));
      assert.equal(result.assetBytes, sourceAsset.length);
      return { role, clientLocation: site?.ssh ? 'remote-host' : 'harness-host',
        elapsedMs: result.elapsedMs, assetBytes: result.assetBytes,
        messageId: result.messageId, websocketMessageId: result.websocketMessageId,
        websocketAuthenticated: result.websocketAuthenticated,
        websocketHistoryMatched: result.websocketHistoryMatched,
        websocketAcceptanceMatchedDelivery: result.websocketAcceptanceMatchedDelivery };
    }));
    const remoteHistory = await api(equipment.origin, `/api/messages/${channelId}`,
      { token: member.accessToken });
    for (const probe of remoteClientProbes) {
      assert.ok(remoteHistory.messages.some(item => item.id === probe.messageId),
        `${probe.role} remote-origin write visible across sites`);
      assert.equal(probe.websocketAuthenticated, true);
      assert.equal(probe.websocketHistoryMatched, true);
      assert.equal(probe.websocketAcceptanceMatchedDelivery, true);
      assert.ok(remoteHistory.messages.some(item => item.id === probe.websocketMessageId),
        `${probe.role} remote-origin WebSocket write visible across sites`);
    }
  }

  const bytes = Buffer.alloc(256 * 1024, 'R');
  const upload = await api(materials.origin, '/api/upload/resumable/init', {
    method: 'POST', body: { fileName: 'site-canary.txt', fileSize: bytes.length,
      mimeType: 'text/plain', channelId }, token: owner.accessToken,
  });
  const chunk = await fetch(`${materials.origin}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(upload.uploadId)}&offset=0`, {
    method: 'PUT', headers: { authorization: `Bearer ${owner.accessToken}`,
      'x-upload-token': upload.uploadToken, 'content-type': 'application/octet-stream' },
    body: bytes, signal: AbortSignal.timeout(10_000),
  });
  assert.ok(chunk.ok, `streamed upload chunk ${chunk.status}`);
  const file = await api(materials.origin, '/api/upload/resumable/complete', {
    method: 'POST', body: { uploadId: upload.uploadId, uploadToken: upload.uploadToken },
    token: owner.accessToken,
  });
  const cacheTraffic = [];
  for (const expectedCache of ['miss', 'hit']) {
    const before = await equipmentMeter.snapshot();
    const response = await fetch(equipment.origin + file.fileUrl, {
      headers: { authorization: `Bearer ${member.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, 'cross-Anchor file download');
    assert.equal(response.headers.get('x-wabi-anchor-cache'), expectedCache);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),
      createHash('sha256').update(bytes).digest('hex'));
    const after = await equipmentMeter.snapshot();
    cacheTraffic.push({ disposition: expectedCache,
      originToAnchorBytes: after.fromAuthority - before.fromAuthority,
      anchorToOriginBytes: after.toAuthority - before.toAuthority });
  }
  assert.ok(cacheTraffic[0].originToAnchorBytes >= bytes.length,
    'the cache miss transfers the full file from the Authority');
  assert.ok(cacheTraffic[1].originToAnchorBytes < bytes.length,
    'the cache hit must avoid transferring the file from the Authority');
  cacheOriginBytes = { fileBytes: bytes.length, samples: cacheTraffic };

  ownerSocket.close(); sockets.delete(ownerSocket);
  await stop(materials);
  assert.ok((await api(equipment.origin, `/api/messages/${channelId}`,
    { token: member.accessToken })).messages.some(item => item.id === ack.messageId));
  const fallback = await api(equipment.origin, '/api/messages', {
    method: 'POST', body: { channel_id: channelId, content: 'Surviving Anchor canary',
      message_type: 'text' }, token: owner.accessToken,
  });
  assert.ok((await api(equipment.origin, `/api/messages/${channelId}`,
    { token: member.accessToken })).messages.some(item => item.id === fallback.id));
  memberSocket.close(); sockets.delete(memberSocket);
  await stop(authority);
  const unavailable = await fetch(`${equipment.origin}/api/messages/${channelId}`,
    { headers: { authorization: `Bearer ${member.accessToken}` },
      signal: AbortSignal.timeout(10_000) });
  assert.equal(unavailable.status, 503, 'Anchor must not pretend to be an Authority');
  const unavailableFile = await fetch(equipment.origin + file.fileUrl,
    { signal: AbortSignal.timeout(10_000) });
  assert.equal(unavailableFile.status, 503, 'cached bytes need Authority revalidation');
  const localStatic = await fetch(equipment.origin + assetPath,
    { signal: AbortSignal.timeout(10_000) });
  assert.equal(localStatic.status, 200, 'public embedded asset stays local');
  assert.equal(localStatic.headers.get('x-wabi-anchor-static'), 'local');
  assert.deepEqual(Buffer.from(await localStatic.arrayBuffer()), sourceAsset);
  const rememberedEquipmentUrl = equipment.origin;
  const equipmentPort = Number(new URL(rememberedEquipmentUrl).port);
  await stop(equipment);
  const checks = ['two-site auth', 'signed three-entry roster', 'shared message history',
    'Engine.IO polling', 'two WebSocket sessions',
    'bidirectional cross-Anchor live messages',
    'site-origin HTTP and authenticated WebSocket writes visible across sites',
    'byte-identical local versioned assets on both Anchors', 'upload cache miss/hit',
    'single Anchor loss with surviving write',
    'Authority loss returns 503 for API and cached file while a public app asset stays local'];
  if (snapshotBinary) {
    const oldSite = fieldSites?.authority?.ssh ? fieldSites.authority : undefined;
    const replacementSite = fieldSites?.materials?.ssh ? fieldSites.materials : undefined;
    const oldRoot = oldSite?.root ?? root;
    const replacementRoot = replacementSite?.root ?? root;
    await clearStoppedLocksOn(oldSite, authority);
    if (replicaBinary) {
      const passiveIdentity = join(replacementRoot, 'live-passive.agekey');
      const { stdout: passiveKeygen } = await snapshotOn(replacementSite,
        'keygen', '--identity-file', passiveIdentity);
      const passiveRecipient = passiveKeygen.match(/^Recipient: (age\S+)$/m)?.[1];
      assert.ok(passiveRecipient, 'live receiver baseline recipient');
      const baselineSource = join(oldRoot, 'live-baseline.age');
      await snapshotOn(oldSite, 'export', '--data-dir', authority.data,
        '--uploads-dir', join(authority.data, 'uploads'),
        '--recipient', passiveRecipient, '--output', baselineSource);
      const baselineArchive = join(replacementRoot, 'live-baseline.age');
      if (fieldSites) await transferBetweenSites(oldSite, baselineSource,
        replacementSite, baselineArchive);
      const passiveRoot = join(replacementRoot, 'live-passive');
      await snapshotOn(replacementSite, 'restore', '--input', baselineArchive,
        '--identity-file', passiveIdentity, '--target-root', passiveRoot,
        '--passive-replica');
      liveReceiver = await launchReceiver(replacementSite, passiveRoot);
      const baselineStatus = await receiverStatus(liveReceiver);
      assert.equal(baselineStatus.writerFenced, true);
      assert.equal(baselineStatus.fullInstanceReady, false);
      assert.equal(baselineStatus.uploadCopyEnabled, true);
      assert.equal(baselineStatus.sidecarCopyEnabled, true);
      assert.equal(baselineStatus.appliedCommitSeq, baselineStatus.indexedCommitSeq);
      const catchupAuthority = await launch('authority', undefined, {
        site: oldSite, data: authority.data,
        uploadsDir: join(authority.data, 'uploads'),
        extraEnv: {
          WABIDB_EXPERIMENTAL_REPLICATION: 'true',
          WABIDB_PEER_ENDPOINT: liveReceiver.origin,
          WABIDB_ALLOW_PRIVATE_HTTP: 'true',
          WABIDB_SYNC_INTERVAL_MS: '200',
          WABIDB_REPLICATE_SIDECARS: 'true',
          WABI_SYNC_TOKEN: liveReceiver.token,
        },
      });
      const laterMessage = await api(catchupAuthority.origin, '/api/messages', {
        method: 'POST', body: { channel_id: channelId,
          content: 'Live fenced receiver canary', message_type: 'text' },
        token: owner.accessToken,
      });
      assert.ok(laterMessage.id, 'live-replicated write accepted');
      const laterBytes = Buffer.alloc(4096, 'L');
      const laterUpload = await api(catchupAuthority.origin, '/api/upload/resumable/init', {
        method: 'POST', body: { fileName: 'live-replica-canary.txt',
          fileSize: laterBytes.length, mimeType: 'text/plain', channelId },
        token: owner.accessToken,
      });
      const laterChunk = await fetch(`${catchupAuthority.origin}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(laterUpload.uploadId)}&offset=0`, {
        method: 'PUT', headers: { authorization: `Bearer ${owner.accessToken}`,
          'x-upload-token': laterUpload.uploadToken,
          'content-type': 'application/octet-stream' },
        body: laterBytes, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(laterChunk.status, 200, 'post-baseline upload chunk');
      const laterFile = await api(catchupAuthority.origin, '/api/upload/resumable/complete', {
        method: 'POST', body: { uploadId: laterUpload.uploadId,
          uploadToken: laterUpload.uploadToken }, token: owner.accessToken,
      });
      const filename = decodeURIComponent(new URL(laterFile.fileUrl,
        catchupAuthority.origin).pathname.split('/').at(-1));
      assert.match(filename, /^[A-Za-z0-9._-]+$/);
      const passiveFile = join(passiveRoot, 'data', 'uploads', filename);
      const expectedDigest = createHash('sha256').update(laterBytes).digest('hex');
      const catchupStatus = await waitReceiver(liveReceiver,
        status => status.appliedCommitSeq > baselineStatus.appliedCommitSeq
          && status.indexedCommitSeq === status.appliedCommitSeq,
        'post-baseline database catch-up');
      let passiveDigest;
      for (let attempt = 0; attempt < 100; attempt++) {
        passiveDigest = await fileDigestOn(replacementSite, passiveFile).catch(() => undefined);
        if (passiveDigest === expectedDigest) break;
        await pause(200);
      }
      assert.equal(passiveDigest, expectedDigest,
        'newly published upload bytes reach the fenced remote receiver');
      assert.equal(catchupStatus.writerFenced, true);
      assert.equal(catchupStatus.fullInstanceReady, false);
      const deletedMessage = await api(catchupAuthority.origin, '/api/messages', {
        method: 'POST', body: { channel_id: channelId,
          content: 'Delete before passive move', message_type: 'text' },
        token: owner.accessToken,
      });
      deletedMessageId = deletedMessage.id;
      assert.ok(deletedMessageId);
      const deleteSocket = await connect(catchupAuthority.origin, owner.accessToken,
        'deletion canary');
      await joinChannel(deleteSocket, channelId, 'deletion canary');
      const deletionAcknowledged = bounded(new Promise((resolve, reject) => {
        deleteSocket.on('message-deleted', payload => {
          if (payload?.messageId === deletedMessageId) resolve(payload);
        });
        deleteSocket.on('delete-error', payload => {
          if (payload?.messageId === deletedMessageId) reject(new Error(payload.error));
        });
      }), 10_000, 'durable message deletion');
      deleteSocket.emit('delete-message', { channelId, messageId: deletedMessageId });
      await deletionAcknowledged;
      deleteSocket.close();
      assert.ok(!(await api(catchupAuthority.origin, `/api/messages/${channelId}`,
        { token: owner.accessToken })).messages.some(item => item.id === deletedMessageId),
      'deleted message is absent before replication cutover');
      revokedFileUrl = laterFile.fileUrl;
      const deletion = await api(catchupAuthority.origin,
        `/api/server-center/storage/${encodeURIComponent(filename)}`, {
          method: 'DELETE', token: owner.accessToken,
        });
      assert.equal(deletion.removedFromDisk, true,
        'owner removed the copied upload after durable revocation');
      assert.equal((await fetch(catchupAuthority.origin + revokedFileUrl,
        { signal: AbortSignal.timeout(10_000) })).status, 410,
      'revoked upload is denied on the source');
      const clearChannel = await api(catchupAuthority.origin, '/api/channels', {
        method: 'POST', body: { name: 'bulk-clear-canary', channel_type: 'text' },
        token: owner.accessToken,
      });
      clearedChannelId = clearChannel.id ?? clearChannel.channel?.id;
      assert.ok(clearedChannelId, 'bulk-clear channel identity');
      await api(catchupAuthority.origin, `/api/channels/${clearedChannelId}/retention`, {
        method: 'PUT', body: { retention: 'forever' }, token: owner.accessToken,
      });
      const clearedMessage = await api(catchupAuthority.origin, '/api/messages', {
        method: 'POST', body: { channel_id: clearedChannelId,
          content: 'Bulk clear before passive move', message_type: 'text' },
        token: owner.accessToken,
      });
      const clearSocket = await connect(catchupAuthority.origin, owner.accessToken,
        'bulk-clear canary');
      await joinChannel(clearSocket, clearedChannelId, 'bulk-clear canary');
      const clearAcknowledged = bounded(new Promise((resolve, reject) => {
        clearSocket.on('channel-messages-cleared', payload => {
          if (payload?.channelId === clearedChannelId) resolve(payload);
        });
        clearSocket.on('clear-channel-error', payload => {
          if (payload?.channelId === clearedChannelId) reject(new Error(payload.error));
        });
      }), 10_000, 'durable channel clear');
      clearSocket.emit('clear-channel-messages', { channelId: clearedChannelId });
      await clearAcknowledged;
      clearSocket.close();
      assert.ok(!(await api(catchupAuthority.origin,
        `/api/messages/${clearedChannelId}`, { token: owner.accessToken })).messages
        .some(item => item.id === clearedMessage.id),
      'bulk-cleared message is absent on the source');
      const expiringChannel = await api(catchupAuthority.origin, '/api/channels', {
        method: 'POST', body: { name: 'retention-expiry-canary', channel_type: 'text' },
        token: owner.accessToken,
      });
      expiredChannelId = expiringChannel.id ?? expiringChannel.channel?.id;
      assert.ok(expiredChannelId, 'expiry channel identity');
      await api(catchupAuthority.origin, `/api/channels/${expiredChannelId}/retention`, {
        method: 'PUT', body: { retention: '5s' }, token: owner.accessToken,
      });
      const expiringMessage = await api(catchupAuthority.origin, '/api/messages', {
        method: 'POST', body: { channel_id: expiredChannelId,
          content: 'Expire before passive move', message_type: 'text' },
        token: owner.accessToken,
      });
      assert.ok(expiringMessage.id);
      assert.ok((await api(catchupAuthority.origin,
        `/api/messages/${expiredChannelId}`, { token: owner.accessToken })).messages
        .some(item => item.id === expiringMessage.id),
      'short-lived message is visible before retention expiry');
      let expiredOnSource = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const sourceHistory = await api(catchupAuthority.origin,
          `/api/messages/${expiredChannelId}`, { token: owner.accessToken });
        if (!sourceHistory.messages.some(item => item.id === expiringMessage.id)) {
          expiredOnSource = true;
          break;
        }
        await pause(200);
      }
      assert.equal(expiredOnSource, true, 'retention sweep removed expired source history');
      const sourceRegistryDigest = await fileDigestOn(oldSite,
        join(authority.data, 'upload_registry.json'));
      const sourceSyncResponse = await fetch(`${catchupAuthority.origin}/api/sync/status`, {
        headers: { 'x-wabi-sync-token': liveReceiver.token },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(sourceSyncResponse.status, 200, 'source sync status after revocation');
      const sourceSyncStatus = await sourceSyncResponse.json();
      assert.ok(Number.isSafeInteger(sourceSyncStatus.latestCommitSeq),
        'source exposes a durable commit position after revocation');
      const deletionStatus = await waitReceiver(liveReceiver,
        status => status.appliedCommitSeq >= sourceSyncStatus.latestCommitSeq
          && status.indexedCommitSeq === status.appliedCommitSeq
          && status.uploadPrunedThroughCommitSeq >= status.appliedCommitSeq,
        'source-confirmed message deletion and upload revocation cleanup');
      let passiveRegistryDigest;
      for (let attempt = 0; attempt < 100; attempt++) {
        passiveRegistryDigest = await fileDigestOn(replacementSite,
          join(passiveRoot, 'data', 'upload_registry.json')).catch(() => undefined);
        if (passiveRegistryDigest === sourceRegistryDigest) break;
        await pause(200);
      }
      assert.equal(passiveRegistryDigest, sourceRegistryDigest,
        'revoked upload registry reached the passive copy');
      assert.equal(await fileDigestOn(replacementSite, passiveFile).catch(() => undefined),
        undefined, 'receiver removed the revoked upload bytes');
      const finalStatus = await receiverStatus(liveReceiver);
      assert.ok(finalStatus.appliedCommitSeq >= deletionStatus.appliedCommitSeq);
      assert.equal(finalStatus.indexedCommitSeq, finalStatus.appliedCommitSeq);
      replicaEvidence = {
        baselineAppliedCommitSeq: baselineStatus.appliedCommitSeq,
        caughtUpAppliedCommitSeq: finalStatus.appliedCommitSeq,
        uploadSha256: passiveDigest,
        uploadBytes: laterBytes.length,
        revokedUploadPruned: true,
        deletedMessageId,
        writerFenced: finalStatus.writerFenced,
        fullInstanceReady: finalStatus.fullInstanceReady,
        sidecarCopyEnabled: finalStatus.sidecarCopyEnabled,
      };
      if (process.env.WABI_PASSIVE_MOVE_ONLY === '1') passiveCutoverStartedAt = Date.now();
      await stop(catchupAuthority);
      await stopReceiver(liveReceiver);
      const [sourceManifest, passiveManifest] = await Promise.all([
        stoppedDataManifestOn(oldSite, authority.data),
        stoppedDataManifestOn(replacementSite, join(passiveRoot, 'data')),
      ]);
      for (const sharedPath of ['wabidb/root_key', 'jwt_secret']) {
        assert.ok(sourceManifest[sharedPath], `${sharedPath} is present in stopped Authority`);
        assert.equal(passiveManifest[sharedPath], sourceManifest[sharedPath],
          `${sharedPath} matches in the fenced passive tree`);
      }
      assert.ok(!sourceManifest[`uploads/${filename}`] && !passiveManifest[`uploads/${filename}`],
        'revoked upload bytes stay absent on both stopped trees');
      replicaEvidence.stoppedFileComparison = {
        sourceOnly: Object.keys(sourceManifest).filter(path => !(path in passiveManifest)),
        passiveOnly: Object.keys(passiveManifest).filter(path => !(path in sourceManifest)),
        changed: Object.keys(sourceManifest).filter(path =>
          path in passiveManifest && passiveManifest[path] !== sourceManifest[path]),
      };
      const [sourceProjection, passiveProjection] = await Promise.all([
        projectionSnapshotOn(oldSite, authority.data),
        projectionSnapshotOn(replacementSite, join(passiveRoot, 'data')),
      ]);
      assert.deepEqual(passiveProjection, sourceProjection,
        'stopped source and fenced receiver have the same decoded projection snapshot');
      replicaEvidence.projectionSnapshot = sourceProjection;
      await assertAuthorityRefusesOn(replacementSite, join(passiveRoot, 'data'),
        join(passiveRoot, 'data', 'uploads'), /fenc/i);
      await clearStoppedLocksOn(oldSite, catchupAuthority);
      checks.push(replacementSite?.ssh
        ? 'running Authority database and verified upload catch up on a remote fenced receiver'
        : 'running Authority database and verified upload catch up on a loopback fenced receiver');
    }
    if (replicaBinary && process.env.WABI_PASSIVE_MOVE_ONLY === '1') {
      const passiveRoot = join(replacementRoot, 'live-passive');
      // The receiver may leave its empty upload staging directory after a
      // completed transfer. Refuse nonempty staging rather than promoting it.
      const replicaStage = join(passiveRoot, 'data', 'uploads', '.replica');
      if (replacementSite) {
        await remoteCommand(replacementSite, ['rmdir', '--', replicaStage]
          .map(shellQuote).join(' '));
      } else {
        await execFileAsync('rmdir', ['--', replicaStage], { cwd: root, timeout: 10_000 });
      }
      const [oldDirectories, passiveDirectories] = await Promise.all([
        stoppedDirectoryListOn(oldSite, authority.data),
        stoppedDirectoryListOn(replacementSite, join(passiveRoot, 'data')),
      ]);
      assert.deepEqual(passiveDirectories, oldDirectories,
        'complete source/passive directory inventories must match before activation');
      await snapshotOn(oldSite, 'fence-stopped', '--data-dir', authority.data);
      const sourceReceipt = join(oldRoot, 'passive-move-receipt.json');
      await snapshotOn(oldSite, 'seal-passive-move', '--data-dir', authority.data,
        '--uploads-dir', join(authority.data, 'uploads'), '--receipt', sourceReceipt);
      const receipt = join(replacementRoot, 'passive-move-receipt.json');
      if (fieldSites) await transferBetweenSites(oldSite, sourceReceipt, replacementSite, receipt);
      await assertAuthorityRefusesOn(oldSite, authority.data,
        join(authority.data, 'uploads'), /fenc/i);
      await assert.rejects(snapshotOn(replacementSite, 'activate-passive',
        '--target-root', passiveRoot, '--receipt', receipt), /external|review/i);
      await snapshotOn(replacementSite, 'activate-passive',
        '--target-root', passiveRoot, '--receipt', receipt, '--external-state-reviewed');
      const replacement = await launch('authority', undefined, {
        site: replacementSite,
        data: join(passiveRoot, 'data'), uploadsDir: join(passiveRoot, 'data', 'uploads'),
      });
      const repointed = await launch('equipment', replacement.origin, { port: equipmentPort });
      const plannedCutoverMs = Date.now() - passiveCutoverStartedAt;
      assert.equal(repointed.origin, rememberedEquipmentUrl,
        'member-facing Anchor address survives passive activation');
      const restoredRoster = await api(repointed.origin, '/api/community/roster',
        { token: member.accessToken });
      assert.equal(restoredRoster.body.communityId, initialRoster.body.communityId);
      const restoredHistory = await api(repointed.origin, `/api/messages/${channelId}`,
        { token: member.accessToken });
      for (const id of [ack.messageId, reverseAck.messageId, fallback.id]) {
        assert.equal(restoredHistory.messages.filter(item => item.id === id).length, 1,
          `message ${id} survives passive activation exactly once`);
      }
      assert.ok(restoredHistory.messages.some(item => item.content === 'Live fenced receiver canary'),
        'post-baseline write survives passive activation');
      assert.ok(!restoredHistory.messages.some(item => item.id === deletedMessageId),
        'deleted message stays absent after passive activation');
      assert.deepEqual((await api(repointed.origin, `/api/messages/${clearedChannelId}`,
        { token: owner.accessToken })).messages, [],
      'bulk-cleared channel stays empty after passive activation');
      assert.deepEqual((await api(repointed.origin, `/api/messages/${expiredChannelId}`,
        { token: owner.accessToken })).messages, [],
      'expired channel history stays empty after passive activation');
      const restoredFile = await fetch(repointed.origin + file.fileUrl, {
        headers: { authorization: `Bearer ${member.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(restoredFile.status, 200);
      assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()), bytes);
      assert.equal((await fetch(repointed.origin + revokedFileUrl,
        { signal: AbortSignal.timeout(10_000) })).status, 410,
      'revoked upload stays denied after passive activation');
      const newMessage = await api(repointed.origin, '/api/messages', {
        method: 'POST', body: { channel_id: channelId,
          content: 'Write after passive move', message_type: 'text' },
        token: owner.accessToken,
      });
      assert.ok((await api(repointed.origin, `/api/messages/${channelId}`,
        { token: member.accessToken })).messages.some(item => item.id === newMessage.id));
      await stop(repointed);
      await stop(replacement);
      await assertAuthorityRefusesOn(oldSite, authority.data,
        join(authority.data, 'uploads'), /fenc/i);
      replicaEvidence.passiveMove = {
        oldWriterFenced: true, matchedBeforeActivation: true,
        sameCommunityAndSession: true, postMoveWrite: true, plannedCutoverMs,
        deletedMessageStayedDeleted: true, revokedUploadStayedDenied: true,
        bulkClearStayedClear: true, timedExpiryStayedExpired: true,
      };
      checks.push('caught-up passive activated only after old writer fence and whole-tree match',
        'known Anchor URL retained community, session, history and upload',
        'deleted message, cleared channel, expired message and revoked upload stayed denied after passive activation',
        'replacement Authority accepted a new write while old writer refused startup');
    } else {
      const identity = join(replacementRoot, 'recovery.agekey');
      const { stdout: keygen } = await snapshotOn(replacementSite,
        'keygen', '--identity-file', identity);
      const recipient = keygen.match(/^Recipient: (age\S+)$/m)?.[1];
      assert.ok(recipient, 'recovery recipient');
      await snapshotOn(oldSite, 'fence-stopped', '--data-dir', authority.data);
      const sourceArchive = join(oldRoot, 'handoff.age');
      await snapshotOn(oldSite, 'export', '--data-dir', authority.data, '--uploads-dir',
        join(authority.data, 'uploads'), '--recipient', recipient, '--output', sourceArchive);
      const archive = join(replacementRoot, 'handoff.age');
      if (fieldSites) await transferBetweenSites(oldSite, sourceArchive, replacementSite, archive);
      const restoredRoot = join(replacementRoot, 'replacement-host');
      await snapshotOn(replacementSite, 'restore', '--input', archive, '--identity-file', identity,
        '--target-root', restoredRoot, '--controlled-move');
      await assertAuthorityRefusesOn(replacementSite, join(restoredRoot, 'data'),
        join(restoredRoot, 'data', 'uploads'), /activation-pending/i);
      const sourceReceipt = join(oldRoot, 'fence-receipt.json');
      await snapshotOn(oldSite, 'fence-stopped', '--data-dir', authority.data,
        '--archive', sourceArchive, '--receipt', sourceReceipt);
      await assertAuthorityRefusesOn(oldSite, authority.data,
        join(authority.data, 'uploads'), /fenc/i);
      const receipt = join(replacementRoot, 'fence-receipt.json');
      if (fieldSites) await transferBetweenSites(oldSite, sourceReceipt, replacementSite, receipt);
      await snapshotOn(replacementSite, 'activate-restored',
        '--target-root', restoredRoot, '--receipt', receipt);

      const replacement = await launch('authority', undefined, {
        site: replacementSite,
        data: join(restoredRoot, 'data'), uploadsDir: join(restoredRoot, 'data', 'uploads'),
      });
      const repointed = await launch('equipment', replacement.origin, { port: equipmentPort });
      assert.equal(repointed.origin, rememberedEquipmentUrl,
        'the member-facing Anchor address survives the planned move');
      const restoredRoster = await api(repointed.origin, '/api/community/roster',
        { token: member.accessToken });
      assert.equal(restoredRoster.body.communityId, initialRoster.body.communityId);
      assert.equal(restoredRoster.body.version, 1);
      const restoredHistory = await api(repointed.origin, `/api/messages/${channelId}`,
        { token: member.accessToken });
      for (const id of [ack.messageId, reverseAck.messageId, fallback.id]) {
        assert.equal(restoredHistory.messages.filter(item => item.id === id).length, 1,
          `message ${id} survives exactly once`);
      }
      const restoredFile = await fetch(repointed.origin + file.fileUrl, {
        headers: { authorization: `Bearer ${member.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(restoredFile.status, 200, 'upload survives full-instance restore');
      assert.deepEqual(Buffer.from(await restoredFile.arrayBuffer()), bytes);
      const newMessage = await api(repointed.origin, '/api/messages', {
        method: 'POST', body: { channel_id: channelId,
          content: 'Post-move write through known site', message_type: 'text' },
        token: owner.accessToken,
      });
      assert.ok((await api(repointed.origin, `/api/messages/${channelId}`,
        { token: member.accessToken })).messages.some(item => item.id === newMessage.id));
      const updatedRoster = await publishRoster(repointed.origin, owner.accessToken,
        ownerCredentials.password, 1, [
          { nodeId: 'roofing', role: 'authority', url: replacement.origin },
          { nodeId: 'equipment', role: 'anchor', url: repointed.origin },
        ]);
      assert.equal(updatedRoster.body.communityId, initialRoster.body.communityId);
      assert.equal(updatedRoster.body.version, 2);
      assert.equal((await api(repointed.origin, '/api/community/roster',
        { token: member.accessToken })).body.version, 2);
      await assertAuthorityRefusesOn(oldSite, authority.data,
        join(authority.data, 'uploads'), /fenc/i);
      await stop(repointed);
      await stop(replacement);
      await clearStoppedLocksOn(replacementSite, replacement);
      const reseedIdentity = join(oldRoot, 'reseed.agekey');
      const { stdout: reseedKeygen } = await snapshotOn(oldSite,
        'keygen', '--identity-file', reseedIdentity);
      const reseedRecipient = reseedKeygen.match(/^Recipient: (age\S+)$/m)?.[1];
      assert.ok(reseedRecipient, 'retired-site reseed recipient');
      const reseedSource = join(replacementRoot, 'reseed.age');
      await snapshotOn(replacementSite, 'export', '--data-dir', join(restoredRoot, 'data'),
        '--uploads-dir', join(restoredRoot, 'data', 'uploads'),
        '--recipient', reseedRecipient, '--output', reseedSource);
      const reseedArchive = join(oldRoot, 'reseed.age');
      if (fieldSites) await transferBetweenSites(replacementSite, reseedSource,
        oldSite, reseedArchive);
      const passiveRoot = join(oldRoot, 'retired-passive');
      await snapshotOn(oldSite, 'restore', '--input', reseedArchive,
        '--identity-file', reseedIdentity, '--target-root', passiveRoot,
        '--passive-replica');
      await assertAuthorityRefusesOn(oldSite, join(passiveRoot, 'data'),
        join(passiveRoot, 'data', 'uploads'), /fenc/i);
      const [newManifest, passiveManifest] = await Promise.all([
        stoppedDataManifestOn(replacementSite, join(restoredRoot, 'data')),
        stoppedDataManifestOn(oldSite, join(passiveRoot, 'data')),
      ]);
      assert.ok(Object.keys(newManifest).length > 0, 'the new Authority has durable files');
      assert.deepEqual(passiveManifest, newManifest,
        'retired passive copy must contain the new Authority state after its later write');
      await assertAuthorityRefusesOn(oldSite, authority.data,
        join(authority.data, 'uploads'), /fenc/i);
      const resumed = await launch('authority', undefined, {
        site: replacementSite,
        data: join(restoredRoot, 'data'), uploadsDir: join(restoredRoot, 'data', 'uploads'),
      });
      const resumedEntry = await launch('equipment', resumed.origin, { port: equipmentPort });
      assert.ok((await api(resumedEntry.origin, `/api/messages/${channelId}`,
        { token: member.accessToken })).messages.some(item => item.id === newMessage.id),
      'new Authority resumes with its post-move write');
      await stop(resumedEntry);
      await stop(resumed);
      checks.push('pending restored Authority startup refused before receipt',
        fieldSites
          ? 'fenced encrypted stopped move across two site networks with same community, session, messages and upload'
          : 'fenced encrypted stopped move with same community, session, messages and upload',
        'known Anchor URL repointed to new Authority', 'old Authority restart refused',
        'new Authority write and signed roster update',
        'retired site reseeded as a fenced passive copy with matching durable state',
        'new Authority resumed after its stopped reseed export');
    }
  }
  console.log(JSON.stringify({ result: 'PASS', scope: fieldSites && Object.values(fieldSites).some(site => site.ssh)
    ? 'configured remote field transport; physical site count verified separately'
    : 'single-host loopback only',
    checks,
    localAssetBytesPerSite: sourceAsset.length,
    remoteClientProbes, staticOriginBytes, cacheOriginBytes, replicaEvidence, loadEvidence }));
} finally {
  for (const socket of sockets) socket.close();
  if (liveReceiver) await stopReceiver(liveReceiver).catch(() => {});
  for (const meter of [materialsMeter, equipmentMeter]) await meter?.close().catch(() => {});
  for (const instance of remoteInstances) {
    await stopRemoteTestProcess(instance).catch(error => {
      console.error(`WARNING: remote ${instance.role} cleanup failed: ${error.message}`);
    });
  }
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await bounded(exited, 5_000, 'cleanup').catch(() => {});
    }
  }
  await rm(root, { recursive: true, force: true });
}
