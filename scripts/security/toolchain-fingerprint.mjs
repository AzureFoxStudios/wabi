#!/usr/bin/env node
// Runtime toolchain fingerprint. Inserted immediately after every
// oven-sh/setup-bun step so a silently-different runner toolchain is loud.
//
// CVE-2026-111497 ("Node2Shell", Brotli OOB write -> RCE) is fixed in
// Node 22.23.4 / 24.22.1 / 26.12.1 and Bun 1.4.4. Anything older is a hard
// failure here, independently of the static lockfile gate.
//
//   node scripts/security/toolchain-fingerprint.mjs [--require-bun]

import { execFileSync } from 'node:child_process';

const BUN_FLOOR = [1, 4, 4];
const NODE_FIXED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
const requireBun = process.argv.includes('--require-bun');

function parse(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function fmt(v) { return v.join('.'); }
function probe(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }).trim(); }
  catch (e) { return null; }
}

const failures = [];
const nodeRaw = process.version;
const nodeV = parse(nodeRaw);
console.log(`node: ${nodeRaw} (${process.platform}/${process.arch})`);
if (!nodeV) {
  failures.push(`unparseable node version ${nodeRaw}`);
} else {
  const fixed = NODE_FIXED[nodeV[0]];
  if (!fixed) {
    failures.push(`node ${fmt(nodeV)} is EOL or has no Node2Shell patch line (want 22.23.4 / 24.22.1 / 26.12.1)`);
  } else if (cmp(nodeV, fixed) < 0) {
    failures.push(`node ${fmt(nodeV)} < ${fmt(fixed)} — CVE-2026-111497 unpatched`);
  }
}

const bunRaw = probe('bun', ['--version']);
if (bunRaw === null) {
  if (requireBun) failures.push('bun binary not found after oven-sh/setup-bun');
  else console.log('bun: not installed on this runner (no runtime floor to check)');
} else {
  const bunV = parse(bunRaw.split('-')[0]);
  console.log(`bun:  ${bunRaw}`);
  if (!bunV) failures.push(`unparseable bun version ${bunRaw}`);
  else if (cmp(bunV, BUN_FLOOR) < 0) failures.push(`bun ${fmt(bunV)} < ${fmt(BUN_FLOOR)} — CVE-2026-111497 unpatched`);
}

console.log(`toolchain: ${process.env.GITHUB_WORKFLOW ?? 'local'} / ${process.env.GITHUB_RUN_ID ?? 'n/a'} / ${process.env.GITHUB_SHA?.slice(0, 12) ?? 'n/a'}`);
if (failures.length) {
  for (const f of failures) console.error(`TOOLCHAIN FLOOR FAILURE: ${f}`);
  process.exit(1);
}
console.log('toolchain fingerprint: OK (Node2Shell floors satisfied)');
