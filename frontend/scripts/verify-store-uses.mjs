import { createServer } from 'vite';
import fs from 'fs';

const root = process.cwd();
const server = await createServer({
	root,
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'error'
});

// Files in the send path
const files = [
	'/src/lib/components/chat/ChatComposer.svelte',
	'/src/lib/components/Chat.svelte',
	'/src/lib/components/MessageList.svelte',
	'/src/lib/components/chat/ChatMessagesPane.svelte',
	'/src/lib/components/chat/ChatHeader.svelte'
];

function extractStoreRefs(src) {
	const refs = new Set();
	const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
	let m;
	while ((m = re.exec(src))) {
		const name = m[1];
		// skip $props/$state/$derived/$effect/$bindable/$host/$inspect/$lib/$app/$env
		if (['props', 'state', 'derived', 'effect', 'bindable', 'host', 'inspect', 'lib', 'app', 'env', '$'].includes(name)) continue;
		// skip `$:` reactive labels and `$t` style template vars
		refs.add(name);
	}
	return refs;
}

function resolveImport(src, name) {
	// import { x, y as name, z } from 'mod'
	const re = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]([^'"]+)['"]`, 'g');
	let m;
	while ((m = re.exec(src))) {
		const clause = m[1];
		for (const part of clause.split(',')) {
			const p = part.trim();
			const mm = p.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
			if (!mm) continue;
			const orig = mm[1];
			const local = mm[2] || mm[1];
			if (local === name) return { mod: m[2], exportName: orig, kind: 'named' };
		}
	}
	// import default
	const d = src.match(new RegExp(`import\\s+(\\w+)\\s+from\\s*['"]([^'"]+)['"]`));
	if (d && d[1] === name) return { mod: d[2], exportName: 'default', kind: 'default' };
	// destructured const { x: name } = mod
	const dd = src.match(new RegExp(`const\\s*\\{\\s*([^}]+)\\}\\s*=\\s*(\\w+)`));
	if (dd) {
		for (const part of dd[1].split(',')) {
			const mm = part.trim().match(/^(\w+)(?:\s*:\s*(\w+))?$/);
			if (mm && (mm[2] || mm[1]) === name) {
				return { from: dd[2], exportName: mm[1], kind: 'destructured' };
			}
		}
	}
	return null;
}

let issues = 0;
for (const file of files) {
	const abs = root + file;
	const src = fs.readFileSync(abs, 'utf8');
	const refs = extractStoreRefs(src);
	console.log('\n==', file, `(${refs.size} store refs) ==`);
	for (const name of [...refs].sort()) {
		const imp = resolveImport(src, name);
		if (!imp) {
			console.log(`  ${name}: UNRESOLVED import`);
			continue;
		}
		try {
			if (imp.kind === 'destructured') {
				const m = await server.ssrLoadModule(imp.from);
				const v = m[imp.exportName];
				const ok = v && typeof v === 'object' && typeof v.subscribe === 'function';
				if (!ok) console.log(`  ${name}: *** NOT A STORE *** (${imp.from}.${imp.exportName} type=${typeof v})`);
				else console.log(`  ${name}: ok (destructured from ${imp.from}.${imp.exportName})`);
				continue;
			}
			if (imp.exportName === 'default') {
				const m = await server.ssrLoadModule(imp.mod);
				const v = m.default;
				const ok = v && typeof v === 'object' && typeof v.subscribe === 'function';
				if (!ok) console.log(`  ${name}: *** NOT A STORE *** (${imp.mod} default type=${typeof v})`);
				else console.log(`  ${name}: ok (default from ${imp.mod})`);
				continue;
			}
			const m = await server.ssrLoadModule(imp.mod);
			const v = m[imp.exportName];
			if (v === undefined) {
				console.log(`  ${name}: MISSING export ${imp.exportName} in ${imp.mod}`);
				issues++;
				continue;
			}
			if (imp.mod.includes('layoutStore') && imp.exportName === 'layoutStore') {
				const ok = typeof v?.subscribe === 'function';
				console.log(`  ${name}: ${ok ? 'ok' : '*** NOT A STORE ***'} (layoutStore.subscribe type=${typeof v?.subscribe})`);
				continue;
			}
			if (imp.mod.includes('mobileTabQueue') && imp.exportName === 'mobileTabQueue') {
				const ok = typeof v?.activeTabId?.subscribe === 'function';
				console.log(`  ${name}: ${ok ? 'ok' : '*** NOT A STORE ***'} (activeTabId type=${typeof v?.activeTabId?.subscribe})`);
				continue;
			}
			const ok = v && typeof v === 'object' && typeof v.subscribe === 'function';
			if (!ok) {
				console.log(`  ${name}: *** NOT A STORE *** type=${typeof v}` + (v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 8).join(',') : ''));
				issues++;
			} else {
				console.log(`  ${name}: ok (${imp.mod}.${imp.exportName})`);
			}
		} catch (e) {
			console.log(`  ${name}: LOAD FAILED ${e.message.slice(0, 120)}`);
		}
	}
}

console.log('\nISSUES:', issues);
await server.close();
