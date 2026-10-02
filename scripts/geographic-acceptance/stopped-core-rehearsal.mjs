// Disposable stopped V1 core restore; never activates a live V2 checkpoint.
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';

const execFile = promisify(execFileCallback);
const arguments_ = process.argv.slice(2);
assert.equal(arguments_.length, 2, 'Pass absolute server and snapshot binary paths');
const [server, snapshot] = arguments_.map(value => resolve(value));
const audit = join(dirname(fileURLToPath(import.meta.url)), 'stopped-tree-audit.py');
const scratch = await mkdtemp('/tmp/wabi-stopped-core-rehearsal-');
await chmod(scratch, 0o700);
const children = new Set();
const deadline = AbortSignal.timeout(180_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const receipt = { schemaVersion: 1, result: 'FAIL', workload: 'disposable stopped V1 core restore',
  engineReplayTested: false, externalStateVerified: false, fullInstanceReady: false,
  authorityRecoveryTested: false, automaticFailoverTested: false, cleanup: null };
let stage = 'artifact-provenance';

async function sha(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function command(program, args) {
  deadline.throwIfAborted();
  return execFile(program, args, { timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
}
async function auditCopy(source, restored) {
  const { stdout } = await command('python3', [audit, '--left-data', join(source, 'data'),
    '--left-uploads', join(source, 'uploads'), '--right-data', join(restored, 'data'),
    '--right-uploads', join(restored, 'uploads'), '--max-bytes', String(64 * 1024 * 1024)]);
  const value = JSON.parse(stdout);
  assert.equal(value.result, 'PASS');
  return value;
}
async function start(name) {
  deadline.throwIfAborted();
  const directory = join(scratch, name);
  await mkdir(directory, { recursive: true });
  const listener = net.createServer();
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  const child = spawn(server, ['--data-dir', join(directory, 'data'), '--host', '127.0.0.1',
    '--port', String(port)], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, WABI_UPLOADS_DIR: join(directory, 'uploads'),
    WABI_LOG_DIR: join(directory, 'logs'), WABI_LORE_ENABLED: 'false', WABI_MESH_ENABLED: 'false',
  } });
  const log = createWriteStream(join(directory, 'process.log'), { mode: 0o600 });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const exited = new Promise(done => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', () => done({ code: -1, signal: null }));
  });
  const instance = { child, exited, directory, origin: `http://127.0.0.1:${port}`, log };
  children.add(instance);
  for (let attempt = 0; attempt < 300; attempt++) {
    deadline.throwIfAborted();
    assert.equal(child.exitCode, null, 'fixture server stopped during startup');
    try {
      if ((await fetch(instance.origin + '/readyz', {
        signal: AbortSignal.any([deadline, AbortSignal.timeout(1000)]) })).ok) return instance;
    } catch { /* readiness has its own bounded attempts */ }
    await pause(100);
  }
  throw new Error('fixture startup deadline');
}
async function stop(instance, clean = true) {
  if (instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGTERM');
  const timer = setTimeout(() => instance.child.kill('SIGKILL'), 10_000);
  let outcome;
  try { outcome = await instance.exited; } finally { clearTimeout(timer); instance.log.end(); }
  children.delete(instance);
  if (clean) assert.equal(outcome.code, 0, 'fixture requires clean shutdown');
}
async function request(instance, path, { token, method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(instance.origin + path, { method,
    redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  if (status === 'success') assert.ok(response.ok, 'fixture request failed');
  else assert.equal(response.status, status, 'fixture HTTP status');
  return response;
}
async function api(instance, path, options) { return (await request(instance, path, options)).json(); }

try {
  const hashes = { serverSha256: await sha(server), snapshotSha256: await sha(snapshot) };
  receipt.artifact = hashes;
  stage = 'source-fixture';
  const source = await start('source');
  stage = 'source-owner-registration';
  const owner = await api(source, '/api/auth/register', { method: 'POST', status: 'success',
    body: { username: 'core_owner', password: 'Disposable-Core-Rehearsal-Only!' } });
  stage = 'source-second-registration';
  const denied = await api(source, '/api/auth/register', { method: 'POST', status: 'success',
    body: { username: 'core_denied', password: 'Disposable-Denied-Rehearsal-Only!' } });
  stage = 'source-channel';
  const channel = await api(source, '/api/channels', { method: 'POST', token: owner.accessToken,
    status: 'success', body: { name: 'core-recovery', channel_type: 'text' } });
  const channelId = channel.id ?? channel.channel?.id;
  assert.ok(channelId);
  stage = 'source-retention';
  await api(source, `/api/channels/${channelId}/retention`, { method: 'PUT', token: owner.accessToken,
    body: { retention: 'forever' } });
  const post = (instance, content) => api(instance, '/api/messages', { method: 'POST',
    status: 'success', token: owner.accessToken, body: { channel_id: channelId, content, message_type: 'text' } });
  stage = 'source-message';
  const retained = await post(source, 'retained stopped-core fixture');
  const fileBytes = Buffer.from('stopped core attachment 文');
  stage = 'source-upload';
  const upload = await api(source, '/api/upload/resumable/init', { method: 'POST', status: 'success',
    token: owner.accessToken, body: { fileName: 'fixture.txt', fileSize: fileBytes.length,
      mimeType: 'text/plain', channelId } });
  const chunk = await fetch(`${source.origin}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(upload.uploadId)}&offset=0`, {
    method: 'PUT', signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
    headers: { Authorization: `Bearer ${owner.accessToken}`, 'x-upload-token': upload.uploadToken,
      'Content-Type': 'application/octet-stream' }, body: fileBytes });
  assert.ok(chunk.ok);
  const completed = await api(source, '/api/upload/resumable/complete', { method: 'POST',
    status: 'success', token: owner.accessToken, body: { uploadId: upload.uploadId, uploadToken: upload.uploadToken } });
  assert.ok(completed.fileUrl?.startsWith('/uploads/'));
  stage = 'source-session-denial';
  await api(source, '/api/auth/logout', { method: 'POST', token: denied.accessToken });
  await request(source, '/api/user/me', { token: denied.accessToken, status: 401 });
  await stop(source);
  // Unknown files and empty directories must survive the whole-tree archive.
  await mkdir(join(source.directory, 'data/unknown/empty'), { recursive: true });
  await writeFile(join(source.directory, 'data/unknown/state'), 'private synthetic state', { mode: 0o600 });
  stage = 'encrypted-stopped-export-restore';
  const identity = join(scratch, 'identity.txt'), archive = join(scratch, 'core.age');
  const { stdout } = await command(snapshot, ['keygen', '--identity-file', identity]);
  const recipient = /^Recipient: (\S+)$/m.exec(stdout)?.[1];
  assert.ok(recipient);
  await command(snapshot, ['export', '--data-dir', join(source.directory, 'data'),
    '--uploads-dir', join(source.directory, 'uploads'), '--recipient', recipient, '--output', archive]);
  const restoredRoot = join(scratch, 'restored');
  await command(snapshot, ['restore', '--input', archive, '--identity-file', identity,
    '--target-root', restoredRoot, '--expected-sha256', await sha(archive), '--max-bytes', String(64 * 1024 * 1024)]);
  stage = 'complete-stopped-comparison';
  receipt.stoppedComparison = await auditCopy(source.directory, restoredRoot);
  stage = 'clean-replay-reads';
  let restored = await start('restored');
  async function verify(instance, additional = null) {
    const me = await api(instance, '/api/user/me', { token: owner.accessToken });
    assert.equal(String(me.userId), String(owner.user.id));
    assert.equal(me.isOwner, true);
    const history = await api(instance, `/api/messages/${channelId}`, { token: owner.accessToken });
    assert.ok(history.messages.some(message => message.id === retained.id));
    if (additional) assert.ok(history.messages.some(message => message.id === additional.id));
    const policy = await api(instance, `/api/channels/${channelId}/retention`, { token: owner.accessToken });
    assert.ok(policy.epochs?.some(epoch => epoch.label === 'forever'));
    await request(instance, '/api/user/me', { token: denied.accessToken, status: 401 });
    const attachment = await request(instance, completed.fileUrl, { token: owner.accessToken });
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), fileBytes);
    assert.equal(await readFile(join(instance.directory, 'data/unknown/state'), 'utf8'), 'private synthetic state');
  }
  await verify(restored);
  receipt.engineReplayTested = true;
  receipt.accountAndOwnerReadsPreserved = true;
  receipt.retainedMessageIdentityPreserved = true;
  receipt.retentionPolicyPreserved = true;
  receipt.revokedSessionStillDenied = true;
  receipt.uploadBytesPreserved = true;
  stage = 'post-restore-write-restart';
  const later = await post(restored, 'write only on replacement; source remains stopped');
  await stop(restored);
  restored = await start('restored');
  await verify(restored, later);
  await stop(restored);
  receipt.postRestoreWriteReplayTested = true;
  receipt.sourceRestartedAfterRestore = false;
  stage = 'artifact-readback';
  assert.equal(await sha(server), hashes.serverSha256);
  assert.equal(await sha(snapshot), hashes.snapshotSha256);
  receipt.result = 'PASS';
} catch (error) {
  receipt.failureStage = stage;
  if (typeof error.actual === 'number') receipt.observedFailureStatus = error.actual;
  if (typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)) receipt.failureCode = error.code;
} finally {
  const stopped = await Promise.allSettled([...children].map(instance => stop(instance, false)));
  const allStopped = stopped.every(value => value.status === 'fulfilled');
  if (allStopped) await rm(scratch, { recursive: true });
  receipt.cleanup = { ownedProcessesStopped: allStopped, ownedScratchRemoved: allStopped };
  if (!allStopped) receipt.result = 'FAIL';
}
receipt.recordedAtUtc = new Date().toISOString();
console.log(JSON.stringify(receipt));
process.exitCode = receipt.result === 'PASS' ? 0 : 1;
