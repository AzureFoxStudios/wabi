import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const forceStatic = process.argv.includes('--static');
const env = { ...process.env };

if (forceStatic) {
	env.STATIC_BUILD = '1';
}

if (!env.STATIC_BUILD) {
	console.log('');
	console.log('⚠️  STATIC_BUILD is unset. Default frontend build uses adapter-node (no index.html).');
	console.log('    For production / Docker / deploy, use: npm run build:static');
	console.log('    The static build (adapter-static) emits index.html for rust_embed.');
	console.log('');
	console.log('    Building with adapter-node anyway (for dev/SSR use). Set STATIC_BUILD=1 to silence.');
	console.log('');
}

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const viteCliPath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const result = spawnSync(process.execPath, [viteCliPath, 'build'], {
	cwd: appRoot,
	env,
	stdio: 'inherit'
});

if (result.error) {
	console.error('[build] Failed to start Vite build:', result.error);
	process.exit(1);
}

if (result.status !== 0) process.exit(result.status ?? 1);

if (env.STATIC_BUILD) {
	const output = join(appRoot, 'build');
	const immutable = join(output, '_app', 'immutable');
	const files = [];
	async function collect(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await collect(path);
			else if (entry.isFile()) files.push(`/${relative(output, path).split(sep).join('/')}`);
		}
	}
	await collect(immutable);
	files.sort();
	if (files.length === 0) throw new Error('[build] Static output has no immutable application assets');
	const swPath = join(output, 'sw.js');
	const sw = await readFile(swPath, 'utf8');
	const shell = await readFile(join(output, 'index.html'));
	const idMarker = "const BUILD_ID = 'unversioned';";
	const assetsMarker = 'const APP_PRECACHE_URLS = [];';
	if (!sw.includes(idMarker) || !sw.includes(assetsMarker)) {
		throw new Error('[build] Service worker precache markers are missing');
	}
	const buildId = createHash('sha256').update(shell).update(JSON.stringify(files)).update(sw).digest('hex').slice(0, 16);
	await writeFile(swPath, sw.replace(idMarker, `const BUILD_ID = '${buildId}';`).replace(assetsMarker, `const APP_PRECACHE_URLS = ${JSON.stringify(files)};`));
	await writeFile(join(output, 'precache-manifest.json'), JSON.stringify({ buildId, assets: files }));
	console.log(`[build] Prepared ${files.length} immutable assets for offline use (${buildId})`);
}
