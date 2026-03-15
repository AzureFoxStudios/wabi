import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';

interface PluginApiRecord {
	id?: string;
	name?: string;
	version?: string;
	signerKeyId?: string | null;
	frontendEntry?: string | null;
	backendEntry?: string | null;
	hasFrontend?: boolean;
	hasBackend?: boolean;
}

const frontendAddonModules = import.meta.glob('./components/plugins/*.svelte');

function detectBuiltinFrontendAddonIds(): Set<string> {
	const ids = new Set<string>();
	for (const path of Object.keys(frontendAddonModules)) {
		const fileName = path.split('/').pop()?.replace('.svelte', '') || path;
		if (fileName === 'ModelViewer3D') {
			ids.add('model-viewer');
			continue;
		}
		ids.add(
			fileName
				.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
				.replace(/[_\s]+/g, '-')
				.toLowerCase()
		);
	}
	return ids;
}

export async function fetchPluginInventory(): Promise<PluginApiRecord[] | null> {
	const token = getAuthToken();
	try {
		const response = await fetch(`${getServerUrl()}/api/plugins`, {
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

export async function hasAddonCapability(addonId: string): Promise<boolean> {
	const normalizedId = addonId.trim().toLowerCase();
	if (!normalizedId) return false;

	const builtinIds = detectBuiltinFrontendAddonIds();
	if (builtinIds.has(normalizedId)) {
		return true;
	}

	const plugins = await fetchPluginInventory();
	if (!plugins) return false;
	return plugins.some((plugin) => String(plugin.id || '').trim().toLowerCase() === normalizedId);
}
