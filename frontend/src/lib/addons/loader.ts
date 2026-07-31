/**
 * Addon Loader Runtime
 * 
 * Dynamically loads, enables, disables, and unloads addons at runtime.
 * No page reload required.
 */

import type { AddonManifest, AddonInstance, AddonState } from './registry';
import { addonRegistry, addAddon, updateAddonState } from './registry';
import { getAddonConfig, saveAddonConfig } from './settings';
import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '../serverUrl';

const loadedAddons = new Map<string, AddonInstance>();

/**
 * Load an addon by ID
 * - Fetches manifest from registry
 * - Dynamically imports frontend entry point
 * - Initializes addon lifecycle
 * - Returns AddonInstance or throws
 */
export async function loadAddon(addonId: string): Promise<AddonInstance> {
	if (loadedAddons.has(addonId)) {
		console.log(`[Addons] Already loaded: ${addonId}`);
		return loadedAddons.get(addonId)!;
	}

	console.log(`[Addons] Loading: ${addonId}`);
	updateAddonState(addonId, { status: 'loading' });

	try {
		// Get manifest from registry
		const manifest = await fetchAddonManifest(addonId);
		if (!manifest) {
			throw new Error(`Addon not found: ${addonId}`);
		}

		// Check dependencies
		if (manifest.dependencies) {
			for (const dep of manifest.dependencies) {
				if (!loadedAddons.has(dep)) {
					console.warn(`[Addons] Missing dependency: ${dep} for ${addonId}`);
					// Try to load dependency
					try {
						await loadAddon(dep);
					} catch (err) {
						throw new Error(`Failed to load dependency ${dep}: ${err}`);
					}
				}
			}
		}

		// Load frontend entry point
		let frontendModule: any = null;
		if (manifest.frontendEntry) {
			try {
				frontendModule = await import(manifest.frontendEntry);
			} catch (err) {
				console.warn(`[Addons] Failed to load frontend for ${addonId}:`, err);
			}
		}

		// Create addon instance
		const instance: AddonInstance = {
			id: addonId,
			manifest,
			frontendModule,
			config: await getAddonConfig(addonId),
			enabled: false,
			loadedAt: Date.now()
		};

		loadedAddons.set(addonId, instance);
		addAddon(instance);
		updateAddonState(addonId, { status: 'loaded' });

		console.log(`[Addons] Loaded: ${addonId} v${manifest.version}`);
		return instance;

	} catch (error) {
		updateAddonState(addonId, { status: 'error', error: String(error) });
		console.error(`[Addons] Failed to load ${addonId}:`, error);
		throw error;
	}
}

/**
 * Unload an addon
 * - Calls addon's cleanup hook if exists
 * - Removes from registry
 * - Frees memory
 */
export function unloadAddon(addonId: string): void {
	const instance = loadedAddons.get(addonId);
	if (!instance) {
		console.warn(`[Addons] Not loaded: ${addonId}`);
		return;
	}

	console.log(`[Addons] Unloading: ${addonId}`);

	// Call cleanup hook if exists
	if (instance.frontendModule?.onUnload) {
		try {
			instance.frontendModule.onUnload();
		} catch (err) {
			console.error(`[Addons] Cleanup error for ${addonId}:`, err);
		}
	}

	// Remove from registry
	loadedAddons.delete(addonId);
	addonRegistry.update(addons => addons.filter(a => a.id !== addonId));

	console.log(`[Addons] Unloaded: ${addonId}`);
}

/**
 * Enable an addon
 * - Calls addon's init hook
 * - Marks as enabled in registry
 * - Persists to user config
 */
export async function enableAddon(addonId: string): Promise<void> {
	const instance = loadedAddons.get(addonId);
	if (!instance) {
		await loadAddon(addonId);
	}

	const loadedInstance = loadedAddons.get(addonId)!;
	
	console.log(`[Addons] Enabling: ${addonId}`);

	// Call init hook if exists
	if (loadedInstance.frontendModule?.onInit) {
		try {
			await loadedInstance.frontendModule.onInit(loadedInstance.config);
		} catch (err) {
			console.error(`[Addons] Init error for ${addonId}:`, err);
			throw err;
		}
	}

	loadedInstance.enabled = true;
	updateAddonState(addonId, { enabled: true });
	await saveAddonConfig(addonId, loadedInstance.config);

	console.log(`[Addons] Enabled: ${addonId}`);
}

