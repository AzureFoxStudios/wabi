import { isRunningInTauri, loadTauriData, saveTauriData, type WabiData } from './tauri-storage';
import { chatStorage } from './storage';
import { get } from 'svelte/store';
import { channels, channelMessages } from './socket';

/**
 * Migrate data from IndexedDB to Tauri sidecar files
 * Only runs if:
 * 1. App is running in Tauri
 * 2. No data currently exists in Tauri storage
 * 3. Data exists in IndexedDB
 */
export async function migrateTauriData(): Promise<boolean> {
	if (!isRunningInTauri()) {
		console.log('[Migration] Not running in Tauri, skipping migration');
		return false;
	}

	try {
		// Check if data already exists in Tauri
		const existingData = await loadTauriData();
		if (existingData) {
			console.log('[Migration] Data already exists in Tauri storage, skipping migration');
			return false;
		}

		console.log('[Migration] Starting IndexedDB to Tauri migration...');

		// Load all data from IndexedDB
		const indexedDbMessages = await chatStorage.loadAllMessages();

		// Get current channel list from socket store
		const channelsList = get(channels);

		// Create migration data
		const migrationData: WabiData = {
			version: '1.0',
			exported_at: Date.now(),
			messages: indexedDbMessages,
			settings: {
				channels: channelsList,
				migrated_from: 'indexeddb',
				migration_date: new Date().toISOString()
			}
		};

		// Save to Tauri
		const result = await saveTauriData(migrationData);
		console.log('[Migration] Migration complete:', result);

		return true;
	} catch (error) {
		console.error('[Migration] Migration failed:', error);
		// Don't throw - allow app to continue even if migration fails
		return false;
	}
}

/**
 * Load migrated data from Tauri into memory
 * Loads messages into the channel store if available
 */
export async function loadMigratedTauriData(): Promise<void> {
	if (!isRunningInTauri()) {
		console.log('[Migration] Not running in Tauri, skipping load');
		return;
	}

	try {
		const data = await loadTauriData();
		if (!data) {
			console.log('[Migration] No migrated data found in Tauri');
			return;
		}

		console.log('[Migration] Loaded migrated data from Tauri:', {
			version: data.version,
			exported_at: new Date(data.exported_at).toISOString(),
			messageChannels: Object.keys(data.messages).length,
			settings: Object.keys(data.settings)
		});

		// Note: The actual loading of messages into the app's channel stores
		// should happen elsewhere (e.g., in socket.ts when initializing)
		// This function just verifies the data is there and can be accessed
	} catch (error) {
		console.error('[Migration] Failed to load migrated data:', error);
	}
}
