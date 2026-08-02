import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build as viteBuild } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const env = { ...process.env };

if (!env.TAURI_ENV_PLATFORM) {
	if (process.platform === 'win32') {
		env.TAURI_ENV_PLATFORM = 'windows';
	} else if (process.platform === 'darwin') {
		env.TAURI_ENV_PLATFORM = 'macos';
	} else {
		env.TAURI_ENV_PLATFORM = process.platform;
	}
}

// vite.config.ts / svelte.config.js read TAURI_ENV_PLATFORM from the
// environment at config-eval time, so it must be set on process.env too
// (the JS API build below runs in-process, not in a spawned child).
process.env.TAURI_ENV_PLATFORM = env.TAURI_ENV_PLATFORM;

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const viteCliPath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const assetDir = join(appRoot, 'build');

// CodeMirror 6 modules. In the Tauri build these are forced into a single
// named chunk (`codemirror-<hash>.js`) so the desktop editor is easy to
// find. The web build never references them (the editor is only reachable
// through a Tauri-only dynamic import), so no chunk is emitted for it.
const CODEMIRROR_MODULES = [
	'@codemirror/view',
	'@codemirror/state',
	'@codemirror/commands',
	'@codemirror/theme-one-dark',
	'@codemirror/lang-javascript',
	'@codemirror/lang-css',
	'@codemirror/lang-html',
	'@codemirror/lang-json',
	'@codemirror/lang-markdown',
	'@codemirror/lang-python',
	'@codemirror/lang-rust',
	'@codemirror/lang-cpp',
	'@codemirror/lang-go',
	'@codemirror/lang-java'
];

function findCodeMirrorChunks(dir) {
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
			} else if (/^codemirror-.+\.(js|mjs)$/.test(entry)) {
				found.push(path.replace(appRoot + '/', ''));
			}
		}
	};
	walk(dir);
	return found;
}

function hasCodeMirrorInAssetDir() {
	if (!existsSync(assetDir)) return false;
	// Standalone editor bundle emitted by buildStandaloneEditor().
	if (existsSync(join(assetDir, 'codemirror', 'codemirror.js'))) return true;
	return findCodeMirrorChunks(assetDir).length > 0;
}

async function buildWithViteJsApi() {
	try {
		await viteBuild({
			root: appRoot,
			configFile: join(appRoot, 'vite.config.ts'),
			build: {
				rollupOptions: {
					output: {
						manualChunks: {
							codemirror: CODEMIRROR_MODULES
						}
					}
				}
			}
		});
		console.log('[build:tauri] Vite build complete (CodeMirror manual chunk configured).');
		return true;
	} catch (error) {
		console.error('[build:tauri] JS API build failed, falling back to CLI:', error);
		return false;
	}
}

function buildWithCli() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [viteCliPath, 'build'], {
			stdio: 'inherit',
			env,
			cwd: appRoot
		});

		child.on('error', (error) => {
			console.error('[build:tauri] Failed to start build process:', error);
			resolve(false);
		});

		child.on('exit', (code, signal) => {
			if (signal) {
				console.error(`[build:tauri] Build terminated by signal ${signal}`);
				resolve(false);
			} else {
				resolve(code === 0);
			}
		});
	});
}

// Guarantee the CodeMirror editor ships in the Tauri asset dir even before
// a screen mounts the editor panel: emit it as a standalone ES bundle at
// build/codemirror/codemirror.js. Skipped once the app itself bundles CM.
async function buildStandaloneEditor() {
	const outDir = join(assetDir, 'codemirror');
	console.log('[build:tauri] No SPA CodeMirror chunk — emitting standalone editor bundle.');
		try {
			await viteBuild({
				root: appRoot,
				configFile: false,
				plugins: [svelte()],
				build: {
				outDir,
				emptyOutDir: false,
				target: 'ES2021',
				cssCodeSplit: false,
				lib: {
					entry: join(appRoot, 'src/lib/editor/CodeMirrorEditor.svelte'),
					formats: ['es'],
					fileName: () => 'codemirror.js'
				}
			}
		});
	} catch (error) {
		console.error('[build:tauri] Standalone CodeMirror bundle failed:', error);
		return false;
	}
	return existsSync(join(outDir, 'codemirror.js'));
}

async function main() {
	const jsOk = await buildWithViteJsApi();
	const ok = jsOk || (await buildWithCli());
	if (!ok) process.exit(1);

	if (!existsSync(assetDir)) {
		console.error('[build:tauri] Tauri asset dir missing after build:', assetDir);
		process.exit(1);
	}

	if (!hasCodeMirrorInAssetDir()) {
		const standalone = await buildStandaloneEditor();
		if (!standalone) {
			console.error(
				'[build:tauri] CodeMirror bundle could not be emitted into the Tauri asset dir.'
			);
			process.exit(1);
		}
	}

	if (existsSync(join(assetDir, 'codemirror', 'codemirror.js'))) {
		console.log('[build:tauri] CodeMirror bundle included in asset dir: build/codemirror/codemirror.js');
	} else {
		console.log('[build:tauri] CodeMirror bundle(s) included in asset dir:');
		for (const file of findCodeMirrorChunks(assetDir)) console.log('  -', file);
	}
}

main();
