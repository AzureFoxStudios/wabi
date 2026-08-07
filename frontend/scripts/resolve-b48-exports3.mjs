import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

const b48 = fs.readFileSync('build/_app/immutable/chunks/B48P1wqQ.js', 'utf8');
const consumer = await new SourceMapConsumer(
	JSON.parse(fs.readFileSync('build/_app/immutable/chunks/B48P1wqQ.js.map', 'utf8'))
);

// Parse exports correctly including $ in names
const exp = b48.match(/export\{([^}]+)\}/)[1];
const pairs = [];
for (const part of exp.split(',')) {
	const m = part.trim().match(/^([\$\w]+)\s+as\s+([\$\w]+)$/);
	if (m) pairs.push({ local: m[1], exp: m[2] });
}

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

const want = 'by bt bz br bB bx c6 c8 bE ac al T bw e7 eb ec ed ee ef ek el em Qr'.split(' ');
for (const w of want) {
	const p = pairs.find((x) => x.exp === w);
	if (!p) {
		console.log(w, 'MISSING');
		continue;
	}
	const local = p.local;
	// Search for assignment patterns; escape $
	const esc = local.replace(/\$/g, '\\$');
	const patterns = [
		new RegExp(`\\b${esc}=(?:writable|derived|readable)\\b`),
		new RegExp(`${esc}=(?:writable|derived|readable)\\b`),
		new RegExp(`function ${esc}\\b`),
		new RegExp(`(?:const|let|var) ${esc}\\b`)
	];
	let hit = null;
	for (const re of patterns) {
		const m = b48.match(re);
		if (m) {
			hit = { text: m[0], index: m.index };
			break;
		}
	}
	if (!hit) {
		// lastIndexOf local as standalone near definitions of stores
		const idx = b48.indexOf(`${local}=`);
		if (idx >= 0) hit = { text: b48.slice(idx, idx + 40), index: idx };
	}
	if (!hit) {
		console.log(w, 'local', local, 'NO DEF');
		continue;
	}
	const pos = posAt(hit.index);
	console.log(
		w,
		'local',
		local,
		JSON.stringify(hit.text).slice(0, 50),
		'=>',
		(pos.source || '').replace(/.*\/src\//, 'src/'),
		pos.line,
		pos.name || ''
	);
}
