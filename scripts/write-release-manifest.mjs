// Record artifact bytes, not host paths or runtime configuration.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const argument = name => { const index = process.argv.indexOf(name); assert.ok(index >= 0 && process.argv[index + 1], `Missing ${name}`); return resolve(process.argv[index + 1]); };
const binary = argument('--binary'), frontend = argument('--frontend'), output = argument('--output');
assert.ok(output !== binary && !output.startsWith(frontend + '/'), 'Manifest must be separate from the files it describes');
const revision = process.env.WABI_SOURCE_REVISION;
assert.match(revision || '', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, 'Release manifests require WABI_SOURCE_REVISION');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const client = JSON.parse(await readFile(`${frontend}/wabi-client-build.json`, 'utf8'));
assert.equal(client.sourceRevision, revision, 'Frontend was built from the expected source revision');
const versionDirectory = await mkdtemp(`${tmpdir()}/wabi-version-`);
const versionResult = spawnSync(binary, ['--build-info'], { cwd: versionDirectory, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000 });
const sideEffects = await readdir(versionDirectory);
await rm(versionDirectory, { recursive: true });
assert.deepEqual(sideEffects, [], 'Build identity must not open runtime state or logs');
assert.equal(versionResult.status, 0, 'Server build identity command succeeds');
const server = JSON.parse(versionResult.stdout);
assert.equal(server.component, 'wabi-server');
assert.equal(server.sourceRevision, revision, 'Server was built from the expected revision');
assert.equal(server.profile, 'release', 'Release manifest requires a release binary');
const files = [];
async function visit(relative = '') {
	for (const entry of await readdir(`${frontend}/${relative}`, { withFileTypes: true })) {
		const name = relative ? `${relative}/${entry.name}` : entry.name;
		assert.ok(!entry.isSymbolicLink(), 'Frontend artifact must not contain symbolic links');
		if (entry.isDirectory()) await visit(name);
		else if (entry.isFile()) files.push({ name, sha256: hash(await readFile(`${frontend}/${name}`)), bytes: (await stat(`${frontend}/${name}`)).size });
	}
}
await visit(); files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
assert.ok(files.some(file => file.name === 'index.html'), 'Frontend is an embedded static SPA');
const manifest = {
	schemaVersion: 1,
	sourceRevision: revision,
	server: { ...server, file: basename(binary), sha256: hash(await readFile(binary)), bytes: (await stat(binary)).size },
	client: { ...client, treeSha256: hash(files.map(file => `${file.name}\0${file.sha256}\n`).join('')), fileCount: files.length, files }
};
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote release manifest for ${revision.slice(0, 12)} (${files.length} frontend files)`);
