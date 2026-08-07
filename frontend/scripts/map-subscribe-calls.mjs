import fs from 'fs';
import { SourceMapConsumer } from 'source-map';

function parseExportClause(clause) {
	// "foo as bar,baz as qux" — local names may be `as`
	const pairs = [];
	const re = /(\w+)\s+as\s+(\w+)/g;
	let m;
	while ((m = re.exec(clause))) pairs.push({ local: m[1], exp: m[2] });
	return pairs;
}

const runtime = fs.readFileSync('build/_app/immutable/chunks/Z9Z8gdf2.js', 'utf8');
const runtimeMap = JSON.parse(fs.readFileSync('build/_app/immutable/chunks/Z9Z8gdf2.js.map', 'utf8'));
const rc = await new SourceMapConsumer(runtimeMap);
const expClause = runtime.match(/export\{([^}]+)\}/)[1];
const pairs = parseExportClause(expClause);

let subscribeExport = null;
const storeHelpers = [];
for (const p of pairs) {
	const idx = runtime.indexOf(`function ${p.local}(`);
	if (idx < 0) continue;
	let l = 1,
		c = 0;
	for (let i = 0; i < idx; i++) {
		if (runtime[i] === '\n') {
			l++;
			c = 0;
		} else c++;
	}
	const pos = rc.originalPositionFor({ line: l, column: c });
	const src = pos.source || '';
	if (src.includes('store/utils')) {
		console.log('utils', p.exp, '<-', p.local, 'L' + pos.line);
		if (pos.line === 12) subscribeExport = p.exp;
	}
	if (src.includes('reactivity/store.js')) {
		storeHelpers.push({ ...p, line: pos.line });
	}
}
console.log('subscribeExport', subscribeExport);
console.log(
	'store.js helpers',
	storeHelpers.map((h) => `${h.exp}/L${h.line}`).join(', ')
);

// store_get is usually around line 36-50 in store.js for Svelte 5
const storeGetExp = storeHelpers.find((h) => h.line >= 30 && h.line <= 80)?.exp;
console.log('likely store_get export', storeGetExp);

async function mapCalls(chunkPath, exportName, label) {
	const code = fs.readFileSync(chunkPath, 'utf8');
	const chunkMap = JSON.parse(fs.readFileSync(chunkPath + '.map', 'utf8'));
	const cc = await new SourceMapConsumer(chunkMap);
	const impM = code.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*Z9Z8gdf2[^"']*["']/);
	if (!impM) return;
	const localFor = {};
	const reImp = /(\w+)\s+as\s+(\w+)/g;
	let m;
	while ((m = reImp.exec(impM[1]))) localFor[m[1]] = m[2];
	// also unaliased
	for (const part of impM[1].split(',')) {
		const t = part.trim();
		if (t && !t.includes(' as ')) localFor[t] = t;
	}
	const local = localFor[exportName];
	if (!local) {
		console.log(label, 'no local for', exportName);
		return;
	}
	const re = new RegExp(String.raw`(?<!\.)\b${local}\s*\(`, 'g');
	const hits = new Map();
	let n = 0;
	while ((m = re.exec(code)) && n < 800) {
		const col = m.index;
		let l = 1,
			c = 0;
		for (let i = 0; i < col; i++) {
			if (code[i] === '\n') {
				l++;
				c = 0;
			} else c++;
		}
		const pos = cc.originalPositionFor({ line: l, column: c });
		if (pos.source?.includes('src/')) {
			const key = `${pos.source.replace(/.*\/src\//, 'src/')}:${pos.line}`;
			hits.set(key, (hits.get(key) || 0) + 1);
		}
		n++;
	}
	console.log('\n', label, exportName, '->', local, 'hits', n);
	[...hits.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 40)
		.forEach(([k, v]) => console.log(v, k));
}

const target = storeGetExp || subscribeExport;
if (target) {
	await mapCalls('build/_app/immutable/chunks/89xbtPiJ.js', target, '89x');
	await mapCalls('build/_app/immutable/chunks/BT8YAoO0.js', target, 'BT8');
	await mapCalls('build/_app/immutable/chunks/B48P1wqQ.js', target, 'B48');
}
if (subscribeExport && subscribeExport !== target) {
	await mapCalls('build/_app/immutable/chunks/89xbtPiJ.js', subscribeExport, '89x-sub');
}
