/**
 * Lets a bun test import real `.svelte` components compiled for the server (svelte/server render).
 * Imports resolve normally ($lib via tsconfig paths), so a component renders with its real
 * children and helpers. Effects and onMount do not run; legacy `$:` statements and markup do.
 */
import { plugin } from 'bun';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';

let registered = false;

export function registerSvelteServerPlugin(): void {
	if (registered) return;
	registered = true;
	plugin({
		name: 'svelte-server-test',
		setup(build) {
			build.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
				const source = readFileSync(path, 'utf8');
				const { js } = compile(source, { filename: path, generate: 'server', css: 'external' });
				return { contents: js.code, loader: 'ts' };
			});
		}
	});
}
