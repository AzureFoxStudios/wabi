// Desktop shell contract (docs/audits/2026-11-hostile-server-audit.md, question 1).
//
// A Wabi server must never be able to deliver code to the desktop app or reach its native
// commands. These checks fail if the Tauri config or capabilities gain a remote code source or a
// broader scope, or if a native command is registered without checking that the calling page is
// Wabi's own bundled frontend. Tauri does not filter app commands by origin (no app manifest), so
// that check lives in each command.
//
//   node --test scripts/tests/desktop-shell-contract.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tauri = path.join(root, 'src-tauri');
const json = (file) => JSON.parse(readFileSync(path.join(tauri, file), 'utf8'));
const CONFIGS = readdirSync(tauri).filter((name) => /^tauri(\..+)?\.conf\.json$/.test(name));

function cspDirectives(csp) {
	const map = new Map();
	for (const part of csp.split(';').map((value) => value.trim()).filter(Boolean)) {
		const [name, ...values] = part.split(/\s+/);
		map.set(name.toLowerCase(), values);
	}
	return map;
}

test('the desktop app loads its code only from the bundled frontend', () => {
	const config = json('tauri.conf.json');
	assert.equal(config.build.frontendDist, '../frontend/build', 'frontendDist stays the bundled build, never a URL');
	const csp = config.app?.security?.csp;
	assert.equal(typeof csp, 'string', 'a CSP is set (Tauri injects it into every bundled page)');
	const directives = cspDirectives(csp);
	assert.deepEqual(directives.get('default-src'), ["'self'"]);
	assert.deepEqual(directives.get('script-src'), ["'self'", "'wasm-unsafe-eval'"], "script-src: no remote host, no 'unsafe-inline', no 'unsafe-eval', no blob:/data:");
	for (const name of ['script-src-elem', 'script-src-attr', 'object-src', 'base-uri', 'form-action']) {
		const values = directives.get(name);
		if (values) assert.ok(values.every((value) => ["'self'", "'none'"].includes(value)), `${name} must not allow anything beyond 'self'`);
	}
	// No frame-src/child-src: frames fall back to default-src 'self', so a blob:/data:/server page
	// cannot be framed. Adding one must be a deliberate, reviewed change to this test.
	assert.equal(directives.get('frame-src'), undefined, 'frame-src not broadened');
	assert.equal(directives.get('child-src'), undefined, 'child-src not broadened');
	assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:'], 'workers only from the bundle (or bundle-built blobs)');
	assert.ok(!config.app?.security?.dangerousDisableAssetCspModification, 'Tauri keeps adding nonces/hashes to bundled assets');
	assert.ok(!config.app?.withGlobalTauri, 'the IPC bridge is not exposed as a global to every script');
});

test('no window, in any platform config, starts on a remote URL', () => {
	for (const file of CONFIGS) {
		const config = json(file);
		assert.ok(!config.app?.security?.csp || file === 'tauri.conf.json' || config.app.security.csp === json('tauri.conf.json').app.security.csp, `${file} does not replace the CSP`);
		assert.ok(!config.app?.security?.dangerousDisableAssetCspModification, `${file}: asset CSP modification stays on`);
		assert.ok(!config.app?.withGlobalTauri, `${file}: no global IPC bridge`);
		if (config.build?.frontendDist) assert.ok(!/^[a-z]+:/i.test(config.build.frontendDist), `${file}: frontendDist is a local path`);
		for (const window of config.app?.windows ?? []) {
			assert.ok(!window.url || !/^[a-z][a-z0-9+.-]*:/i.test(window.url), `${file}: window ${window.label ?? '(default)'} must load a bundled path, not ${window.url}`);
		}
	}
});

test('capabilities grant no remote origin and no filesystem, shell, opener, http or updater permission', () => {
	const allowed = new Set([
		'core:default',
		'core:window:allow-close',
		'core:window:allow-show',
		'core:window:allow-minimize',
		'core:window:allow-toggle-maximize',
		'core:window:allow-internal-toggle-maximize',
		'core:window:allow-start-dragging',
		'core:window:allow-set-decorations',
		'core:window:allow-start-resize-dragging',
		'notification:allow-is-permission-granted',
		'notification:allow-request-permission',
		'notification:allow-notify'
	]);
	const files = readdirSync(path.join(tauri, 'capabilities')).filter((name) => name.endsWith('.json'));
	assert.ok(files.length >= 1);
	for (const file of files) {
		const capability = json(path.join('capabilities', file));
		assert.equal(capability.remote, undefined, `${file}: no remote origin may use a capability`);
		for (const permission of capability.permissions ?? []) {
			const id = typeof permission === 'string' ? permission : permission.identifier;
			assert.ok(allowed.has(id), `${file}: permission ${JSON.stringify(permission)} is not in the reviewed set`);
		}
	}
});

test('every registered native command checks that the caller is the bundled frontend', () => {
	const sources = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.rs')) sources.set(full, readFileSync(full, 'utf8'));
		}
	};
	walk(path.join(tauri, 'src'));
	const lib = sources.get(path.join(tauri, 'src', 'lib.rs'));
	const handler = lib.match(/generate_handler!\[([\s\S]*?)\]/);
	assert.ok(handler, 'lib.rs registers commands with generate_handler!');
	const commands = handler[1].split(',').map((value) => value.trim()).filter(Boolean).map((value) => value.split('::').pop());
	assert.ok(commands.length > 20, 'the harness found the command list');

	// Commands that may run from any page: they read nothing private and change nothing.
	const harmless = new Map([
		['greet', 'returns a greeting string'],
		['get_platform', 'returns the OS name'],
		['tailcat_status', 'reports whether the tunnel runs and its local ports'],
		['tailcat_disconnect', 'stops the tunnel; also called by the app on quit']
	]);
	// A body counts as guarded if it calls one of the origin checks (directly or via grant()).
	const GUARDS = /require_bundled_window\(|hosting::authorize\(|(?<![a-z_])authorize\(&window\)|local_main_origin\(|trusted\(&window\)|grant\(&state, &window/;
	const bodyOf = (name) => {
		for (const source of sources.values()) {
			const pattern = new RegExp(`#\\[tauri::command\\]\\s*pub (?:async )?fn ${name}\\s*[<(]`, 'g');
			const bodies = [];
			for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
				const start = source.indexOf('{', match.index);
				let depth = 0;
				for (let index = start; index < source.length; index++) {
					if (source[index] === '{') depth++;
					else if (source[index] === '}' && --depth === 0) { bodies.push(source.slice(start, index + 1)); break; }
				}
			}
			if (bodies.length) return bodies;
		}
		return [];
	};
	const unguarded = [];
	for (const name of commands) {
		const bodies = bodyOf(name);
		assert.ok(bodies.length, `found the source of command ${name}`);
		if (harmless.has(name)) continue;
		// Mobile stubs that only return an error are fine; every real body must be guarded.
		const real = bodies.filter((body) => !/^\{\s*(?:\/\/[^\n]*\s*)*(?:let _ = [^;]+;\s*(?:\/\/[^\n]*\s*)*)?Err\(/.test(body));
		if (real.some((body) => !GUARDS.test(body))) unguarded.push(name);
	}
	assert.deepEqual(unguarded, [], 'native commands without an origin check');
});

test('external links opened natively are http(s) only', () => {
	const source = readFileSync(path.join(tauri, 'src', 'shell_commands.rs'), 'utf8');
	assert.match(source, /"http" \| "https" => Ok\(\(\)\)/, 'open_external_url keeps its http(s)-only scheme check');
});
