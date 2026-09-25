// Disposable stopped-copy restore rehearsal. Never opens an operator data directory.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const binaryArgument = process.argv.indexOf('--binary');
assert.ok(binaryArgument > 0 && process.argv[binaryArgument + 1], 'Usage: node scripts/authority-retention-smoke.mjs --binary /absolute/wabi-server');
const binary = resolve(process.argv[binaryArgument + 1]);
const scratch = await mkdtemp('/tmp/wabi-retention-runtime-');
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

try {
    let instance = await start('instance');
    const account = await api(instance, '/api/auth/register', 'POST', { username: 'retention_fixture', password: 'Disposable-Retention-2026!' });
    const channel = await api(instance, '/api/channels', 'POST', { name: 'timed-retention', channel_type: 'text' }, account.accessToken);
    const channelId = channel.id ?? channel.channel?.id;
    await api(instance, `/api/channels/${channelId}/retention`, 'PUT', { retention: 'forever' }, account.accessToken);
    const old = await api(instance, '/api/messages', 'POST', { channel_id: channelId, content: 'forever-history-canary', message_type: 'text' }, account.accessToken);
    await api(instance, `/api/channels/${channelId}/retention`, 'PUT', { retention: '5s' }, account.accessToken);
    const file = await upload(instance, account.accessToken, channelId, 'retained-upload-canary', 'retention.txt');
    const sent = await api(instance, '/api/messages', 'POST', { channel_id: channelId, content: 'timed-message-canary', message_type: 'text' }, account.accessToken);
    await api(instance, `/api/channels/${channelId}/retention`, 'PUT', { retention: '1h' }, account.accessToken);
    const long = await api(instance, '/api/messages', 'POST', { channel_id: channelId, content: 'long-history-canary', message_type: 'text' }, account.accessToken);
    const history = async () => (await api(instance, `/api/messages/${channelId}`, 'GET', undefined, account.accessToken)).messages;
    assert.ok((await history()).some(message => message.id === sent.id));
    const liveDeadline = Date.now() + 9000;
    while ((await history()).some(message => message.id === sent.id)) {
        assert.ok(Date.now() < liveDeadline, '5s message expires within 9 seconds without a restart');
        await pause(250);
    }
    assert.ok((await history()).some(message => message.id === old.id), 'forever history survives a later 5s policy');
    assert.ok((await history()).some(message => message.id === long.id), 'later 1h history survives the old 5s epoch');
    // Exercise exact-policy hydration too, including an unexpired message
    // carried through restart instead of a fresh process-only timer.
    await api(instance, `/api/channels/${channelId}/retention`, 'PUT', { retention: '5s' }, account.accessToken);
    const restartSent = await api(instance, '/api/messages', 'POST', { channel_id: channelId, content: 'restart-retention-canary', message_type: 'text' }, account.accessToken);
    assert.ok((await history()).some(message => message.id === restartSent.id));
    await stop(instance);
    instance = await start('instance');
    const policy = await api(instance, `/api/privacy/channels/${channelId}`, 'GET', undefined, account.accessToken);
    assert.equal(policy.retention, '5s');
    const deadline = Date.now() + 9000;
    while ((await history()).some(message => message.id === restartSent.id)) {
        assert.ok(Date.now() < deadline, 'restart preserves the 5s deadline within 9 seconds');
        await pause(250);
    }
    assert.ok((await history()).some(message => message.id === old.id));
    assert.ok((await history()).some(message => message.id === long.id));
    const timeline = await api(instance, `/api/channels/${channelId}/retention`, 'GET', undefined, account.accessToken);
    assert.equal(timeline.epochs[0].label, 'forever');
    assert.deepEqual(timeline.epochs.map(epoch => epoch.label).slice(-2), ['1h', '5s']);
    const download = await fetch(instance.origin + file.url, { headers: { Authorization: `Bearer ${account.accessToken}` } });
    assert.ok(download.ok, 'uploaded file has an independent lifecycle');
    assert.equal(hash(Buffer.from(await download.arrayBuffer())), file.sha256);
    await stop(instance);
    instance = await start('instance');
    assert.ok(!(await history()).some(message => message.id === sent.id || message.id === restartSent.id), 'expired messages do not return after restart');
    const finalHistory = await history();
    assert.ok(finalHistory.some(message => message.id === old.id), 'forever history survives another restart');
    assert.ok(finalHistory.some(message => message.id === long.id), 'one-hour history survives another restart');
    const bot = await api(instance, '/api/bot/create', 'POST', { username: 'retention_bot' }, account.accessToken);
    await api(instance, `/api/channels/${channelId}/retention`, 'PUT', { retention: 'live' }, account.accessToken);
    const botLiveSend = await fetch(`${instance.origin}/api/bot/send-message`, {
        method: 'POST',
        headers: { Authorization: `Bot ${bot.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, content: 'bot-live-storage-canary' }),
    });
    assert.equal(botLiveSend.status, 400, 'durable bot endpoint rejects Live rooms');
    assert.match(JSON.stringify(await botLiveSend.json()), /Live rooms/, 'Live rejection explains the storage boundary');
    assert.ok(!(await history()).some(message => message.content === 'bot-live-storage-canary'), 'rejected bot message never enters history');
    await stop(instance);
    const logs = [
        ...(await readdir(instance.root)).filter(name => name.startsWith('process-')).map(name => `${instance.root}/${name}`),
        ...(await readdir(`${instance.root}/logs`)).map(name => `${instance.root}/logs/${name}`),
    ];
    for (const path of logs) {
        const bytes = await readFile(path);
        assert.ok(!bytes.includes(Buffer.from('forever-history-canary')) && !bytes.includes(Buffer.from('timed-message-canary')) && !bytes.includes(Buffer.from('long-history-canary')) && !bytes.includes(Buffer.from('restart-retention-canary')) && !bytes.includes(Buffer.from('retained-upload-canary')) && !bytes.includes(Buffer.from('bot-live-storage-canary')), 'default logs do not contain fixture bodies');
    }
    const report = { status: 'passed', binarySha256, defaultLogsExcludeCanaryBodies: true, exactPolicySurvivesRestart: true, shortTimerExpiresWithinNineSeconds: true, futureOnlyPolicySurvivesRepeatedChanges: true, realSweepRemovesNormalHistory: true, deletionSurvivesRestart: true, uploadedFileRemains: true, liveBotDurableSendRejected: true,
        limits: ['Disposable data only', 'Uploaded file is separate from the text message', 'No report-evidence, browser cache, external backup or secure-erasure certification'] };
    await writeFile(`${scratch}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`PASS real timed retention, exact policy, restarts, Live bot rejection and independent upload lifecycle; report ${scratch}/report.json`);
} finally {
    for (const child of children) child.kill('SIGTERM');
}
