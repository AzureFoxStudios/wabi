#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

function parseArgs(argv) {
	const args = {
		dir: 'uploads',
		maxFiles: 500,
		maxBytesPerFile: 8 * 1024 * 1024
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === '--dir' && argv[i + 1]) {
			args.dir = argv[i + 1];
			i += 1;
			continue;
		}
		if (token === '--max-files' && argv[i + 1]) {
			args.maxFiles = Number(argv[i + 1]) || args.maxFiles;
			i += 1;
			continue;
		}
		if (token === '--max-bytes' && argv[i + 1]) {
			args.maxBytesPerFile = Number(argv[i + 1]) || args.maxBytesPerFile;
			i += 1;
			continue;
		}
	}

	return args;
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function listFiles(dir, files = []) {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			listFiles(fullPath, files);
			continue;
		}
		files.push(fullPath);
	}
	return files;
}

function hrNowMs() {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

function summarizeByExtension(results) {
	const byExt = new Map();
	for (const row of results) {
		const key = row.ext;
		const current = byExt.get(key) || {
			ext: key,
			count: 0,
			originalBytes: 0,
			gzipBytes: 0,
			brotliBytes: 0
		};
		current.count += 1;
		current.originalBytes += row.originalBytes;
		current.gzipBytes += row.gzipBytes;
		current.brotliBytes += row.brotliBytes;
		byExt.set(key, current);
	}
	return Array.from(byExt.values())
		.map((row) => ({
			...row,
			gzipRatio: row.originalBytes > 0 ? row.gzipBytes / row.originalBytes : null,
			brotliRatio: row.originalBytes > 0 ? row.brotliBytes / row.originalBytes : null
		}))
		.sort((a, b) => b.originalBytes - a.originalBytes);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const startAt = hrNowMs();
	const allFiles = listFiles(args.dir);

	const results = [];
	let skippedBySize = 0;
	let scanned = 0;
	let gzipTimeMs = 0;
	let brotliTimeMs = 0;

	for (const path of allFiles) {
		if (results.length >= args.maxFiles) break;
		const stat = statSync(path);
		if (!stat.isFile()) continue;
		if (stat.size > args.maxBytesPerFile) {
			skippedBySize += 1;
			continue;
		}

		const src = readFileSync(path);
		const ext = (extname(path).toLowerCase().replace('.', '') || 'none');

		const gzipStart = hrNowMs();
		const gzip = gzipSync(src, { level: 6 });
		gzipTimeMs += hrNowMs() - gzipStart;

		const brotliStart = hrNowMs();
		const brotli = brotliCompressSync(src, {
			params: {
				[zlibConstants.BROTLI_PARAM_QUALITY]: 5
			}
		});
		brotliTimeMs += hrNowMs() - brotliStart;

		results.push({
			path,
			ext,
			originalBytes: src.length,
			gzipBytes: gzip.length,
			brotliBytes: brotli.length
		});
		scanned += 1;
	}

	const totalOriginal = results.reduce((sum, row) => sum + row.originalBytes, 0);
	const totalGzip = results.reduce((sum, row) => sum + row.gzipBytes, 0);
	const totalBrotli = results.reduce((sum, row) => sum + row.brotliBytes, 0);

	const report = {
		input: {
			dir: args.dir,
			discoveredFiles: allFiles.length,
			scannedFiles: scanned,
			maxFiles: args.maxFiles,
			maxBytesPerFile: args.maxBytesPerFile,
			skippedBySize
		},
		totals: {
			originalBytes: totalOriginal,
			gzipBytes: totalGzip,
			brotliBytes: totalBrotli,
			gzipRatio: totalOriginal > 0 ? totalGzip / totalOriginal : null,
			brotliRatio: totalOriginal > 0 ? totalBrotli / totalOriginal : null
		},
		timing: {
			totalMs: Number((hrNowMs() - startAt).toFixed(2)),
			gzipMs: Number(gzipTimeMs.toFixed(2)),
			brotliMs: Number(brotliTimeMs.toFixed(2))
		},
		byExtension: summarizeByExtension(results)
	};

	console.log('Compression Benchmark (Phase A)');
	console.log(`Corpus dir: ${report.input.dir}`);
	console.log(`Scanned files: ${report.input.scannedFiles}/${report.input.discoveredFiles} (skipped by size: ${report.input.skippedBySize})`);
	console.log(`Original: ${formatBytes(totalOriginal)}`);
	console.log(`Gzip:     ${formatBytes(totalGzip)} (${report.totals.gzipRatio !== null ? report.totals.gzipRatio.toFixed(3) : 'n/a'} ratio)`);
	console.log(`Brotli:   ${formatBytes(totalBrotli)} (${report.totals.brotliRatio !== null ? report.totals.brotliRatio.toFixed(3) : 'n/a'} ratio)`);
	console.log(`Timing:   total ${report.timing.totalMs}ms | gzip ${report.timing.gzipMs}ms | brotli ${report.timing.brotliMs}ms`);
	console.log('');
	console.log('Top extensions by total size:');
	for (const row of report.byExtension.slice(0, 12)) {
		console.log(
			`${row.ext.padEnd(8)} files=${String(row.count).padStart(4)} ` +
			`orig=${formatBytes(row.originalBytes).padStart(10)} ` +
			`gzip=${row.gzipRatio !== null ? row.gzipRatio.toFixed(3) : 'n/a'} ` +
			`brotli=${row.brotliRatio !== null ? row.brotliRatio.toFixed(3) : 'n/a'}`
		);
	}
	console.log('');
	console.log(JSON.stringify(report, null, 2));
}

main();