/**
 * Disable an addon
 * - Calls addon's disable hook
 * - Marks as disabled in registry
 * - Persists to user config
 */
export async function disableAddon(addonId: string): Promise<void> {
	const instance = loadedAddons.get(addonId);
	if (!instance) {
		console.warn(`[Addons] Not loaded: ${addonId}`);
		return;
	}

	console.log(`[Addons] Disabling: ${addonId}`);

	// Call disable hook if exists
	if (instance.frontendModule?.onDisable) {
		try {
			await instance.frontendModule.onDisable();
		} catch (err) {
			console.error(`[Addons] Disable error for ${addonId}:`, err);
		}
	}

	instance.enabled = false;
	updateAddonState(addonId, { enabled: false });
	await saveAddonConfig(addonId, instance.config);

	console.log(`[Addons] Disabled: ${addonId}`);
}

/**
 * Get all enabled addons
 */
export function getEnabledAddons(): AddonInstance[] {
	return Array.from(loadedAddons.values()).filter(a => a.enabled);
}

/**
 * Get addon by ID
 */
export function getAddon(addonId: string): AddonInstance | undefined {
	return loadedAddons.get(addonId);
}

/**
 * Get all loaded addons
 */
export function getAllAddons(): AddonInstance[] {
	return Array.from(loadedAddons.values());
}

/**
 * Fetch addon manifest from server or local registry
 */
async function fetchAddonManifest(addonId: string): Promise<AddonManifest | null> {
	// Try server first
	try {
		// Finding 9: use scoped authSession token, not dead localStorage 'auth_token'
		const token = getAuthToken(getServerUrl());
		const response = await fetch(`${getServerUrl()}/api/addons/${addonId}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : undefined
		});
		if (response.ok) {
			return await response.json();
		}
	} catch (err) {
		console.warn(`[Addons] Server fetch failed for ${addonId}, using local`);
	}

	// Fallback: local manifest
	// Note: `model-viewer` (three.js) is intentionally omitted here so it is only
	// resolvable from the server and never bundled into the desktop Tauri build.
	const localManifests: Record<string, AddonManifest> = {
		'youtube-sync': {
			id: 'youtube-sync',
			name: 'YouTube Watch Together',
			version: '1.0.0',
			frontendEntry: '$lib/components/plugins/YouTubeWatchEmbed.svelte',
			dependencies: []
		},
		'spotify-sync': {
			id: 'spotify-sync',
			name: 'Spotify Sync',
			version: '1.0.0',
			frontendEntry: '$lib/components/plugins/SpotifyControlsEmbed.svelte',
			dependencies: []
		}
	};

	return localManifests[addonId] || null;
}

/**
 * Initialize addon system on app startup
 * - Load user's enabled addons from config
 * - Auto-load and enable them
 */
export async function initializeAddons(): Promise<void> {
	console.log('[Addons] Initializing...');

	// Get user's enabled addons from config
	const enabledAddonIds = await getEnabledAddonIds();

	// Load and enable each
	for (const addonId of enabledAddonIds) {
		try {
			await loadAddon(addonId);
			await enableAddon(addonId);
		} catch (err) {
			console.error(`[Addons] Failed to initialize ${addonId}:`, err);
		}
	}

	console.log(`[Addons] Initialized ${enabledAddonIds.length} addons`);
}

/**
 * Get user's enabled addon IDs from IndexedDB
 */
async function getEnabledAddonIds(): Promise<string[]> {
	try {
		const config = await getAddonConfig('_user_enabled');
		return config?.addonIds || [];
	} catch (err) {
		console.warn('[Addons] Failed to get enabled addon IDs:', err);
		return [];
	}
}

/**
 * Save user's enabled addon IDs to IndexedDB
 */
export async function saveEnabledAddonIds(addonIds: string[]): Promise<void> {
	await saveAddonConfig('_user_enabled', { addonIds });
}
