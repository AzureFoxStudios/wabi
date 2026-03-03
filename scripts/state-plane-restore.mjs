#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';

function usage() {
	console.log(`Usage: node scripts/state-plane-restore.mjs --backup-dir <path> [options]

Options:
  --backup-dir <path>     Backup directory containing manifest.json
  --data-dir <path>       Destination DATA_DIR (default: ./data)
  --force                 Allow restore even when checksum validation fails
  -h, --help              Show help
`);
}

function sha256File(path) {
	const hash = createHash('sha256');
	hash.update(readFileSync(path));
	return hash.digest('hex');
}

function parseArgs(argv) {
	const options = {
		backupDir: null,
		dataDir: resolve(process.cwd(), process.env.WABI_DATA_DIR || 'data'),
		force: false
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--force') {
			options.force = true;
			continue;
		}
		if (arg === '--backup-dir') {
			i += 1;
			if (i >= argv.length) throw new Error('--backup-dir requires a value');
			options.backupDir = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--data-dir') {
			i += 1;
			if (i >= argv.length) throw new Error('--data-dir requires a value');
			options.dataDir = resolve(process.cwd(), argv[i]);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.backupDir) {
		throw new Error('Missing required --backup-dir');
	}

	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const manifestPath = join(options.backupDir, 'manifest.json');
	if (!existsSync(manifestPath)) {
		throw new Error(`Manifest not found: ${manifestPath}`);
	}

	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const files = Array.isArray(manifest.files) ? manifest.files : [];
	if (files.length === 0) {
		console.warn('[state-plane-restore] Manifest contains no files; nothing to restore');
		return;
	}

	mkdirSync(options.dataDir, { recursive: true });

	let checksumFailures = 0;
	let restored = 0;

	for (const file of files) {
		const name = String(file.name || '').trim();
		if (!name) continue;
		const expectedSha = String(file.sha256 || '').trim().toLowerCase();
		const backupPath = join(options.backupDir, name);
		if (!existsSync(backupPath)) {
			checksumFailures += 1;
			console.warn(`[state-plane-restore] Missing backup file: ${backupPath}`);
			continue;
		}

		if (expectedSha) {
			const actualSha = sha256File(backupPath);
			if (actualSha !== expectedSha) {
				checksumFailures += 1;
				console.warn(`[state-plane-restore] Checksum mismatch for ${name}`);
				if (!options.force) {
					continue;
				}
			}
		}

		const targetPath = join(options.dataDir, name);
		copyFileSync(backupPath, targetPath);
		restored += 1;

		const size = statSync(targetPath).size;
		console.log(`[state-plane-restore] Restored ${name} (${size} bytes)`);
	}

	console.log('[state-plane-restore] Restore summary');
	console.log(`  backupDir=${options.backupDir}`);
	console.log(`  dataDir=${options.dataDir}`);
	console.log(`  restored=${restored}`);
	console.log(`  checksumFailures=${checksumFailures}`);
	console.log(`  force=${options.force}`);

	if (checksumFailures > 0 && !options.force) {
		console.error('[state-plane-restore] Restore incomplete due to checksum failures; re-run with --force to override');
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error('[state-plane-restore] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
