import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

// Map callers: for each importer chunk of Z9Z8gdf2, find references to the
// store_get / subscribe_to_store helper and map back to app source.

const runtimeMap = JSON.parse(fs.readFileSync('build/_app/immutable/chunks/Z9Z8gdf2.js.map', 'utf8'));
// Find which export is store_get - read utils.js mapping around line 26
// We'll instead look at each big chunk and map positions of common helper names.

const chunks = [
	'build/_app/immutable/chunks/89xbtPiJ.js',
	'build/_app/immutable/chunks/BT8YAoO0.js',
	'build/_app/immutable/chunks/B48P1wqQ.js'
];

for (const file of chunks) {
	const code = fs.readFileSync(file, 'utf8');
	const imp = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/);
	if (!imp) continue;
	// Parse aliased imports: "h as cl" -> local cl from export h
	const locals = [];
	for (const part of imp[1].split(',')) {
		const bits = part.trim().split(/\s+as\s+/);
		if (bits.length === 2) locals.push({ exp: bits[0].trim(), local: bits[1].trim() });
		else if (bits[0]) locals.push({ exp: bits[0].trim(), local: bits[0].trim() });
	}
	// Heuristic: store_get is often a short function used like X(store)
	// From svelte store utils, subscribe_to_store / store_get
	// Count usages of each local as call: localName(
	const usage = locals
		.map(({ exp, local }) => {
			const re = new RegExp(`(?<!\\.)\\b${local}\\s*\\(`, 'g');
			const count = (code.match(re) || []).length;
			return { exp, local, count };
		})
		.sort((a, b) => b.count - a.count)
		.slice(0, 15);
	console.log('\n', file.split('/').pop(), 'top imported helpers by call count:');
	usage.forEach((u) => console.log(' ', u.count, u.local, 'from', u.exp));
}
