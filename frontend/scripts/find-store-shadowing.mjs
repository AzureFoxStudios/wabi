import fs from 'fs';
import path from 'path';

const root = process.cwd();

function walkDir(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkDir(p, out);
		else if (e.name.endsWith('.svelte') || e.name.endsWith('.ts')) out.push(p);
	}
	return out;
}

const files = walkDir(path.join(root, 'src')).filter(
	(f) => !f.includes('node_modules') && !f.includes('.svelte-kit')
);

let hits = 0;
for (const file of files) {
	const src = fs.readFileSync(file, 'utf8');
	// Extract imported names
	const imported = new Set();
	for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
		for (const part of m[1].split(',')) {
			const mm = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
			if (mm) imported.add(mm[2] || mm[1]);
		}
	}
	for (const m of src.matchAll(/import\s+(\w+)\s+from\s*['"][^'"]+['"]/g)) {
		imported.add(m[1]);
	}
	if (imported.size === 0) continue;

	// Find local declarations that shadow an imported name
	const shadowRe = /\b(?:let|var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
	let m;
	while ((m = shadowRe.exec(src))) {
		const local = m[1];
		if (!imported.has(local)) continue;
		// ignore re-export: export { x } or export const x
		const lineStart = src.lastIndexOf('\n', m.index) + 1;
		const line = src.slice(lineStart, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index));
		if (line.trim().startsWith('export')) continue;
		// ignore destructured props `export let x` — that's a prop, and `$x` on a prop is a Svelte error anyway
		if (line.trim().startsWith('export let')) continue;
		console.log(
			`${path.relative(root, file)}: "${local}" declared ${line.trim().slice(0, 80)} (imported store shadowed)`
		);
		hits++;
	}
}
console.log('\nshadow hits:', hits);
