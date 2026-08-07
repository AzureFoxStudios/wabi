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

for (const name of ['JI', 'ce', 'ns', 'Hn', 'Do', 'jn', 'is']) {
	console.log('\n===', name, '===');
	let idx = 0,
		n = 0;
	while ((idx = code.indexOf(name + '=', idx + 1)) !== -1 && n < 12) {
		const pos = posAt(idx);
		console.log(
			idx,
			JSON.stringify(code.slice(idx, idx + 60)),
			'=>',
			(pos.source || '').replace(/.*\/src\//, 'src/').slice(-60),
			pos.line,
			pos.name || ''
		);
		n++;
	}
}

const imp = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/)[1];
const localFor = {};
for (const m of imp.matchAll(/(\w+)\s+as\s+(\w+)/g)) localFor[m[1]] = m[2];
const sg = localFor['ai'];
console.log('\nstore_get local', sg);

for (const name of ['JI', 'ce', 'ns']) {
	const re = new RegExp(String.raw`${sg}\(${name}\b`, 'g');
	let m;
	let n = 0;
	while ((m = re.exec(code)) && n < 8) {
		console.log(
			'store_get(' + name + ') at',
			m.index,
			JSON.stringify(code.slice(m.index - 20, m.index + 60))
		);
		console.log('  call maps', posAt(m.index));
		n++;
	}
}
