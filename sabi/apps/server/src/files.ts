/**
 * Content-addressed blob store on the local filesystem: <dataDir>/files/ab/cdef….
 * Metadata lives in the journal (file.attached); blobs are immutable, so
 * backups can copy the directory incrementally.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_FILE_BYTES = Number(process.env.SABI_MAX_FILE_MB ?? 25) * 1024 * 1024;

export function blobPath(dataDir: string, sha256: string): string {
  return join(dataDir, 'files', sha256.slice(0, 2), sha256.slice(2));
}

export function storeBlob(dataDir: string, data: Buffer): string {
  const sha = createHash('sha256').update(data).digest('hex');
  const p = blobPath(dataDir, sha);
  if (!existsSync(p)) {
    mkdirSync(join(dataDir, 'files', sha.slice(0, 2)), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, p);
  }
  return sha;
}

export function openBlob(dataDir: string, sha256: string) {
  const p = blobPath(dataDir, sha256);
  if (!existsSync(p)) return null;
  return { size: statSync(p).size, stream: () => createReadStream(p) };
}
