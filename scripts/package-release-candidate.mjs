// Package the checked artifacts; never rebuild or replace their identity here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, copyFile, chmod, mkdtemp, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const arg = name => { const index = process.argv.indexOf(name); assert.ok(index >= 0 && process.argv[index + 1], `Missing ${name}`); return resolve(process.argv[index + 1]); };
const artifacts = arg('--artifacts'), output = arg('--output');
assert.ok(output !== artifacts && !output.startsWith(artifacts + '/'), 'Output must be separate from inputs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const serverDir = join(artifacts, 'wabi-server');
const manifestPath = join(serverDir, 'wabi-release-manifest.json');
const binaryPath = join(serverDir, 'wabi-server');
for (const path of [manifestPath, binaryPath]) assert.ok((await lstat(path)).isFile(), 'Server inputs must be regular files');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.match(process.env.WABI_SOURCE_REVISION || '', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
assert.equal(manifest.sourceRevision, process.env.WABI_SOURCE_REVISION);
assert.equal(manifest.server.sourceRevision, manifest.sourceRevision);
assert.equal(manifest.client.sourceRevision, manifest.sourceRevision);
assert.equal(manifest.server.profile, 'release');
assert.equal(manifest.server.component, 'wabi-server');
assert.equal(manifest.server.file, 'wabi-server');
assert.match(manifest.server.targetOs, /^[a-z0-9_]+$/);
assert.match(manifest.server.targetArch, /^[a-z0-9_]+$/);
const binary = await readFile(binaryPath);
assert.equal(sha(binary), manifest.server.sha256, 'Downloaded binary matches its checked manifest');
assert.equal(binary.length, manifest.server.bytes);
const files = new Map();
async function collect(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		assert.ok(!entry.isSymbolicLink(), 'Installer artifacts must not contain symbolic links');
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await collect(path);
		else if (entry.isFile() && /\.(deb|rpm|AppImage|msi|exe|dmg)$/.test(entry.name)) {
			assert.match(entry.name, /^[A-Za-z0-9][A-Za-z0-9._ +()-]*$/, 'Installer name must be safe in checksums and release assets');
			assert.ok(!files.has(entry.name), `Duplicate installer basename: ${entry.name}`);
			files.set(entry.name, path);
		}
	}
}
for (const platform of ['linux', 'windows', 'macos']) {
	const before = files.size;
	await collect(join(artifacts, `wabi-desktop-${platform}`));
	assert.ok(files.size > before, `Missing ${platform} installer`);
}
await mkdir(output); // Do not overwrite a prior candidate directory.
const staging = await mkdtemp(join(tmpdir(), 'wabi-release-stage-'));
try {
	await copyFile(binaryPath, join(staging, 'wabi-server'));
	await chmod(join(staging, 'wabi-server'), 0o755);
	await copyFile(manifestPath, join(staging, 'wabi-release-manifest.json'));
	const archive = `wabi-server-${manifest.server.targetOs}-${manifest.server.targetArch}.tar.gz`;
	assert.ok(!files.has(archive));
	execFileSync('tar', ['-czf', join(output, archive), '-C', staging, 'wabi-server', 'wabi-release-manifest.json']);
	for (const [name, path] of files) await copyFile(path, join(output, name));
	const names = (await readdir(output)).sort();
	const checksums = await Promise.all(names.map(async name => `${sha(await readFile(join(output, name)))}  ${name}\n`));
	await writeFile(join(output, 'SHA256SUMS'), checksums.join(''));
	console.log(`Packaged ${names.length} checked candidate assets for ${manifest.sourceRevision.slice(0, 12)}`);
} finally { await rm(staging, { recursive: true, force: true }); }
