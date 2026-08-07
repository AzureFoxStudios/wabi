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

// Find where tn comes from
for (const m of code.matchAll(/import\{([^}]+)\}from["']([^"']+)["']/g)) {
	if (/\btn\b/.test(m[1]) || m[1].includes(' as tn')) {
		console.log('import tn from', m[2], 'clause', m[1].slice(0, 200));
	}
}

// Read CBhJaPX1 which had mobileTabQueue
const mq = fs.readFileSync('build/_app/immutable/chunks/CBhJaPX1.js', 'utf8');
console.log('CBhJaPX1 head', mq.slice(0, 500));
console.log('CBhJaPX1 export', mq.match(/export\{[^}]+\}/)?.[0]);

// Map exports of CBhJaPX1
const mqMap = JSON.parse(fs.readFileSync('build/_app/immutable/chunks/CBhJaPX1.js.map', 'utf8'));
const mc = await new SourceMapConsumer(mqMap);
const exp = mq.match(/export\{([^}]+)\}/)[1];
for (const part of exp.split(',')) {
	const mm = part.trim().match(/^([\$\w]+)\s+as\s+([\$\w]+)$/);
	if (!mm) continue;
	const local = mm[1];
	const idx = mq.indexOf(local + '=');
	if (idx < 0) continue;
	let l = 1,
		c = 0;
	for (let i = 0; i < idx; i++) {
		if (mq[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	const pos = mc.originalPositionFor({ line: l, column: c });
	console.log(mm[2], '<-', local, '=>', (pos.source || '').replace(/.*\//, ''), pos.line, pos.name);
}
