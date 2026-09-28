#!/usr/bin/env node
// Disposable physical-network check: Tailcat device admission -> Wabi account
// -> explicit service role -> registered loopback TCP service. Never uses live data.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const [serverArg, tailcatArg, remoteHost, remoteRoot] = process.argv.slice(2);
assert.ok(serverArg && tailcatArg && remoteHost && remoteRoot,
  'Usage: node scripts/tailcat-service-field-smoke.mjs <wabi-server> <tailcat> <user@host> </tmp/wabi-three-site-field-id>');
assert.match(remoteHost, /^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/);
assert.match(remoteRoot, /^\/tmp\/wabi-three-site-field-[A-Za-z0-9_-]+$/);
const serverBinary = resolve(serverArg);
const tailcatBinary = resolve(tailcatArg);
const remoteTailcat = `${remoteRoot}/tailcat`;
const remotePidFile = `${remoteRoot}/service-socks.pid`;
const remoteSocksPort = 47823;
const root = await mkdtemp(join(tmpdir(), 'wabi-tailcat-service-field-'));
const data = join(root, 'data');
const home = join(root, 'home');
const execFileAsync = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const pause = ms => new Promise(done => setTimeout(done, ms));
let wabi;
let httpService;
let remoteSocks;

async function remote(command, timeout = 30_000) {
  const { stdout } = await execFileAsync('ssh', ['-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', remoteHost, command],
  { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function choosePortPair() {
  for (let i = 0; i < 30; i++) {
    const port = 38000 + Math.floor(Math.random() * 16000);
    const a = createTcpServer();
    const b = createTcpServer();
    try {
      a.listen(port, '127.0.0.1');
      await once(a, 'listening');
      b.listen(port + 1, '127.0.0.1');
      await once(b, 'listening');
      return port;
    } catch { /* another process owns this pair */ }
    finally {
      if (a.listening) await new Promise(done => a.close(done));
      if (b.listening) await new Promise(done => b.close(done));
    }
  }
  throw new Error('no free Wabi/Tailcat port pair');
}

async function api(origin, path, { method = 'GET', body, token, bootstrap } = {}) {
  const response = await fetch(origin + path, { method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(bootstrap ? { 'x-wabi-bootstrap-token': bootstrap } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function launchWabi(port, bootstrap) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    WABI_SERVER_ROLE: 'authority', WABI_MESH_ENABLED: 'false',
    WABI_DESKTOP_BOOTSTRAP_TOKEN: bootstrap,
    WABI_TAILCAT_BINARY: tailcatBinary, WABI_LOG_DIR: join(root, 'logs'),
    WABI_UPLOADS_DIR: join(data, 'uploads'),
    WABI_CORS_ORIGINS: `http://server.tailcat:${port + 1}` };
  const child = spawn(serverBinary, ['--host', '127.0.0.1', '--port', String(port),
    '--data-dir', data, '--desktop-managed', '--print-bound-address',
    '--shutdown-on-stdin-close'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const exited = once(child, 'exit');
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const bound = new Promise((done, reject) => {
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'wabi-listener-bound') done(event.address);
      } catch { /* diagnostic line */ }
    });
    exited.then(([code, signal]) => reject(new Error(`Wabi exited before bind (${code}, ${signal}): ${stderr.replaceAll(bootstrap, '[REDACTED]')}`)), reject);
  });
  const address = await Promise.race([bound,
    pause(30_000).then(() => { throw new Error('Wabi bind timeout'); })]);
  const origin = `http://${address}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) })).ok)
        return { child, exited, lines, origin };
    } catch { /* starting */ }
    await pause(100);
  }
  throw new Error('Wabi readiness timeout');
}

async function remoteWebSocketProbe(mode, token, pipePort) {
  const source = `
import json, socks, sys, time, websocket
q = json.load(sys.stdin)
started = time.monotonic()
sock = socks.socksocket()
sock.set_proxy(socks.SOCKS5, '127.0.0.1', q['socksPort'], rdns=True)
sock.settimeout(20)
sock.connect(('server.tailcat', q['pipePort']))
try:
    ws = websocket.create_connection('ws://server.tailcat:%d/api/services/http-probe/connect' % q['pipePort'],
        header={'Authorization': 'Bearer ' + q['token']}, timeout=20, socket=sock)
except websocket.WebSocketBadStatusException as error:
    sock.close()
    print(json.dumps({'status': error.status_code, 'elapsedMs': round((time.monotonic()-started)*1000)}))
    sys.exit(0)
ws.send_binary(b'GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n')
received = b''
while b'Wabi Tailcat role canary' not in received:
    item = ws.recv()
    received += item.encode() if isinstance(item, str) else item
    if len(received) > 65536: raise AssertionError('oversized service response')
ws.close()
print(json.dumps({'status': 101, 'bodyOk': b'HTTP/1.1 200 OK' in received and b'Wabi Tailcat role canary' in received,
    'bytes': len(received), 'elapsedMs': round((time.monotonic()-started)*1000)}))
`;
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    remoteHost, `python3 -c ${quote(source)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.end(JSON.stringify({ mode, token, pipePort, socksPort: remoteSocksPort }));
  const [code, signal] = await Promise.race([once(child, 'exit'),
    pause(35_000).then(() => { child.kill('SIGKILL'); throw new Error('remote WebSocket probe timeout'); })]);
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, `remote WebSocket probe: ${stderr}`);
  return JSON.parse(stdout);
}

async function stopRemoteSocks() {
  const script = `if test -s ${quote(remotePidFile)}; then pid=$(cat ${quote(remotePidFile)}); case "$pid" in ''|*[!0-9]*) exit 2;; esac; if ps -p "$pid" -o args= | grep -Fq ${quote(`${remoteTailcat} socks --listen=127.0.0.1:${remoteSocksPort}`)}; then kill "$pid"; fi; rm -f ${quote(remotePidFile)}; fi`;
  await remote(script).catch(() => {});
  if (remoteSocks) remoteSocks.kill('SIGTERM');
}

try {
  await mkdir(data);
  await mkdir(home);
  httpService = createHttpServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'connection': 'close' });
    response.end('Wabi Tailcat role canary');
  });
  httpService.listen(0, '127.0.0.1');
  await once(httpService, 'listening');
  const targetPort = httpService.address().port;
  await writeFile(join(data, 'service_endpoints.json'), JSON.stringify([
    { id: 'http-probe', name: 'Disposable HTTP probe', kind: 'test',
      address: `127.0.0.1:${targetPort}`, exposed: true },
  ]));
  const port = await choosePortPair();
  const bootstrap = randomBytes(32).toString('hex');
  wabi = await launchWabi(port, bootstrap);
  const credentials = { username: 'tailcat_owner', password: 'Disposable-Tailcat-Role-Only!',
    communityName: 'Tailcat service role field check' };
  const owner = await api(wabi.origin, '/api/auth/register', {
    method: 'POST', body: credentials, bootstrap });
  const invite = await api(wabi.origin, '/api/invites', {
    method: 'POST', body: { expiresInHours: 1 }, token: owner.accessToken });
  const member = await api(wabi.origin, '/api/auth/register', { method: 'POST',
    body: { username: 'tailcat_member', password: credentials.password,
      inviteToken: invite.token } });
  const keyEnv = `env HOME=${quote(remoteRoot)} XDG_CONFIG_HOME=${quote(`${remoteRoot}/.config`)} ${quote(remoteTailcat)}`;
  const keyFile = `${remoteRoot}/.config/tailcat/keys/client-default.private.json`;
  const keyOutput = await remote(`if test -f ${quote(keyFile)}; then ${keyEnv} printpub; else ${keyEnv} genkey --client --key=client-default; fi`);
  const publicKey = keyOutput.match(/nodekey:[a-f0-9]{64}/)?.[0];
  assert.ok(publicKey, 'remote client key');
  await api(wabi.origin, '/api/addons/tailcat/keys', { method: 'POST',
    body: { publicKey, label: 'Disposable Ronin role probe' }, token: member.accessToken });
  await api(wabi.origin, '/api/addons/tailcat/enable', { method: 'POST',
    body: { confirm: true }, token: owner.accessToken });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await api(wabi.origin, '/api/addons/tailcat/status', { token: owner.accessToken });
    if (status.running && status.address) break;
    await pause(200);
  }
  assert.ok(status.running && status.address, `Tailcat listener: ${status.lastError ?? 'not ready'}`);
  const inner = `echo $$ > ${quote(remotePidFile)}; exec env HOME=${quote(remoteRoot)} XDG_CONFIG_HOME=${quote(`${remoteRoot}/.config`)} ${quote(remoteTailcat)} socks --listen=127.0.0.1:${remoteSocksPort} ${quote(status.address)}`;
  remoteSocks = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    remoteHost, `sh -c ${quote(inner)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  remoteSocks.stderr.on('data', () => {});
  remoteSocks.stdout.on('data', () => {});
  let reachable = false;
  for (let i = 0; i < 40; i++) {
    try {
      const code = await remote(`curl --noproxy '' --proxy socks5h://127.0.0.1:${remoteSocksPort} -sS -o /dev/null -w '%{http_code}' --max-time 5 http://server.tailcat:${status.pipePort}/api/public/auth-policy`, 10_000);
      if (code === '200') { reachable = true; break; }
    } catch { /* tunnel starts asynchronously */ }
    await pause(250);
  }
  assert.ok(reachable, 'Ronin can reach Wabi through Tailcat');
  const deniedBefore = await remoteWebSocketProbe('before', member.accessToken, status.pipePort);
  assert.equal(deniedBefore.status, 403, 'no implicit role grant');
  const snapshot = await api(wabi.origin, '/api/admin/service-access', { token: owner.accessToken });
  const roles = snapshot.access.roles;
  const memberRole = roles.find(role => role.id === 'builtin:member');
  assert.ok(memberRole, 'built-in member role');
  memberRole.services = [...memberRole.services, 'http-probe'];
  const granted = await api(wabi.origin, '/api/admin/service-access', { method: 'PUT',
    body: { revision: snapshot.access.revision, roles }, token: owner.accessToken });
  const allowed = await remoteWebSocketProbe('allowed', member.accessToken, status.pipePort);
  assert.equal(allowed.status, 101);
  assert.equal(allowed.bodyOk, true, 'TCP HTTP bytes traverse the role gateway');
  const revokeRoles = granted.access.roles;
  const revokeMember = revokeRoles.find(role => role.id === 'builtin:member');
  revokeMember.services = revokeMember.services.filter(id => id !== 'http-probe');
  await api(wabi.origin, '/api/admin/service-access', { method: 'PUT',
    body: { revision: granted.access.revision, roles: revokeRoles }, token: owner.accessToken });
  const deniedAfter = await remoteWebSocketProbe('after', member.accessToken, status.pipePort);
  assert.equal(deniedAfter.status, 403, 'revoked role denies new connection');
  await api(wabi.origin, '/api/addons/tailcat/disable', { method: 'POST', token: owner.accessToken });
  console.log(JSON.stringify({ result: 'PASS', transport: 'Tailcat physical Ronin-to-local host',
    target: 'disposable loopback HTTP TCP port', deniedBefore: deniedBefore.status,
    allowed: allowed.status, allowedBytes: allowed.bytes, allowedMs: allowed.elapsedMs,
    deniedAfter: deniedAfter.status, tailcatDisabled: true }));
} finally {
  await stopRemoteSocks();
  if (wabi) {
    wabi.child.stdin.end();
    await Promise.race([wabi.exited, pause(10_000)]).catch(() => {});
    if (wabi.child.exitCode === null && wabi.child.signalCode === null) wabi.child.kill('SIGKILL');
    wabi.lines.close();
  }
  if (httpService) await new Promise(done => httpService.close(done));
  await rm(root, { recursive: true, force: true });
}
