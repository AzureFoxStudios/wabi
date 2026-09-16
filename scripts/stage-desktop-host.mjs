#!/usr/bin/env node
/** Stage an already-built Authority for an explicitly selected desktop bundle.
 * Build-time tool only. Never downloads or executes the input binary.
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const TARGETS = Object.freeze({
  'x86_64-unknown-linux-gnu': { format: 'elf', machine: 62, suffix: '' },
  'aarch64-unknown-linux-gnu': { format: 'elf', machine: 183, suffix: '' },
  'x86_64-pc-windows-msvc': { format: 'pe', machine: 0x8664, suffix: '.exe' },
  'aarch64-pc-windows-msvc': { format: 'pe', machine: 0xaa64, suffix: '.exe' }
});

/** Check file format and CPU, not provenance or runtime compatibility. */
export function validateBinaryHeader(header, target) {
  const expected = TARGETS[target];
  if (!expected) throw new Error(`Unsupported hosting target: ${target}`);
  if (!Buffer.isBuffer(header)) throw new TypeError('Binary header must be a Buffer');
  if (expected.format === 'elf') {
    if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) {
      throw new Error('Expected a Linux ELF executable');
    }
    if (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== expected.machine) {
      throw new Error(`Wrong binary architecture for ${target}`);
    }
  } else {
    if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('Expected a Windows PE executable');
    }
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset + 6 > header.length || header.readUInt32LE(offset) !== 0x00004550) {
      throw new Error('Missing or invalid PE header in the first 64 KiB');
    }
    if (header.readUInt16LE(offset + 4) !== expected.machine) {
      throw new Error(`Wrong binary architecture for ${target}`);
    }
  }
  return expected;
}

export async function stageBinary({ binary, target, repositoryRoot, overwrite = false }) {
  if (!TARGETS[target]) throw new Error(`Unsupported hosting target: ${target}`);
  const source = resolve(binary);
  const metadata = await stat(source);
  if (!metadata.isFile()) throw new Error('Authority input must be a regular file');
  const file = await open(source, 'r');
  const header = Buffer.alloc(65536);
  let bytesRead;
  try {
    ({ bytesRead } = await file.read(header, 0, header.length, 0));
  } finally {
    await file.close();
  }
  const expected = validateBinaryHeader(header.subarray(0, bytesRead), target);
  const directory = join(resolve(repositoryRoot), 'src-tauri', 'binaries');
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `wabi-server-${target}${expected.suffix}`);
  if (source === destination) throw new Error('Input must not be the staging destination');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (expected.format === 'elf') await chmod(temporary, 0o755);
    if (overwrite) {
      await rename(temporary, destination);
    } else {
      // COPYFILE_EXCL also closes the race between an existence check and write.
      await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

async function main(args) {
  let target;
  let binary;
  let overwrite = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--target') target = args[++index];
    else if (arg === '--binary') binary = args[++index];
    else if (arg === '--overwrite') overwrite = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!target || !binary) {
    throw new Error('Usage: node scripts/stage-desktop-host.mjs --target TARGET --binary PATH [--overwrite]');
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const destination = await stageBinary({ binary, target, repositoryRoot, overwrite });
  console.log(`Staged Authority: ${destination}`);
  console.log('Use the opt-in tauri.hosting.conf.json overlay. Host UI and end-to-end validation are separate work.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Cannot stage desktop Authority: ${error.message}`);
    process.exitCode = 1;
  });
}
