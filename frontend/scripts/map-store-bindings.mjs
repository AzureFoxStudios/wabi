import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const file = 'build/_app/immutable/chunks/89xbtPiJ.js';
const code = fs.readFileSync(file, 'utf8');
const raw = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));
const consumer = await new SourceMapConsumer(raw);

// Build map: generated name at import site -> original name by scanning mappings for Chat.svelte imports
// Simpler approach: for each store_get first-arg identifier, find where that identifier is assigned/imported
// by looking at earlier `import { X as Y }` or `Y=` with sourcemap to original.

const imp = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/)[1];
const localFor = {};
for (const m of imp.matchAll(/(\w+)\s+as\s+(\w+)/g)) localFor[m[1]] = m[2];
const storeGet = localFor['ai'];

// Collect all import clauses in the chunk
const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
const importMap = new Map(); // local -> module
let m;
while ((m = importRe.exec(code))) {
	const mod = m[2];
	const clause = m[1];
	for (const part of clause.split(',')) {
		const mm = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
		if (!mm) continue;
		const exp = mm[1];
		const local = mm[2] || mm[1];
		importMap.set(local, { exp, mod });
	}
}

const targets = ['Chat.svelte', 'ChatComposer.svelte', 'MessageList.svelte'];
const storeGetRe = new RegExp(String.raw`${storeGet}\((\w+)`, 'g');
const used = new Map();
while ((m = storeGetRe.exec(code))) {
	const local = m[1];
	const col = m.index;
	let l = 1,
		c = 0;
	for (let i = 0; i < col; i++) {
		if (code[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	const pos = consumer.originalPositionFor({ line: l, column: c });
	const src = pos.source || '';
	if (!targets.some((t) => src.endsWith(t))) continue;
	const info = importMap.get(local);
	const key = `${src.replace(/.*\//, '')}: ${local} <= ${info ? info.exp + ' from ' + info.mod.replace(/.*\//, '') : '??'}`;
	used.set(key, (used.get(key) || 0) + 1);
}

console.log('store_get bindings in Chat/Composer/MessageList:');
[...used.entries()]
	.sort()
	.forEach(([k, v]) => console.log(v, k));

// Flag any binding that is NOT from a known store-ish module export name
console.log('\nAll unique targets:');
const uniq = new Map();
for (const [k] of used) {
	const mm = k.match(/<= (\w+) from (.+)$/);
	if (mm) uniq.set(mm[1] + ' @ ' + mm[2], true);
}
[...uniq.keys()].sort().forEach((k) => console.log(k));
