// Disposable live V2 capture and offline verification; never activates a copy.
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
assert.ok(args.length === 2 || args.length === 3, 'Pass server, snapshot and optional private remote-config file');
const [serverInput, snapshotInput] = args.map(value => resolve(value));
const remote = args[2] ? JSON.parse(await readFile(args[2], 'utf8')) : null;
if (remote) {
  assert.deepEqual(Object.keys(remote).sort(), ['expectedHost', 'sshTarget']);
  assert.match(remote.sshTarget, /^[a-zA-Z_][a-zA-Z0-9_-]*@100\.(?:\d{1,3}\.){2}\d{1,3}$/);
  assert.match(remote.expectedHost, /^[a-zA-Z0-9_.-]{1,64}$/);
}
const scratch = await mkdtemp('/tmp/wabi-inactive-live-');
await chmod(scratch, 0o700);
const server = join(scratch, 'server'), snapshot = join(scratch, 'snapshot');
const identity = join(scratch, 'identity.txt'), sourceReceipt = join(scratch, 'source-receipt.json');
const checkpointDirectory = join(scratch, 'checkpoints');
const data = join(scratch, 'source/data'), uploads = join(scratch, 'source/uploads');
const ownerMarker = `owner-${randomUUID()}`;
const remoteStage = `/tmp/wabi-inactive-live-${randomUUID()}`;
const operatorSecret = randomUUID();
const deadline = AbortSignal.timeout(240_000);
const receipt = { schemaVersion: 1, result: 'FAIL', workload: 'live V2 inactive core verification',
  authorityActivated: false, automaticFailoverTested: false, externalStateVerified: false,
  fullInstanceReady: false, remote: null, cleanup: null };
