import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const b48 = fs.readFileSync('build/_app/immutable/chunks/B48P1wqQ.js', 'utf8');
const b48map = JSON.parse(fs.readFileSync('build/_app/immutable/chunks/B48P1wqQ.js.map', 'utf8'));
const consumer = await new SourceMapConsumer(b48map);

const exp = b48.match(/export\{([^}]+)\}/)[1];
const pairs = [];
for (const m of exp.matchAll(/(\w+)\s+as\s+(\w+)/g)) pairs.push({ local: m[1], exp: m[2] });

const wanted = new Set(
	'by bt bz br bB bx c6 c8 bE ac al T b_ bD bw e7 eb ec ed ee ef ek el em'.split(' ')
);

function mapLocal(local) {
	// find function/const definition
	let idx = b48.indexOf(`function ${local}(`);
	if (idx < 0) idx = b48.search(new RegExp(`\\b(?:const|let|var) ${local}\\b`));
	if (idx < 0) idx = b48.indexOf(`${local}=`);
	if (idx < 0) return null;
	let l = 1,
		c = 0;
	for (let i = 0; i < idx; i++) {
		if (b48[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	return consumer.originalPositionFor({ line: l, column: c });
}

console.log('B48 exports used as stores:');
for (const p of pairs) {
	if (!wanted.has(p.exp)) continue;
	const pos = mapLocal(p.local);
	const src = (pos?.source || '').replace(/.*\/src\//, 'src/');
	console.log(p.exp, '<-', p.local, '=>', src + ':' + pos?.line, pos?.name || '');
}
