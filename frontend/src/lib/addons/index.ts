/**
 * Addon System Exports
 * 
 * Central export point for all addon runtime functionality.
 */

// Core runtime
export {
	loadAddon,
	unloadAddon,
	enableAddon,
	disableAddon,
	getEnabledAddons,
	getAddon,
	getAllAddons,
	initializeAddons,
	saveEnabledAddonIds
} from './loader';

// Registry
export {
	addonRegistry,
	addAddon,
	removeAddon,
	updateAddonState,
	getAddonFromRegistry,
	getEnabledFromRegistry,
	subscribeToRegistry,
	type AddonManifest,
	type AddonInstance,
	type AddonConfig,
	type AddonState,
	type WorkspacePanelManifest,
	type SettingsPageManifest
} from './registry';

// Settings storage
export {
	getAddonConfig,
	saveAddonConfig,
	deleteAddonConfig,
	getAllAddonConfigs,
	clearAllAddonConfigs,
	exportAddonConfigs,
	importAddonConfigs
} from './settings';
