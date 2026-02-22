#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const pluginName = process.argv[2] || 'model-viewer';
const sourceDir = path.join(rootDir, 'TEST', pluginName);
const destDir = path.join(rootDir, 'plugins', pluginName);
const sourceManifest = path.join(sourceDir, 'plugin.json');
const destManifest = path.join(destDir, 'plugin.json');

function fail(message) {
  console.error(`[plugin-install] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sourceDir)) {
  fail(`Test plugin not found: ${sourceDir}`);
}

if (!fs.existsSync(sourceManifest)) {
  fail(`Missing plugin.json in test plugin: ${sourceManifest}`);
}

console.log(`[plugin-install] Installing test plugin '${pluginName}'`);
console.log(`[plugin-install] Source: ${sourceDir}`);
console.log(`[plugin-install] Dest:   ${destDir}`);

fs.mkdirSync(path.join(rootDir, 'plugins'), { recursive: true });
fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(sourceDir, destDir, { recursive: true });

if (!fs.existsSync(destManifest)) {
  fail(`Install failed: destination plugin.json missing at ${destManifest}`);
}

const manifest = JSON.parse(fs.readFileSync(destManifest, 'utf8'));
console.log(`[plugin-install] Installed: id=${manifest.id} version=${manifest.version}`);
console.log('[plugin-install] Next: restart backend to load plugin.');
