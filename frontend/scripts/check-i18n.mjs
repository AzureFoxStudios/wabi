import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const localesDir = path.resolve(process.cwd(), 'src/lib/i18n/locales');
const baseLocale = 'en.json';

function flattenKeys(obj, prefix = '', out = new Set()) {
	for (const [key, value] of Object.entries(obj)) {
		const next = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			flattenKeys(value, next, out);
		} else {
			out.add(next);
		}
	}
	return out;
}

function diffKeys(base, candidate) {
	const missing = [];
	const extra = [];
	for (const key of base) {
		if (!candidate.has(key)) missing.push(key);
	}
	for (const key of candidate) {
		if (!base.has(key)) extra.push(key);
	}
	return { missing: missing.sort(), extra: extra.sort() };
}

async function readJson(filePath) {
	const raw = await readFile(filePath, 'utf8');
	return JSON.parse(raw);
}

async function main() {
	const files = (await readdir(localesDir))
		.filter((name) => name.endsWith('.json'))
		.sort();

	if (!files.includes(baseLocale)) {
		throw new Error(`Base locale ${baseLocale} not found in ${localesDir}`);
	}

	const basePath = path.join(localesDir, baseLocale);
	const baseKeys = flattenKeys(await readJson(basePath));

	let failed = false;

	for (const file of files) {
		if (file === baseLocale) continue;
		const currentPath = path.join(localesDir, file);
		const currentKeys = flattenKeys(await readJson(currentPath));
		const { missing, extra } = diffKeys(baseKeys, currentKeys);

		if (missing.length === 0 && extra.length === 0) {
			console.log(`[i18n] ${file}: OK`);
			continue;
		}

		failed = true;
		console.error(`[i18n] ${file}: key mismatch`);
		if (missing.length > 0) {
			console.error(`  missing (${missing.length}):`);
			for (const key of missing) console.error(`    - ${key}`);
		}
		if (extra.length > 0) {
			console.error(`  extra (${extra.length}):`);
			for (const key of extra) console.error(`    + ${key}`);
		}
	}

	if (failed) {
		process.exitCode = 1;
		return;
	}

	console.log('[i18n] All locale files match base keys.');
}

main().catch((error) => {
	console.error('[i18n] Check failed:', error.message);
	process.exit(1);
});
