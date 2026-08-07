import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const b48 = fs.readFileSync('build/_app/immutable/chunks/B48P1wqQ.js', 'utf8');
const consumer = await new SourceMapConsumer(
	JSON.parse(fs.readFileSync('build/_app/immutable/chunks/B48P1wqQ.js.map', 'utf8'))
);
const exp = b48.match(/export\{([^}]+)\}/)[1];
const pairs = [];
for (const m of exp.matchAll(/(\w+)\s+as\s+(\w+)/g)) pairs.push({ local: m[1], exp: m[2] });

function posAt(index) {
	let l = 1,
		c = 0;
	for (let i = 0; i < index; i++) {
		if (b48[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	return consumer.originalPositionFor({ line: l, column: c });
}

for (const want of ['ee', 'ed', 'ef', 'e7', 'eb', 'ec', 'em', 'el', 'ek', 'bt', 'Qr']) {
	const p = pairs.find((x) => x.exp === want);
	if (!p) {
		console.log(want, 'missing');
		continue;
	}
	// Prefer writable/derived assignment
	const patterns = [
		new RegExp(`\\b${p.local}=writable\\b`),
		new RegExp(`\\b${p.local}=derived\\b`),
		new RegExp(`\\bfunction ${p.local}\\b`),
		new RegExp(`\\bconst ${p.local}\\b`),
		new RegExp(`\\blet ${p.local}\\b`)
	];
	let hit = null;
	for (const re of patterns) {
		const m = re.exec(b48);
		if (m) {
			hit = m;
			break;
		}
	}
	if (!hit) {
		console.log(want, 'local', p.local, 'NO DEF');
		continue;
	}
	const pos = posAt(hit.index);
	console.log(
		want,
		'local',
		p.local,
		hit[0],
		'=>',
		(pos.source || '').replace(/.*\/src\//, 'src/'),
		pos.line,
		pos.name || ''
	);
}
