/**
 * Addon Settings Storage
 * 
 * Persists addon configuration to IndexedDB.
 * Each addon gets its own config namespace.
 */

import { BROWSER } from 'esm-env';

const DB_NAME = 'wabi-addons';
const DB_VERSION = 1;
const STORE_NAME = 'addon_configs';

let db: IDBDatabase | null = null;

/**
 * Initialize IndexedDB connection
 */
async function getDB(): Promise<IDBDatabase> {
	if (db) return db;

	return new Promise((resolve, reject) => {
		if (!BROWSER) {
			reject(new Error('IndexedDB not available in SSR'));
			return;
		}

		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			db = request.result;
			resolve(db);
		};

		request.onupgradeneeded = (event) => {
			const database = (event.target as IDBOpenDBRequest).result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME, { keyPath: 'id' });
			}
		};
	});
}

/**
 * Get addon configuration
 */
export async function getAddonConfig(addonId: string): Promise<any> {
	if (!BROWSER) return {};

	try {
		const database = await getDB();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction([STORE_NAME], 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get(addonId);

			request.onsuccess = () => {
				resolve(request.result?.config || {});
			};

			request.onerror = () => {
				reject(request.error);
			};
		});
	} catch (err) {
		console.warn(`[AddonConfig] Failed to get config for ${addonId}:`, err);
		return {};
	}
}

/**
 * Save addon configuration
 */
export async function saveAddonConfig(addonId: string, config: any): Promise<void> {
	if (!BROWSER) return;

	try {
		const database = await getDB();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction([STORE_NAME], 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put({ id: addonId, config, updatedAt: Date.now() });

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} catch (err) {
		console.error(`[AddonConfig] Failed to save config for ${addonId}:`, err);
		throw err;
	}
}

/**
 * Delete addon configuration
 */
export async function deleteAddonConfig(addonId: string): Promise<void> {
	if (!BROWSER) return;

	try {
		const database = await getDB();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction([STORE_NAME], 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.delete(addonId);

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} catch (err) {
		console.error(`[AddonConfig] Failed to delete config for ${addonId}:`, err);
		throw err;
	}
}

/**
 * Get all addon configurations
 */
export async function getAllAddonConfigs(): Promise<Map<string, any>> {
	if (!BROWSER) return new Map();

	try {
		const database = await getDB();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction([STORE_NAME], 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.getAll();

			request.onsuccess = () => {
				const configs = new Map<string, any>();
				for (const record of request.result || []) {
					configs.set(record.id, record.config);
				}
				resolve(configs);
			};

			request.onerror = () => {
				reject(request.error);
			};
		});
	} catch (err) {
		console.error('[AddonConfig] Failed to get all configs:', err);
		return new Map();
	}
}

/**
 * Clear all addon configurations (reset to defaults)
 */
export async function clearAllAddonConfigs(): Promise<void> {
	if (!BROWSER) return;

	try {
		const database = await getDB();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction([STORE_NAME], 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.clear();

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} catch (err) {
		console.error('[AddonConfig] Failed to clear all configs:', err);
		throw err;
	}
}

/**
 * Export all addon configs (for backup)
 */
export async function exportAddonConfigs(): Promise<string> {
	const configs = await getAllAddonConfigs();
	const exportData: Record<string, any> = {};
	
	for (const [id, config] of Array.from(configs.entries())) {
		exportData[id] = config;
	}

	return JSON.stringify(exportData, null, 2);
}

/**
 * Import addon configs (from backup)
 */
export async function importAddonConfigs(json: string): Promise<void> {
	try {
		const configs = JSON.parse(json);
		for (const [id, config] of Object.entries(configs)) {
			await saveAddonConfig(id, config);
		}
		console.log('[AddonConfig] Imported configs for', Object.keys(configs).length, 'addons');
	} catch (err) {
		console.error('[AddonConfig] Failed to import configs:', err);
		throw err;
	}
}
