export type AddonRuntimeSide = 'frontend' | 'backend';

export interface DetectedAddon {
	id: string;
	name: string;
	version: string;
	source: string;
	side: AddonRuntimeSide;
}

export interface PluginApiRecord {
	id?: string;
	name?: string;
	version?: string;
	signerKeyId?: string | null;
	frontendEntry?: string | null;
	backendEntry?: string | null;
	hasFrontend?: boolean;
	hasBackend?: boolean;
}

function toAddonNameFromComponentFile(fileName: string): string {
	return fileName
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[-_]/g, ' ')
		.trim();
}

function getBuiltinAddonMeta(fileName: string): { id: string; name: string } | null {
	// ModelViewer3D (three.js) is no longer a builtin addon: on desktop it is
	// excluded from the bundle (native wgpu viewer is default) and only available
	// when a server-provided `model-viewer` addon is present.
	return null;
}

export function detectFrontendAddons(modulePaths: string[]): DetectedAddon[] {
	if (modulePaths.length === 0) return [];

	const addons = modulePaths.map((path) => {
		const fileName = path.split('/').pop()?.replace('.svelte', '') || path;
		const builtinMeta = getBuiltinAddonMeta(fileName);
		const addonId =
			builtinMeta?.id ||
			fileName
				.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
				.replace(/[_\s]+/g, '-')
				.toLowerCase();
		return {
			id: addonId,
			name: builtinMeta?.name || toAddonNameFromComponentFile(fileName),
			version: 'local',
			source: path,
			side: 'frontend' as const
		};
	});

	return addons.sort((a, b) => a.name.localeCompare(b.name));
}

export function mergeFrontendAddonLists(
	primary: DetectedAddon[],
	secondary: DetectedAddon[]
): DetectedAddon[] {
	const merged = new Map<string, DetectedAddon>();
	for (const addon of secondary) {
		merged.set(addon.id, addon);
	}
	for (const addon of primary) {
		merged.set(addon.id, addon);
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchPluginInventory(
	serverUrl: string,
	token: string | null
): Promise<PluginApiRecord[] | null> {
	try {
		const response = await fetch(`${serverUrl}/api/plugins`, {
			headers: token ? { Authorization: `Bearer ${token}` } : undefined
		});
		if (!response.ok) return null;
		const payload = await response.json();
		return Array.isArray(payload?.plugins) ? payload.plugins : [];
	} catch (error) {
		console.warn('[Addons] Failed to detect backend add-ons:', error);
		return null;
	}
}

export function pluginFrontendAddons(plugins: PluginApiRecord[]): DetectedAddon[] {
	return plugins
		.filter((plugin) => Boolean(plugin.hasFrontend || plugin.frontendEntry))
		.map((plugin) => ({
			id: String(plugin.id || 'unknown'),
			name: String(plugin.name || plugin.id || 'Unknown Plugin'),
			version: String(plugin.version || 'unknown'),
			source: String(plugin.frontendEntry || 'plugin-manifest'),
			side: 'frontend' as const
		}));
}

export function pluginBackendAddons(plugins: PluginApiRecord[]): DetectedAddon[] {
	return plugins
		.filter((plugin) => Boolean(plugin.hasBackend || plugin.backendEntry))
		.map((plugin) => ({
			id: String(plugin.id || 'unknown'),
			name: String(plugin.name || plugin.id || 'Unknown Plugin'),
			version: String(plugin.version || 'unknown'),
			source: plugin.signerKeyId
				? `signer:${plugin.signerKeyId}`
				: String(plugin.backendEntry || 'plugin-manifest'),
			side: 'backend' as const
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
