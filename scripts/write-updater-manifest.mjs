// Write the static manifest the desktop updater reads (Tauri "latest.json").
// Inputs are the signed installers and their .sig files exactly as built;
// nothing is rebuilt or re-signed here.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';

const arg = (name, fallback) => {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) { assert.ok(fallback !== undefined, `Missing ${name}`); return fallback; }
	return process.argv[index + 1];
};
const artifacts = resolve(arg('--artifacts')), output = resolve(arg('--output'));
const baseUrl = arg('--base-url').replace(/\/+$/, ''), version = arg('--version'), notes = arg('--notes', '');
assert.match(version, /^\d+\.\d+\.\d+$/, 'Version must be plain MAJOR.MINOR.PATCH');
assert.match(baseUrl, /^https?:\/\//, 'Base URL must be absolute');

// The updater looks for `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
// The bare key serves installs that cannot tell how they were packaged.
const targets = [
	[/\.AppImage$/, ['linux-x86_64-appimage', 'linux-x86_64']],
	[/\.deb$/, ['linux-x86_64-deb']],
	[/\.rpm$/, ['linux-x86_64-rpm']],
	[/-setup\.exe$/, ['windows-x86_64-nsis', 'windows-x86_64']],
	[/\.msi$/, ['windows-x86_64-msi']],
	// One universal macOS build serves both architectures.
	[/\.app\.tar\.gz$/, ['darwin-aarch64', 'darwin-x86_64']],
];
const signed = [];
async function collect(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		assert.ok(!entry.isSymbolicLink(), 'Updater artifacts must not contain symbolic links');
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await collect(path);
		else if (entry.isFile() && entry.name.endsWith('.sig')) signed.push(path.slice(0, -'.sig'.length));
	}
}
await collect(artifacts);
const platforms = {};
await mkdir(output, { recursive: true });
for (const path of signed.sort()) {
	const name = basename(path);
	const match = targets.find(([pattern]) => pattern.test(name));
	if (!match) continue;
	assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/, `Unsafe updater asset name: ${name}`);
	const signature = (await readFile(`${path}.sig`, 'utf8')).trim();
	assert.ok(signature.length > 0, `Empty signature for ${name}`);
	for (const key of match[1]) {
		assert.ok(!(key in platforms), `Two installers claim ${key}`);
		platforms[key] = { signature, url: `${baseUrl}/${name}` };
	}
	await copyFile(path, join(output, name));
}
assert.ok(Object.keys(platforms).length > 0, 'No signed installers found');
const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
await writeFile(join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updater manifest ${version}: ${Object.keys(platforms).sort().join(', ')}`);
