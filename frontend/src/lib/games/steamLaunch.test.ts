/** N2: a Steam launch never navigates the desktop webview; it goes through the guarded command. */
import { beforeEach, expect, mock, test } from 'bun:test';

let tauri = true;
const invoked: Array<[string, unknown]> = [];
mock.module('$lib/tauri-platform', () => ({ isTauriRuntime: () => tauri }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: unknown) => { invoked.push([command, args]); } }));
const location = { href: 'tauri://localhost/' };
(globalThis as any).window = { location };

const { openSteamLaunch } = await import('./steamLaunch');

beforeEach(() => { invoked.length = 0; location.href = 'tauri://localhost/'; });

test('desktop: open_external_url with the exact run URL, and the page does not navigate', async () => {
	tauri = true;
	expect(await openSteamLaunch('steam:570')).toBe(true);
	expect(invoked).toEqual([['open_external_url', { url: 'steam://run/570' }]]);
	expect(location.href).toBe('tauri://localhost/');
});

test('browser: today\'s navigation; invalid keys do nothing anywhere', async () => {
	tauri = false;
	expect(await openSteamLaunch('steam:570')).toBe(true);
	expect(location.href).toBe('steam://run/570');
	location.href = 'https://wabi.example/';
	for (const key of ['steam:0570', 'steam:570/x', 'steam://connect/evil', 'local:x', 'steam:99999999999']) {
		tauri = true;
		expect(await openSteamLaunch(key)).toBe(false);
		tauri = false;
		expect(await openSteamLaunch(key)).toBe(false);
	}
	expect(invoked).toEqual([]);
	expect(location.href).toBe('https://wabi.example/');
});

test('both launch buttons use it and keep asking first (wiring)', async () => {
	const { readFileSync } = await import('node:fs');
	for (const file of ['../components/plugins/SteamJoinButton.svelte', './GamesWorkspace.svelte']) {
		const source = readFileSync(new URL(file, import.meta.url), 'utf8');
		expect(source).toMatch(/window\.confirm\('Ask (the local )?Steam[^']*'\)\) \{?void openSteamLaunch\(key\)/);
		expect(source).not.toMatch(/location\.href\s*=\s*url/);
	}
});
