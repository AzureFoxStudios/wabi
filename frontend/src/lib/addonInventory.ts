import { getAuthToken } from '$lib/authSession';
import { parseApiJson } from './api/utils';
import { getServerUrl } from '$lib/serverUrl';
import { isEndpointUnsupported, markEndpointUnsupported } from './optionalEndpoints';

/**
 * Canonical addon capability from GET /api/addons (A2/A3).
 * Server shape is camelCase via serde rename_all.
 */
export interface AddonCapabilityRecord {
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

/**
 * Compatibility shape used by RightPanel / workspacePanels / settings.
 * Derived from AddonCapabilityRecord so callers keep working without
 * knowing the A2 response shape.
 */
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

// ModelViewer3D (three.js) is intentionally excluded: on desktop Tauri builds it
// is NOT bundled (native wgpu viewer is the default) and is only loaded at runtime
// when a server-provided `model-viewer` addon is present. On web it is imported
// directly by ModelViewerLauncher.
const frontendAddonModules = import.meta.glob([
	'./components/plugins/*.svelte',
	'!./components/plugins/ModelViewer3D.svelte'
]);

/** Bundled frontend allowlist IDs (must match loader.ts BUNDLED_ADDON_LOADERS). */
const BUNDLED_FRONTEND_IDS = new Set(['youtube-sync', 'spotify-sync']);

function detectBuiltinFrontendAddonIds(): Set<string> {
	const ids = new Set<string>(BUNDLED_FRONTEND_IDS);
	for (const path of Object.keys(frontendAddonModules)) {
		const fileName = path.split('/').pop()?.replace('.svelte', '') || path;
		ids.add(
			fileName
				.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
				.replace(/[_\s]+/g, '-')
				.toLowerCase()
		);
	}
	return ids;
}

/** Map A2 AddonCapability → PluginApiRecord for existing consumers. */
export function capabilityToPluginRecord(cap: AddonCapabilityRecord): PluginApiRecord {
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
		// Never a remote URL — only a marker when bundled (Finding 14).
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
 * Fetch enabled addons from the canonical server endpoint.
 * GET /api/addons → { addons: AddonCapability[] }
 *
 * Name kept as fetchPluginInventory for call-site stability (RightPanel, etc.).
 */
export async function fetchPluginInventory(): Promise<PluginApiRecord[] | null> {
	const token = getAuthToken();
	const addonsUrl = `${getServerUrl()}/api/addons`;
	if (isEndpointUnsupported(addonsUrl)) return null;

	try {
		const response = await fetch(addonsUrl, {
			headers: token ? { Authorization: `Bearer ${token}` } : undefined
		});
		if (!response.ok) {
			// Missing route / method — remember and soft-fail (no console spam).
			if (response.status === 404 || response.status === 405) {
				markEndpointUnsupported(addonsUrl);
			}
			return null;
		}
		// Tim/SPA often returns 200 text/html for missing /api/addons — treat like 404.
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

/**
 * True if this client/build can use the named addon capability.
 * Order: bundled frontend allowlist → builtin plugin modules → server inventory.
 * Never remote-imports frontend code.
 */
export async function hasAddonCapability(addonId: string): Promise<boolean> {
	const normalizedId = addonId.trim().toLowerCase();
	if (!normalizedId) return false;

	if (BUNDLED_FRONTEND_IDS.has(normalizedId)) {
		return true;
	}

	const builtinIds = detectBuiltinFrontendAddonIds();
	if (builtinIds.has(normalizedId)) {
		return true;
	}

	const plugins = await fetchPluginInventory();
	if (!plugins) return false;
	return plugins.some(
		(plugin) =>
			String(plugin.id || '')
				.trim()
				.toLowerCase() === normalizedId && plugin.enabled !== false
	);
}
