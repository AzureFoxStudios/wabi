import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const file = 'build/_app/immutable/chunks/89xbtPiJ.js';
const code = fs.readFileSync(file, 'utf8');
const raw = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));
const consumer = await new SourceMapConsumer(raw);

// Find import alias for store_get (export ai from runtime)
const imp = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/)[1];
const localFor = {};
for (const m of imp.matchAll(/(\w+)\s+as\s+(\w+)/g)) localFor[m[1]] = m[2];
const storeGet = localFor['ai'];
console.log('store_get local:', storeGet);

// Scan entire file; for each store_get call, map original; collect unique store identifier expressions
const re = new RegExp(String.raw`${storeGet}\(([^,]+),`, 'g');
let m;
const byFile = new Map();
while ((m = re.exec(code))) {
	const arg = m[1].trim().slice(0, 80);
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
	const src = (pos.source || '').replace(/.*\/src\//, 'src/');
	if (!src.includes('src/')) continue;
	const key = `${src}:${pos.line || '?'} :: ${arg}`;
	byFile.set(key, (byFile.get(key) || 0) + 1);
}

// Focus Chat, MessageList, ChatComposer
const focus = [...byFile.entries()].filter(
	([k]) =>
		k.includes('Chat.svelte') ||
		k.includes('MessageList') ||
		k.includes('ChatComposer') ||
		k.includes('ChatMessages') ||
		k.includes('ChatHeader')
);
console.log('focused store_get sites:');
focus
	.sort((a, b) => b[1] - a[1])
	.forEach(([k, v]) => console.log(v, k));

// Also dump any store_get arg that looks like a property access of a non-store
console.log('\nsuspicious args (property / optional):');
[...byFile.entries()]
	.filter(([k]) => /:: .*\./.test(k) || /:: [A-Z]/.test(k))
	.slice(0, 40)
	.forEach(([k, v]) => console.log(v, k));
