import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const code = fs.readFileSync('build/_app/immutable/chunks/89xbtPiJ.js', 'utf8');
const consumer = await new SourceMapConsumer(
	JSON.parse(fs.readFileSync('build/_app/immutable/chunks/89xbtPiJ.js.map', 'utf8'))
);
function posAt(index) {
	let l = 1,
		c = 0;
	for (let i = 0; i < index; i++) {
		if (code[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	return consumer.originalPositionFor({ line: l, column: c });
}

// Find the store_get block for Chat and print bindings with names from string literals
const start = code.indexOf('$currentChatSurface');
console.log('around currentChatSurface bindings:');
console.log(code.slice(start - 200, start + 800));

// Resolve ce= assignments that look like stores
console.log('\n=== ce= store-like ===');
let idx = 0,
	n = 0;
while ((idx = code.indexOf('ce=', idx + 1)) !== -1 && n < 50) {
	const snip = code.slice(idx, idx + 80);
	if (snip.includes('writable') || snip.includes('derived') || snip.includes('=O(') || snip.includes('=pr(') || snip.includes('=Vn(') || snip.includes('activeTab')) {
		const pos = posAt(idx);
		console.log(idx, JSON.stringify(snip), '=>', (pos.source || '').replace(/.*\/src\//, 'src/'), pos.line, pos.name);
	}
	// also mobileTabQueue
	if (snip.includes('null') && snip.includes('O(')) {
		const pos = posAt(idx);
		if ((pos.source || '').includes('mobileTab')) console.log('MOBILE', idx, snip, pos);
	}
	n++;
}

// search activeTabId
idx = code.indexOf('activeTabId');
console.log('\nactiveTabId contexts:');
while (idx !== -1 && n < 60) {
	console.log(idx, JSON.stringify(code.slice(idx - 40, idx + 80)));
	console.log(' ', posAt(idx));
	idx = code.indexOf('activeTabId', idx + 1);
	n++;
}