let stage = 'artifact-freeze', child = null, exited = null, log = null, remoteAttempted = false;
const pause = ms => new Promise(done => setTimeout(done, ms));
const env = { PATH: process.env.PATH };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function command(program, arguments_, timeout = 90_000, enforceDeadline = true) {
  if (enforceDeadline) deadline.throwIfAborted();
  return execFile(program, arguments_, { timeout, maxBuffer: 1024 * 1024, env });
}
async function ssh(script, timeout = 100_000, cleanup = false) {
  return command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remote.sshTarget, script], timeout, !cleanup);
}
async function transfer(path, name) {
  deadline.throwIfAborted();
  await new Promise((done, reject) => {
    const process = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remote.sshTarget,
      `umask 077; cat > ${quote(join(remoteStage, name))}`], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    const stream = createReadStream(path);
    const timer = setTimeout(() => process.kill('SIGKILL'), 90_000);
    let failed = false;
    process.once('error', error => { clearTimeout(timer); stream.destroy(); reject(error); });
    stream.once('error', () => { failed = true; process.kill('SIGKILL'); });
    process.stdin.once('error', () => { failed = true; process.kill('SIGKILL'); });
    process.once('close', code => {
      clearTimeout(timer); stream.destroy();
      if (code === 0 && !failed) done(); else reject(new Error('private transfer failed'));
    });
    stream.pipe(process.stdin);
  });
}
async function request(origin, path, { token, method = 'GET', body, operator = false, status = null } = {}) {
  const response = await fetch(origin + path, { method, redirect: 'error',
    signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(operator ? { 'x-operator-secret': operatorSecret } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (status !== null) assert.equal(response.status, status, 'fixture HTTP status');
  else assert.ok(response.ok, 'fixture HTTP refusal');
  return response.json();
}
async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const outcome = await exited;
  clearTimeout(timer); log.end(); child = null;
  assert.equal(outcome.code, 0, 'source clean shutdown');
}
function verifyArguments(root, archive, key, source) {
  return ['verify-inactive', '--target-root', root, '--input', archive,
    '--identity-file', key, '--source-receipt', source, '--timeout-seconds', '60'];
}
try {
  receipt.harnessSha256 = await sha(fileURLToPath(import.meta.url));
  // Protected ownership evidence survives a runner/host crash. Never clean up
  // a different remote root or kill an unrelated PID from a stale manifest.
  const ownership = { localRoot: scratch, remote: remote ? { ...remote, root: remoteStage, ownerMarker } : null,
    sourcePid: null, sourceExecutable: server, createdAtUtc: new Date().toISOString() };
  const manifest = join(scratch, 'ownership.json');
  await writeFile(manifest, JSON.stringify(ownership), { mode: 0o600 });
  const originalHashes = { serverSha256: await sha(serverInput), snapshotSha256: await sha(snapshotInput) };
  await copyFile(serverInput, server); await copyFile(snapshotInput, snapshot);
  await chmod(server, 0o700); await chmod(snapshot, 0o700);
  assert.equal(await sha(server), originalHashes.serverSha256);
  assert.equal(await sha(snapshot), originalHashes.snapshotSha256);
  // Strip only the owned copies, so hundreds of MiB of debug symbols do not
  // travel over the WAN or remain in scratch. Original build outputs are intact.
  await command('strip', ['--strip-debug', server, snapshot]);
  receipt.inputArtifact = originalHashes;
  receipt.artifact = { serverSha256: await sha(server), snapshotSha256: await sha(snapshot),
    serverBytes: (await stat(server)).size, snapshotBytes: (await stat(snapshot)).size,
    debugSymbolsRemovedFromOwnedCopies: true };
  const keygen = await command(snapshot, ['keygen', '--identity-file', identity]);
  const recipient = /^Recipient: (\S+)$/m.exec(keygen.stdout)?.[1];
  assert.ok(recipient);
  for (const root of [data, uploads, checkpointDirectory]) { await mkdir(root, { recursive: true }); await chmod(root, 0o700); }
  stage = 'source-start';
  const listener = net.createServer();
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(server, ['--host', '127.0.0.1', '--port', String(port), '--data-dir', data], {
    cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env,
      WABI_UPLOADS_DIR: uploads, WABI_BLACKLIST_FILE: join(data, 'blacklist.txt'),
      WABI_LOG_DIR: join(scratch, 'logs'), WABI_LORE_ENABLED: 'false', WABI_MESH_ENABLED: 'false',
      WABI_OPERATOR_SECRET: operatorSecret, WABI_CHECKPOINT_DIR: checkpointDirectory,
      WABI_CHECKPOINT_RECIPIENT: recipient, WABI_CHECKPOINT_MAX_BYTES: String(32 * 1024 * 1024),
      WABI_CHECKPOINT_STORAGE_BYTES: String(128 * 1024 * 1024), WABI_CHECKPOINT_MIN_FREE_BYTES: String(64 * 1024 * 1024),
    } });
  log = createWriteStream(join(scratch, 'process.log'), { mode: 0o600 });
  child.stdout.pipe(log); child.stderr.pipe(log);
  exited = new Promise(done => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', () => done({ code: -1 })); });
  ownership.sourcePid = child.pid;
  await writeFile(manifest, JSON.stringify(ownership), { mode: 0o600 });
  for (let i = 0; i < 300; i++) {
    deadline.throwIfAborted(); assert.equal(child.exitCode, null, 'source startup');
    try { if ((await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1000) })).ok) break; }
    catch { /* bounded readiness */ }
    if (i === 299) throw new Error('source readiness deadline');
    await pause(100);
  }
  stage = 'source-fixture';
  const owner = await request(origin, '/api/auth/register', { method: 'POST', body: { username: 'live_owner', password: 'Disposable-Inactive-Live-Only!' } });
  const denied = await request(origin, '/api/auth/register', { method: 'POST', body: { username: 'live_denied', password: 'Disposable-Inactive-Denied-Only!' } });
  const channel = await request(origin, '/api/channels', { method: 'POST', token: owner.accessToken, body: { name: 'inactive-live-core', channel_type: 'text' } });
  const channelId = channel.id ?? channel.channel?.id; assert.ok(channelId);
  await request(origin, `/api/channels/${channelId}/retention`, { method: 'PUT', token: owner.accessToken, body: { retention: 'forever' } });
  const post = content => request(origin, '/api/messages', { method: 'POST', token: owner.accessToken,
    body: { channel_id: channelId, content, message_type: 'text' } });
  const retained = await post('retained inactive fixture'); assert.ok(retained.id);
  await request(origin, '/api/auth/logout', { method: 'POST', token: denied.accessToken });
  await request(origin, '/api/user/me', { token: denied.accessToken, status: 401 });
  await mkdir(join(data, 'unknown/empty'), { recursive: true });
  await writeFile(join(data, 'unknown/state'), 'private synthetic component', { mode: 0o600 });
  const fileBytes = Buffer.from('inactive live attachment fixture');
  const upload = await request(origin, '/api/upload/resumable/init', { method: 'POST', token: owner.accessToken,
    body: { fileName: 'fixture.txt', fileSize: fileBytes.length, mimeType: 'text/plain', channelId } });
  const chunk = await fetch(`${origin}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(upload.uploadId)}&offset=0`, {
    method: 'PUT', signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]), body: fileBytes,
    headers: { Authorization: `Bearer ${owner.accessToken}`, 'x-upload-token': upload.uploadToken, 'Content-Type': 'application/octet-stream' } });
  assert.ok(chunk.ok);
  await request(origin, '/api/upload/resumable/complete', { method: 'POST', token: owner.accessToken,
    body: { uploadId: upload.uploadId, uploadToken: upload.uploadToken } });
  stage = 'live-operator-capture';
  const job = await request(origin, '/api/operator/checkpoints/', { method: 'POST', operator: true, body: {}, status: 202 });
  assert.match(job.id, /^[a-zA-Z0-9_-]+$/);
  let completed;
  for (let i = 0; i < 300; i++) {
    const status = await request(origin, '/api/operator/checkpoints/', { operator: true });
    const current = status.jobs.find(value => value.id === job.id);
    assert.notEqual(current?.phase, 'failed', 'checkpoint job failed');
    if (current?.phase === 'ready') { completed = current; break; }
    await pause(100);
  }
  assert.ok(completed?.receipt);
  const captured = completed.receipt, archive = join(checkpointDirectory, `${job.id}.age`);
  assert.equal(await sha(archive), captured.encryptedArchiveSha256);
  await writeFile(sourceReceipt, JSON.stringify(captured), { mode: 0o600 });
  await post('source resumes after checkpoint'); receipt.sourceWritesResumed = true;
  await stop(); receipt.sourceStoppedBeforeVerification = true;
  const localTarget = join(scratch, 'inactive');
  stage = 'local-inactive-restore';
  await command(snapshot, ['restore', '--input', archive, '--identity-file', identity,
    '--target-root', localTarget, '--expected-sha256', captured.encryptedArchiveSha256,
    '--max-bytes', String(64 * 1024 * 1024)]);
  receipt.local = JSON.parse((await command(snapshot, verifyArguments(localTarget, archive, identity, sourceReceipt))).stdout);
  assert.equal(receipt.local.result, 'PASS'); assert.equal(receipt.local.publishedUploadsChecked, 1);
  assert.equal(receipt.local.fullInstanceReady, false);
  if (remote) {
    stage = 'remote-qualification';
    assert.equal((await ssh('hostname')).stdout.trim(), remote.expectedHost);
    // Admission before staging: /tmp can be a RAM-backed filesystem.
    const free = Number((await ssh("df -Pk /tmp | tail -n 1 | awk '{print $4}'")).stdout.trim()) * 1024;
    assert.ok(free > 512 * 1024 * 1024, 'remote temporary headroom');
    remoteAttempted = true;
    await ssh(`umask 077; mkdir -m 700 -- ${quote(remoteStage)} && : > ${quote(join(remoteStage, ownerMarker))}`);
    stage = 'private-remote-transfer';
    for (const [path, name] of [[snapshot, 'snapshot'], [identity, 'identity.txt'], [sourceReceipt, 'receipt.json'], [archive, 'checkpoint.age']]) await transfer(path, name);
    await ssh(`chmod 700 -- ${quote(join(remoteStage, 'snapshot'))}`);
    assert.equal((await ssh(`sha256sum -- ${quote(join(remoteStage, 'snapshot'))}`)).stdout.split(/\s/)[0], receipt.artifact.snapshotSha256);
    const remoteSnapshot = join(remoteStage, 'snapshot'), remoteArchive = join(remoteStage, 'checkpoint.age');
    const remoteIdentity = join(remoteStage, 'identity.txt'), remoteTarget = join(remoteStage, 'inactive');
    stage = 'remote-inactive-restore';
    const remoteCommand = arguments_ => `timeout -k 5s 90s env -i PATH=/usr/bin:/bin ${[remoteSnapshot, ...arguments_].map(quote).join(' ')}`;
    await ssh(remoteCommand(['restore', '--input', remoteArchive, '--identity-file', remoteIdentity,
      '--target-root', remoteTarget, '--expected-sha256', captured.encryptedArchiveSha256, '--max-bytes', String(64 * 1024 * 1024)]));
    stage = 'remote-offline-replay';
    const verified = JSON.parse((await ssh(remoteCommand(verifyArguments(remoteTarget, remoteArchive, remoteIdentity, join(remoteStage, 'receipt.json'))))).stdout);
    assert.deepEqual(verified, receipt.local, 'independent computer verification mismatch');
    receipt.remote = { computer: remote.expectedHost, snapshotSha256: receipt.artifact.snapshotSha256, verification: verified };
  }
  receipt.result = 'PASS';
} catch (error) {
  receipt.failureStage = stage;
  if (typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)) receipt.failureCode = error.code;
} finally {
  let processesStopped = false, remoteRemoved = !remoteAttempted;
  try { await stop(); processesStopped = true; } catch { /* retain source if shutdown uncertain */ }
  if (remoteAttempted) {
    try {
      const marker = quote(join(remoteStage, ownerMarker)), root = quote(remoteStage);
      const lock = quote(join(remoteStage, 'inactive/data/wabidb/.lock'));
      await ssh(`if test -f ${marker}; then if test -f ${lock}; then flock -n -- ${lock} rm -rf -- ${root}; else rm -rf -- ${root}; fi; fi; test ! -e ${root}`, 20_000, true);
      remoteRemoved = true;
    } catch { /* do not hide uncertain cleanup */ }
  }
  if (processesStopped && remoteRemoved) await rm(scratch, { recursive: true });
  receipt.cleanup = { ownedProcessesStopped: processesStopped, remoteOwnedScratchRemoved: remoteRemoved,
    localOwnedScratchRemoved: processesStopped && remoteRemoved };
  if (!processesStopped || !remoteRemoved) receipt.result = 'FAIL';
}
receipt.recordedAtUtc = new Date().toISOString();
console.log(JSON.stringify(receipt));
process.exitCode = receipt.result === 'PASS' ? 0 : 1;
