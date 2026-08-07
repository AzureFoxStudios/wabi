import fs from 'fs';
import path from 'path';
import { SourceMapConsumer } from 'source-map';

const root = 'build/_app/immutable';

function walk(d, a = []) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p, a);
		else if (e.name.endsWith('.js') && !e.name.endsWith('.map')) a.push(p);
	}
	return a;
}

const files = walk(root);
const importers = files.filter((f) => fs.readFileSync(f, 'utf8').includes('Z9Z8gdf2'));
console.log('importers', importers.length);

for (const f of importers) {
	const t = fs.readFileSync(f, 'utf8');
	const rel = path.relative(root, f);
	// Extract import names from this chunk
	const importMatch = t.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/);
	const names = importMatch
		? importMatch[1]
				.split(',')
				.map((s) => s.trim().split(/\s+as\s+/).pop().trim())
				.filter(Boolean)
		: [];
	console.log('\n==', rel, 'imports', names.slice(0, 12).join(','));

	// Look for async generators / map near subscribe helper usage
	// Svelte store_get often named after import binding
	if (names.length === 0) continue;

	// Find files that have async function + .map(
	const asyncMap = [...t.matchAll(/async\s+function\s+(\w+)|async\s*\(/g)].length;
	const maps = [...t.matchAll(/\.map\s*\(/g)].length;
	console.log('  async-ish', asyncMap, 'maps', maps, 'size', t.length);

	const mapPath = f + '.map';
	if (!fs.existsSync(mapPath)) {
		console.log('  no map');
		continue;
	}
	const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
	const appSources = (raw.sources || []).filter(
		(s) => s.includes('src/') && !s.includes('node_modules')
	);
	console.log('  app sources:', appSources.slice(0, 30).join(' | '));
}
