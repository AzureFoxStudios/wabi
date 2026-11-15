// Version a CI build reports to the desktop updater.
// Tagged releases keep the version in tauri.conf.json. Builds from `main`
// replace the patch number with the workflow run number, so each push is
// newer than the last (the updater only installs a greater version).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const [major, minor] = config.version.split('.');
const run = process.argv[2];
if (!run) { console.log(config.version); process.exit(0); }
// Windows installers cap each version part at 65535.
assert.match(run, /^[1-9]\d{0,4}$/, 'Run number must be 1-65535');
assert.ok(Number(run) <= 65535, 'Run number must be 1-65535');
console.log(`${major}.${minor}.${run}`);
