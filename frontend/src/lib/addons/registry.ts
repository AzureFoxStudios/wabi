/**
 * Addon Registry
 * 
 * Central registry for all addons with Svelte store for reactive state.
 */

import { writable, type Writable } from 'svelte/store';

/**
 * Addon manifest structure
 */
export interface AddonManifest {
	id: string;
	name: string;
	version: string;
	description?: string;
	author?: string;
	license?: string;
	frontendEntry?: string;
	backendEntry?: string;
	dependencies?: string[];
	permissions?: string[];
	workspacePanels?: WorkspacePanelManifest[];
	settingsPages?: SettingsPageManifest[];
}

/**
 * Workspace panel that an addon can register
 */
export interface WorkspacePanelManifest {
	id: string;
	label: string;
	icon?: string;
	component?: string;
	position?: 'left' | 'right' | 'bottom';
	order?: number;
	fallbackBehavior?: {
		title: string;
		message: string;
	};
}

/**
 * Settings page that an addon can register
 */
export interface SettingsPageManifest {
	id: string;
	label: string;
	icon?: string;
	component?: string;
}

/**
 * Runtime addon instance
 */
export interface AddonInstance {
	id: string;
	manifest: AddonManifest;
	frontendModule?: any;
	config: AddonConfig;
	enabled: boolean;
	loadedAt: number;
}

/**
 * Addon configuration
 */
export interface AddonConfig {
	[key: string]: any;
}

/**
 * Addon state for UI
 */
export interface AddonState {
	id: string;
	status: 'loading' | 'loaded' | 'error' | 'unloaded';
	enabled: boolean;
	error?: string;
}

/**
 * Registry store - reactive list of all addons
 */
export const addonRegistry: Writable<AddonInstance[]> = writable([]);

/**
 * Add an addon to the registry
 */
export function addAddon(instance: AddonInstance): void {
	addonRegistry.update(addons => {
		const existing = addons.findIndex(a => a.id === instance.id);
		if (existing >= 0) {
			addons[existing] = instance;
		} else {
			addons.push(instance);
		}
		return addons;
	});
}

/**
 * Update addon state
 */
export function updateAddonState(addonId: string, state: Partial<AddonState>): void {
	addonRegistry.update(addons => {
		return addons.map(addon => {
			if (addon.id === addonId) {
				return { ...addon, ...state };
			}
			return addon;
		});
	});
}

/**
 * Remove an addon from the registry
 */
export function removeAddon(addonId: string): void {
	addonRegistry.update(addons => addons.filter(a => a.id !== addonId));
}

/**
 * Get addon by ID from registry
 */
export function getAddonFromRegistry(addonId: string): AddonInstance | undefined {
	let result: AddonInstance | undefined;
	addonRegistry.subscribe(addons => {
		result = addons.find(a => a.id === addonId);
	})();
	return result;
}

/**
 * Get all enabled addons from registry
 */
export function getEnabledFromRegistry(): AddonInstance[] {
	let result: AddonInstance[] = [];
	addonRegistry.subscribe(addons => {
		result = addons.filter(a => a.enabled);
	})();
	return result;
}

/**
 * Subscribe to registry changes
 */
export function subscribeToRegistry(callback: (addons: AddonInstance[]) => void): () => void {
	return addonRegistry.subscribe(callback);
}
