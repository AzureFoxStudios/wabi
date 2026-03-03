#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';

function usage() {
	console.log(`Usage: node scripts/state-plane-backup.mjs [options]

Options:
  --data-dir <path>       Source DATA_DIR (default: ./data)
  --backup-root <path>    Backup root dir (default: ./backups)
  --no-verify             Skip NDJSON parse verification
  -h, --help              Show help
`);
}

function parseArgs(argv) {
	const options = {
		dataDir: resolve(process.cwd(), process.env.WABI_DATA_DIR || 'data'),
		backupRoot: resolve(process.cwd(), 'backups'),
		verify: true
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--no-verify') {
			options.verify = false;
			continue;
		}
		if (arg === '--data-dir') {
			i += 1;
			if (i >= argv.length) throw new Error('--data-dir requires a value');
			options.dataDir = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--backup-root') {
			i += 1;
			if (i >= argv.length) throw new Error('--backup-root requires a value');
			options.backupRoot = resolve(process.cwd(), argv[i]);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function utcStamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function sha256File(path) {
	const hash = createHash('sha256');
	hash.update(readFileSync(path));
	return hash.digest('hex');
}

function verifyNdjson(path) {
	const text = readFileSync(path, 'utf8');
	const lines = text.split('\n');
	let parseErrors = 0;
	let records = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i].trim();
		if (!raw) continue;
		try {
			JSON.parse(raw);
			records += 1;
		} catch {
			parseErrors += 1;
		}
	}
	return { records, parseErrors };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const sourceFiles = [
		'state-plane-outbox.ndjson',
		'state-plane-shadow-applied.ndjson',
		'state-plane-shadow-deadletter.ndjson',
		'state-plane-shadow.offset',
		'state-plane-schema-version.json',
		'state-plane-reducer-ingest.ndjson'
	];

	const backupDir = join(options.backupRoot, `state-plane-${utcStamp()}`);
	mkdirSync(backupDir, { recursive: true });

	const manifest = {
		createdAt: new Date().toISOString(),
		dataDir: options.dataDir,
		backupDir,
		verifyNdjson: options.verify,
		files: []
	};

	let totalSizeBytes = 0;
	let totalParseErrors = 0;
	let copied = 0;

	for (const name of sourceFiles) {
		const sourcePath = join(options.dataDir, name);
		if (!existsSync(sourcePath)) continue;
		const destPath = join(backupDir, name);
		cpSync(sourcePath, destPath, { force: true });
		copied += 1;

		const stat = statSync(destPath);
		totalSizeBytes += stat.size;
		const entry = {
			name,
			sizeBytes: stat.size,
			sha256: sha256File(destPath)
		};

		if (options.verify && name.endsWith('.ndjson')) {
			const verified = verifyNdjson(destPath);
			entry.records = verified.records;
			entry.parseErrors = verified.parseErrors;
			totalParseErrors += verified.parseErrors;
		}

		manifest.files.push(entry);
	}

	manifest.totalFiles = copied;
	manifest.totalSizeBytes = totalSizeBytes;
	manifest.totalParseErrors = totalParseErrors;

	const manifestPath = join(backupDir, 'manifest.json');
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	console.log('[state-plane-backup] Backup created');
	console.log(`  backupDir=${backupDir}`);
	console.log(`  files=${copied}`);
	console.log(`  totalSizeBytes=${totalSizeBytes}`);
	console.log(`  parseErrors=${totalParseErrors}`);
	console.log(`  manifest=${manifestPath}`);

	if (copied === 0) {
		console.warn('[state-plane-backup] No state-plane files found to back up');
	}

	if (totalParseErrors > 0) {
		console.error('[state-plane-backup] NDJSON integrity verification failed');
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error('[state-plane-backup] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
