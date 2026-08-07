import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const file = 'build/_app/immutable/chunks/89xbtPiJ.js';
const code = fs.readFileSync(file, 'utf8');
const consumer = await new SourceMapConsumer(JSON.parse(fs.readFileSync(file + '.map', 'utf8')));

const imp = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/)[1];
const localFor = {};
for (const m of imp.matchAll(/(\w+)\s+as\s+(\w+)/g)) localFor[m[1]] = m[2];
const storeGet = localFor['ai'];

// unknowns from prior run
const unknowns = 'Bh Do Hn Hu JI Jp ce dv mn ns qu os Fn Ic Tl Al Sl Zu ed xi zv jn'.split(' ');

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

for (const name of unknowns) {
	const patterns = [
		new RegExp(`\\b${name}=(?:writable|derived|readable|O)\\b`),
		new RegExp(`\\b${name}=(?:writable|derived|readable)\\(`),
		new RegExp(`${name}=O\\(`),
		new RegExp(`(?:const|let|var) ${name}\\b`),
		new RegExp(`function ${name}\\b`)
	];
	let hit = null;
	for (const re of patterns) {
		const m = code.match(re);
		if (m) {
			hit = { text: m[0], index: m.index };
			break;
		}
	}
	if (!hit) {
		const idx = code.indexOf(`${name}=`);
		if (idx >= 0) hit = { text: code.slice(idx, idx + 60), index: idx };
	}
	if (!hit) {
		console.log(name, 'NO DEF');
		continue;
	}
	const pos = posAt(hit.index);
	console.log(
		name,
		JSON.stringify(hit.text).slice(0, 60),
		'=>',
		(pos.source || '').replace(/.*\/src\//, 'src/'),
		pos.line,
		pos.name || ''
	);
}

// Also list every store_get first-arg in Chat.svelte region with original name via nearby mapping of the ARG itself
console.log('\n--- store_get args with arg position mapped ---');
const re = new RegExp(String.raw`${storeGet}\((\w+)`, 'g');
let m;
const seen = new Set();
while ((m = re.exec(code))) {
	const local = m[1];
	const argPos = posAt(m.index + storeGet.length + 1);
	const callPos = posAt(m.index);
	const callSrc = (callPos.source || '').replace(/.*\//, '');
	if (!['Chat.svelte', 'ChatComposer.svelte', 'MessageList.svelte'].includes(callSrc)) continue;
	const key = `${callSrc} ${local}`;
	if (seen.has(key)) continue;
	seen.add(key);
	const argSrc = (argPos.source || '').replace(/.*\/src\//, 'src/');
	console.log(callSrc, 'arg', local, 'argMapsTo', argSrc + ':' + argPos.line, argPos.name || '', 'nameHint', argPos.name);
}
