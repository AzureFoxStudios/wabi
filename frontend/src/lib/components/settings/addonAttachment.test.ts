// How an add-on is attached, and whether the owner can detach it from the app,
// must survive the trip from GET /api/addons to the Settings → Add-ons row.
//
// Both halves of this were broken: the server inventory's `runtimeSwitch`,
// `compiled`, `cargoFeature` and `runtimeEnv` were dropped by addonDetection's
// mapper, so every server add-on rendered as locked ("Part of this server,
// fixed when the server was set up") and the in-app switch documented in
// docs/addons/ATTACH_DETACH.md could not be reached; and `hasAddonCapability()`
// answered `true` for `steam` and `game-sync` from a bundled-frontend
// allowlist without ever asking the server.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { fetchPluginInventory, pluginBackendAddons } from './addonDetection';

// The bundled-component glob is a Vite transform; under `bun test` it is stubbed
// to the components this build really has, so the allowlist logic is exercised
// rather than skipped.
mock.module('$lib/addons/bundledPluginModules', () => ({
	bundledPluginComponentPaths: () => [
		'../components/plugins/SteamJoinButton.svelte',
		'../components/plugins/YouTubeWatchEmbed.svelte',
		'../components/plugins/ServerMap.svelte'
	]
}));

const { hasAddonCapability, resetAddonCapabilityCache } = await import('$lib/addonInventory');

/** One add-on exactly as the Rust inventory serializes it (serde camelCase). */
function capability(over: Record<string, unknown> = {}) {
	return {
		id: 'steam',
		name: 'Steam',
		version: '0.1.0',
		description: 'Verified account linking',
		enabled: false,
		compiled: true,
		backendRuntime: 'rust',
		cargoFeature: null,
		runtimeEnv: 'WABI_STEAM_ENABLED',
		runtimeSwitch: true,
		permissions: [],
		frontend: { bundled: true, contributions: {} },
		...over
	};
}

/** Answer every fetch with this `/api/addons` body for the duration of `body`. */
async function withInventory<T>(addons: Array<Record<string, unknown>>, body: () => Promise<T>) {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ addons }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		})) as unknown as typeof fetch;
	try {
		return await body();
	} finally {
		globalThis.fetch = original;
	}
}

const SERVER = 'http://127.0.0.1:65535';

describe('attachment facts reach the Settings → Add-ons row', () => {
	test('a switchable add-on keeps its switch, feature and env var', async () => {
		const rows = await withInventory([capability()], async () =>
			pluginBackendAddons((await fetchPluginInventory(SERVER, null)) ?? [])
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe('steam');
		expect(rows[0].runtimeSwitch).toBe(true);
		expect(rows[0].compiled).toBe(true);
		expect(rows[0].runtimeEnv).toBe('WABI_STEAM_ENABLED');
		expect(rows[0].enabled).toBe(false);
	});

	test('a compile-time-only add-on stays locked and names its cargo feature', async () => {
		const rows = await withInventory(
			[
				capability({
					id: 'webhooks',
					name: 'Webhooks',
					cargoFeature: 'wabi-webhooks',
					runtimeEnv: null,
					runtimeSwitch: false
				})
			],
			async () => pluginBackendAddons((await fetchPluginInventory(SERVER, null)) ?? [])
		);
		expect(rows[0].runtimeSwitch).toBe(false);
		expect(rows[0].cargoFeature).toBe('wabi-webhooks');
		expect(rows[0].runtimeEnv).toBeNull();
	});
});

describe('backend-backed add-ons follow the server inventory', () => {
	afterEach(() => {
		resetAddonCapabilityCache();
	});

	test('steam and game-sync are not assumed available by the bundled allowlist', async () => {
		// A lean core server: nothing enabled, nothing in the list.
		await withInventory([], async () => {
			expect(await hasAddonCapability('steam')).toBe(false);
			expect(await hasAddonCapability('game-sync')).toBe(false);
		});
	});

	test('a server that reports them enabled makes them available', async () => {
		await withInventory(
			[
				capability({ id: 'steam', enabled: true }),
				capability({ id: 'game-sync', name: 'Game Sync', enabled: true })
			],
			async () => {
				expect(await hasAddonCapability('steam')).toBe(true);
				expect(await hasAddonCapability('game-sync')).toBe(true);
			}
		);
	});

	test('a server that reports them switched off keeps their UI out', async () => {
		await withInventory(
			[
				capability({ id: 'steam', enabled: false }),
				capability({ id: 'game-sync', name: 'Game Sync', enabled: false })
			],
			async () => {
				expect(await hasAddonCapability('steam')).toBe(false);
				expect(await hasAddonCapability('game-sync')).toBe(false);
			}
		);
	});

	test('client-only add-ons stay available with no server at all', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('no server');
		}) as unknown as typeof fetch;
		try {
			expect(await hasAddonCapability('translator-assist')).toBe(true);
			expect(await hasAddonCapability('youtube-sync')).toBe(true);
		} finally {
			globalThis.fetch = original;
		}
	});
});
