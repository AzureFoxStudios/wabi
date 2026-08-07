import { createServer } from 'vite';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const server = await createServer({
	root,
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'error'
});

const STORE_SKIP = new Set([
	'props', 'state', 'derived', 'effect', 'bindable', 'host', 'inspect',
	'lib', 'app', 'env', '$', 'self'
]);

function walkDir(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkDir(p, out);
		else if (e.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

function extractStoreRefs(src) {
	const refs = new Set();
	const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
	let m;
	while ((m = re.exec(src))) {
		const name = m[1];
		if (STORE_SKIP.has(name)) continue;
		// `$:` reactive labels
		const before = src.slice(Math.max(0, m.index - 2), m.index);
		if (before.trim() === '$:') continue;
		refs.add(name);
	}
	return refs;
}

function resolveImport(src, name) {
	const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
	let m;
	while ((m = re.exec(src))) {
		for (const part of m[1].split(',')) {
			const mm = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
			if (mm && (mm[2] || mm[1]) === name) return { mod: m[2], exportName: mm[1] };
		}
	}
	const d = src.match(new RegExp(`import\\s+(\\w+)\\s+from\\s*['"]([^'"]+)['"]`));
	if (d && d[1] === name) return { mod: d[2], exportName: 'default' };
	return null;
}

let bad = [];
let checked = 0;
const files = walkDir(path.join(root, 'src/lib/components')).concat(
	walkDir(path.join(root, 'src/routes'))
);

for (const file of files) {
	const src = fs.readFileSync(file, 'utf8');
	const refs = extractStoreRefs(src);
	if (refs.size === 0) continue;
	const rel = path.relative(root, file);
	for (const name of [...refs].sort()) {
		const imp = resolveImport(src, name);
		if (!imp) continue;
		checked++;
		try {
			if (imp.mod.includes('/layoutStore') && imp.exportName === 'layoutStore') {
				const v = (await server.ssrLoadModule(imp.mod))[imp.exportName];
				if (typeof v?.subscribe !== 'function') bad.push(`${rel}: $${name} -> layoutStore has NO subscribe`);
				continue;
			}
			if (imp.mod.includes('mobileTabQueue') && imp.exportName === 'mobileTabQueue') {
				const v = (await server.ssrLoadModule(imp.mod))[imp.exportName];
				if (typeof v?.activeTabId?.subscribe !== 'function') bad.push(`${rel}: $${name} -> mobileTabQueue.activeTabId NOT a store`);
				continue;
			}
			const v = (await server.ssrLoadModule(imp.mod))[imp.exportName];
			const ok = v && typeof v === 'object' && typeof v.subscribe === 'function';
			if (!ok) {
				const kind = v === undefined ? 'MISSING' : `type=${typeof v}` + (v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 6).join(',') : '');
				bad.push(`${rel}: $${name} -> ${imp.mod} .${imp.exportName} ${kind}`);
			}
		} catch (e) {
			// skip module load failures (env-dependent)
		}
	}
}

console.log('store refs checked:', checked);
console.log('\nBAD REFS:');
bad.forEach((b) => console.log(' -', b));
console.log('\ntotal bad:', bad.length);
await server.close();
