#!/usr/bin/env node
/** Build-time evidence, NOT a signing system or proof of physical acceptance. */
import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateBinaryHeader } from './stage-desktop-host.mjs';

async function inspect(path, target, role) {
  const name = resolve(path);
  const before = await lstat(name, { bigint: true });
  if (!before.isFile() || before.size === 0n) throw new Error(`${role} must be a nonempty regular file, not a symlink`);
  const handle = await open(name, 'r');
  try {
    const header = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    validateBinaryHeader(header.subarray(0, bytesRead), target);
  } finally { await handle.close(); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(name)) hash.update(chunk);
  const after = await lstat(name, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) {
    throw new Error(`${role} changed while being hashed`);
  }
  return { role, file: basename(name), bytes: Number(after.size), sha256: hash.digest('hex') };
}
export async function buildEvidence({ revision, target, installer, server, desktop }) {
  if (!/^[a-f0-9]{40}$/i.test(revision ?? '')) throw new Error('A complete 40-character source commit is required');
  if (!['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'].includes(target)) throw new Error('Unsupported test-package target');
  if (![installer, server, desktop].every(value => typeof value === 'string' && value.length)) throw new Error('Installer, server and desktop paths are required');
  if (new Set([installer, server, desktop].map(path => resolve(path))).size !== 3) throw new Error('Each artifact role must refer to a different file');
  const suffix = target.includes('windows') ? /\.exe$/i : /\.AppImage$/;
  if (!suffix.test(installer)) throw new Error('Expected a platform installer, not only a raw executable');
  const artifacts = [];
  for (const [role, path] of Object.entries({ installer, server, desktop })) artifacts.push(await inspect(path, target, role));
  if (new Set(artifacts.map(a => a.sha256)).size !== 3) throw new Error('Artifact roles must not contain identical executables');
  return { schemaVersion: 1, sourceRevision: revision.toLowerCase(), target,
    productName: 'Wabi Host Test', applicationIdentifier: 'chat.wabi.hosttest', artifacts,
    evidenceLimits: 'Hashes identify bytes; they do not certify signatures, ABI compatibility, source provenance or installation. The CI checkout supplies the revision.',
    acceptance: { cleanInstall: 'not-run', freshPrivateInvitation: 'blocked-incomplete-transport', physicalMedia: 'not-run', nativeRestore: 'not-run' } };
}
export async function writeEvidence(path, evidence) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(evidence, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function main(args) {
  const values = {}; const allowed = new Set(['revision', 'target', 'installer', 'server', 'desktop', 'output']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key) || values[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid or duplicate evidence argument');
    values[key] = args[i + 1];
  }
  if (!values.output) throw new Error('--output is required');
  const evidence = await buildEvidence(values); await writeEvidence(values.output, evidence);
  console.log(`Wrote ${values.output}; physical acceptance is NOT certified.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
