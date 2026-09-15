// Disposable stopped-copy restore rehearsal. Never opens an operator data directory.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const binaryArgument = process.argv.indexOf('--binary');
assert.ok(binaryArgument > 0 && process.argv[binaryArgument + 1], 'Usage: node scripts/authority-backup-restore-smoke.mjs --binary /absolute/wabi-server');
const binary = resolve(process.argv[binaryArgument + 1]);
const scratch = await mkdtemp('/tmp/wabi-authority-restore-');
await chmod(scratch, 0o700);
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
const children = new Set();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(name) {
	const listener = net.createServer();
	await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
	const port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	const root = `${scratch}/${name}`;
	await mkdir(root, { recursive: true });
	const child = spawn(binary, ['--data-dir', `${root}/data`, '--host', '127.0.0.1', '--port', String(port)], {
		cwd: root, env: { PATH: process.env.PATH, WABI_UPLOADS_DIR: `${root}/uploads`, WABI_LOG_DIR: `${root}/logs` }, stdio: ['ignore', 'pipe', 'pipe']
	});
	const log = createWriteStream(`${root}/process-${Date.now()}.log`, { mode: 0o600 });
	child.stdout.pipe(log); child.stderr.pipe(log); children.add(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 300; attempt++) {
		if (child.exitCode !== null) throw new Error(`Authority exited before readiness; inspect ${root}`);
		try { if ((await fetch(`${origin}/readyz`)).ok) return { child, root, origin, log }; } catch { /* Starting. */ }
		await pause(100);
	}
	throw new Error(`Authority did not become ready: ${root}`);
}
async function stop(instance) {
	if (instance.child.exitCode === null) {
		instance.child.kill('SIGTERM');
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Authority did not stop; no snapshot was taken')), 15000);
			instance.child.once('exit', () => { clearTimeout(timeout); resolve(); });
		});
	}
	assert.equal(instance.child.exitCode, 0, 'clean shutdown before copying');
	children.delete(instance.child); instance.log.end();
}
async function api(instance, path, method = 'GET', body, token) {
	const response = await fetch(instance.origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
	assert.ok(response.ok, `${method} ${path}: ${response.status}`);
	return response.json();
}
async function upload(instance, token, channelId, text, fileName) {
	const bytes = Buffer.from(text);
	const session = await api(instance, '/api/upload/resumable/init', 'POST', { fileName, fileSize: bytes.length, mimeType: 'text/plain', channelId }, token);
	const chunk = await fetch(`${instance.origin}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=0`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'x-upload-token': session.uploadToken, 'Content-Type': 'application/octet-stream' }, body: bytes });
	assert.ok(chunk.ok, `upload chunk: ${chunk.status}`);
	const completed = await api(instance, '/api/upload/resumable/complete', 'POST', { uploadId: session.uploadId, uploadToken: session.uploadToken }, token);
	assert.ok(completed.fileUrl?.startsWith('/uploads/'), 'completed local upload URL');
	return { url: completed.fileUrl, sha256: hash(bytes) };
}
async function verify(instance, account, channelId, expected, absent, uploads) {
	const me = await api(instance, '/api/user/me', 'GET', undefined, account.accessToken);
	assert.equal(String(me.userId), String(account.user.id), 'original token and account survive');
	assert.equal(me.isOwner, true, 'owner privileges survive');
	const result = await api(instance, `/api/messages/${channelId}`, 'GET', undefined, account.accessToken);
	const messages = result.messages ?? result;
	for (const text of expected) assert.ok(messages.some(message => message.content === text || message.text === text), `restored message: ${text}`);
	for (const text of absent) assert.ok(!messages.some(message => message.content === text || message.text === text), 'snapshot does not include later writes');
	for (const file of uploads) {
		const response = await fetch(instance.origin + file.url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
		assert.ok(response.ok, `read completed upload: ${response.status}`);
		assert.equal(hash(Buffer.from(await response.arrayBuffer())), file.sha256);
	}
}
async function keyHashes(root) {
	return Promise.all(['data/jwt_secret', 'data/wabidb/root_key'].map(async path => hash(await readFile(`${root}/${path}`))));
}
try {
	let original = await start('source');
	const build = await api(original, '/api/public/build-info');
	assert.equal(build.component, 'wabi-server');
	if (process.env.WABI_SOURCE_REVISION) assert.equal(build.sourceRevision, process.env.WABI_SOURCE_REVISION);
	const credentials = { username: 'restore_fixture', password: 'Disposable-Restore-Fixture-2026!' };
	const account = await api(original, '/api/auth/register', 'POST', credentials);
	const channel = await api(original, '/api/channels', 'POST', { name: 'restore-fixture', channel_type: 'text' }, account.accessToken);
	const channelId = channel.id ?? channel.channel?.id;
	assert.ok(channelId, 'created channel identity');
	await api(original, `/api/channels/${channelId}/retention`, 'PUT', { retention: 'forever' }, account.accessToken);
	const post = (instance, content) => api(instance, '/api/messages', 'POST', { channel_id: channelId, content, message_type: 'text' }, account.accessToken);
	await post(original, 'Before snapshot');
	const firstUpload = await upload(original, account.accessToken, channelId, 'Original attachment\n文', 'before.txt');
	const keys = await keyHashes(original.root); // Must exist on the first-ever boot.
	await verify(original, account, channelId, ['Before snapshot'], [], [firstUpload]);
	await stop(original);
	await mkdir(`${scratch}/snapshot`);
	for (const path of ['data', 'uploads']) await cp(`${scratch}/source/${path}`, `${scratch}/snapshot/${path}`, { recursive: true, errorOnExist: true, force: false });
	original = await start('source');
	await verify(original, account, channelId, ['Before snapshot'], [], [firstUpload]);
	assert.deepEqual(await keyHashes(original.root), keys);
	await post(original, 'After snapshot');
	await stop(original);
	await cp(`${scratch}/snapshot`, `${scratch}/restored`, { recursive: true, errorOnExist: true, force: false });
	let restored = await start('restored');
	await verify(restored, account, channelId, ['Before snapshot'], ['After snapshot'], [firstUpload]);
	assert.deepEqual(await keyHashes(restored.root), keys);
	const login = await api(restored, '/api/auth/login', 'POST', credentials);
	assert.equal(String(login.user.id), String(account.user.id));
	await post(restored, 'Written after restore');
	const secondUpload = await upload(restored, account.accessToken, channelId, 'New attachment after restore', 'after.txt');
	await stop(restored);
	restored = await start('restored');
	await verify(restored, account, channelId, ['Before snapshot', 'Written after restore'], ['After snapshot'], [firstUpload, secondUpload]);
	assert.deepEqual(await keyHashes(restored.root), keys);
	await stop(restored);
	const report = { status: 'passed', binary, binarySha256, scratch, keyHashesStable: true, accountPreserved: true, oldAndNewMessages: true, oldAndNewUploads: true, snapshotIsolation: true, completedAt: new Date().toISOString(), limits: ['Disposable state only', 'Same binary before and after restore', 'No hosted-data copy, real host, proxy, optional service or in-progress upload acceptance'] };
	await writeFile(`${scratch}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
	console.log(`PASS: stopped Authority backup/restore/restart; report ${scratch}/report.json`);
} catch (error) {
	console.error(`Rehearsal failed; disposable evidence retained at ${scratch}`);
	throw error;
} finally {
	for (const child of children) child.kill('SIGTERM');
}
