import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const file = 'build/_app/immutable/chunks/89xbtPiJ.js';
const mapPath = file + '.map';
const code = fs.readFileSync(file, 'utf8');
const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

// Find import of subscribe helper from Z9Z8gdf2 - typically store_get is one of the short names
const imp = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/);
console.log('import clause sample:', imp?.[1]?.slice(0, 300));

const consumer = await new SourceMapConsumer(raw);

// Scan for .subscribe( calls and map a sample of them to original sources
const re = /\.subscribe\s*\(/g;
let m;
let n = 0;
const bySource = new Map();
while ((m = re.exec(code)) && n < 2000) {
	const col = m.index;
	// line 1 file (minified single line often)
	const line = 1;
	// If multi-line, compute line/col
	let l = 1,
		c = 0;
	for (let i = 0; i < col; i++) {
		if (code[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	const pos = consumer.originalPositionFor({ line: l, column: c });
	if (pos.source && pos.source.includes('src/')) {
		const key = `${pos.source}:${pos.line}`;
		bySource.set(key, (bySource.get(key) || 0) + 1);
	}
	n++;
}
console.log('mapped subscribe hits in app sources (top):');
[...bySource.entries()]
	.sort((a, b) => b[1] - a[1])
	.slice(0, 40)
	.forEach(([k, v]) => console.log(v, k));

// Also map async function bodies that contain .map( then subscribe helper
// Search for store_get-like usage patterns near "map"
consumer.destroy();
