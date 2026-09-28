#!/usr/bin/env node
// Build-time preparation: installers contain this Authority; users never run Cargo.
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { stageBinary } from './stage-desktop-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Usage: node scripts/build-desktop-host.mjs [--target TARGET]');
  const rustc = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' });
  if (rustc.error || rustc.status !== 0) throw new Error('The repository-pinned Rust toolchain is required to build desktop packages');
  const target = args[1] || rustc.stdout.match(/^host: (.+)$/m)?.[1];
  if (!target || !/^(x86_64|aarch64)-(unknown-linux-gnu|pc-windows-msvc|apple-darwin)$|^universal-apple-darwin$/.test(target)) throw new Error(`Unsupported desktop target: ${target}`);
  await access(join(root, 'frontend/build/index.html')).catch(() => { throw new Error('Build the static frontend first: cd frontend && npm run build:static'); });
  const architectures = target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target];
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR || 'target');
  const binaries = [];
  for (const architecture of architectures) {
    run('cargo', ['build', '--locked', '--release', '-p', 'wabi-server', '--target', architecture]);
    const binary = join(targetDirectory, architecture, 'release', architecture.includes('windows') ? 'wabi-server.exe' : 'wabi-server');
    binaries.push(binary);
    await stageBinary({ binary, target: architecture, repositoryRoot: root, overwrite: true });
  }
  if (target === 'universal-apple-darwin') {
    const binary = join(targetDirectory, 'wabi-server-universal');
    run('lipo', ['-create', ...binaries, '-output', binary]);
    run('lipo', [binary, '-verify_arch', 'arm64', 'x86_64']);
    await stageBinary({ binary, target, repositoryRoot: root, overwrite: true });
  }
  console.log(`Built and staged the bundled Authority for ${target}.`);
} catch (error) {
  console.error(`Desktop Authority preparation failed: ${error.message}`);
  process.exitCode = 1;
}
