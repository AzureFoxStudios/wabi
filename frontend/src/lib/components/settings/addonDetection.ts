/**
 * Addon detection helpers for Settings → Addons tab.
 *
 * Inventory comes from GET /api/addons (same as $lib/addonInventory).
 * Package install (.wabip / POST /api/plugins/install) is removed (A4/A5).
 */

import { parseApiJson } from '$lib/api/utils';
import { isEndpointUnsupported, markEndpointUnsupported } from '$lib/optionalEndpoints';

export type AddonRuntimeSide = 'frontend' | 'backend';

export interface DetectedAddon {
	id: string;
	name: string;
	version: string;
	source: string;
	side: AddonRuntimeSide;
}

/** Compatibility record — same shape as $lib/addonInventory.PluginApiRecord */
export interface PluginApiRecord {
	id?: string;
	name?: string;
	version?: string;
	description?: string;
	enabled?: boolean;
	signerKeyId?: string | null;
	frontendEntry?: string | null;
	backendEntry?: string | null;
	hasFrontend?: boolean;
	hasBackend?: boolean;
	frontendExtensions?: {
		workspacePanels?: any[];
		mobileTabs?: any[];
		settingsPages?: any[];
		channelTypes?: string[];
	};
	workspacePanels?: any[];
	permissions?: string[];
}

interface AddonCapabilityRecord {
	id: string;
	name: string;
	version: string;
	description?: string;
	enabled?: boolean;
	backendRuntime?: string;
	cargoFeature?: string | null;
	permissions?: string[];
	frontend?: {
		bundled?: boolean;
		contributions?: {
			channelTypes?: string[];
			workspacePanels?: unknown[];
			settingsPages?: unknown[];
			mobileTabs?: unknown[];
		};
	};
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

function capabilityToPluginRecord(cap: AddonCapabilityRecord): PluginApiRecord {
	const contrib = cap.frontend?.contributions;
	const bundled = Boolean(cap.frontend?.bundled);
	const hasBackend = Boolean(cap.backendRuntime);
	return {
		id: cap.id,
		name: cap.name,
		version: cap.version,
		description: cap.description,
		enabled: cap.enabled !== false,
		hasFrontend: bundled,
		hasBackend,
		frontendEntry: bundled ? `bundled:${cap.id}` : null,
		backendEntry: hasBackend ? `rust:${cap.backendRuntime || 'rust'}` : null,
		permissions: cap.permissions || [],
		frontendExtensions: {
			workspacePanels: (contrib?.workspacePanels as any[]) || [],
			mobileTabs: (contrib?.mobileTabs as any[]) || [],
			settingsPages: (contrib?.settingsPages as any[]) || [],
			channelTypes: contrib?.channelTypes || []
		},
		workspacePanels: (contrib?.workspacePanels as any[]) || []
	};
}

/**
 * Fetch enabled addons from GET /api/addons.
 * Signature kept for AddonSettingsTab (serverUrl, token).
 */
export async function fetchPluginInventory(
	serverUrl: string,
	token: string | null
): Promise<PluginApiRecord[] | null> {
	const base = serverUrl.replace(/\/$/, '');
	const addonsUrl = `${base}/api/addons`;
	if (isEndpointUnsupported(addonsUrl)) return null;

	try {
		const response = await fetch(addonsUrl, {
			headers: token ? { Authorization: `Bearer ${token}` } : undefined
		});
		if (!response.ok) {
			if (response.status === 404 || response.status === 405) {
				markEndpointUnsupported(addonsUrl);
			}
			return null;
		}
		// SPA fallback often returns 200 text/html — treat like missing endpoint.
		const payload = await parseApiJson(response);
		if (payload == null || typeof payload !== 'object') {
			markEndpointUnsupported(addonsUrl);
			return null;
		}
		const body = payload as { addons?: unknown };
		const raw: AddonCapabilityRecord[] = Array.isArray(body.addons)
			? (body.addons as AddonCapabilityRecord[])
			: Array.isArray(payload)
				? (payload as AddonCapabilityRecord[])
				: [];
		return raw
			.filter((a) => a && typeof a.id === 'string' && a.id.length > 0)
			.map(capabilityToPluginRecord);
	} catch (error) {
		// Network / unexpected only — HTML/empty already soft-failed above.
		console.warn('[Addons] Failed to detect backend add-ons:', error);
		return null;
	}
}

/** Frontend-side addons: bundled frontend entry present. */
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

/**
 * Backend-enabled addons from the server inventory.
 * Pure-backend addons (lore/mesh/webhooks) all have hasBackend=true.
 */
export function pluginBackendAddons(plugins: PluginApiRecord[]): DetectedAddon[] {
	return plugins
		.filter((plugin) => Boolean(plugin.hasBackend || plugin.backendEntry || plugin.enabled))
		.map((plugin) => ({
			id: String(plugin.id || 'unknown'),
			name: String(plugin.name || plugin.id || 'Unknown Plugin'),
			version: String(plugin.version || 'unknown'),
			source: plugin.signerKeyId
				? `signer:${plugin.signerKeyId}`
				: String(plugin.backendEntry || 'api/addons'),
			side: 'backend' as const
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
