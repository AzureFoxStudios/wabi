import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

// For each big chunk, find call sites of the local alias that maps to export `v`
// (from helper ranking, `e from v` was top - need to know what export `v` is in Z9Z8gdf2)

const runtime = fs.readFileSync('build/_app/immutable/chunks/Z9Z8gdf2.js', 'utf8');
const runtimeMap = JSON.parse(fs.readFileSync('build/_app/immutable/chunks/Z9Z8gdf2.js.map', 'utf8'));
const rc = await new SourceMapConsumer(runtimeMap);

// Find export names at start of chunk
console.log('runtime head:', runtime.slice(0, 400));

// Map export statements - vite usually: export{foo as v, ...}
const exp = runtime.match(/export\{([^}]+)\}/);
console.log('exports:', exp?.[1]?.slice(0, 500));

// For each export alias, map a position inside the function
// Parse export{a as b, c as d}
const pairs = [];
if (exp) {
	for (const part of exp[1].split(',')) {
		const m = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
		if (m) pairs.push({ local: m[1], exp: m[2] || m[1] });
	}
}
console.log('pair count', pairs.length);

// Find function definitions for locals and map them
for (const p of pairs) {
	// find "function LOCAL" or "LOCAL=" 
	const idx = runtime.indexOf(`function ${p.local}(`);
	const idx2 = runtime.indexOf(`${p.local}=`);
	const at = idx >= 0 ? idx : idx2;
	if (at < 0) continue;
	let l = 1,
		c = 0;
	for (let i = 0; i < at; i++) {
		if (runtime[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	const pos = rc.originalPositionFor({ line: l, column: c + 5 });
	if (pos.source?.includes('store')) {
		console.log(p.exp, '->', p.local, pos.source.split('/').slice(-3).join('/'), pos.line);
	}
}
