import { invoke } from '@tauri-apps/api/core';
import type { Message } from './socket-types';
import { isTauriRuntime } from './tauri-platform';

export interface WabiData {
	version: string;
	exported_at: number;
	messages: Record<string, Message[]>;
	settings: Record<string, any>;
}

/**
 * Save all chat data to sidecar files
 * Organizes data as: %APPDATA%/Wabi/messages.json, %APPDATA%/Wabi/settings.json, etc.
 */
export async function saveTauriData(data: WabiData): Promise<string> {
	try {
		const result = await invoke<string>('save_wabi_data', { data });
		console.log('[Tauri Storage]', result);
		return result;
	} catch (error) {
		console.error('[Tauri Storage] Error saving data:', error);
		throw error;
	}
}

/**
 * Load all chat data from sidecar files
 */
export async function loadTauriData(): Promise<WabiData | null> {
	try {
		const result = await invoke<{ success: boolean; data?: WabiData; error?: string }>('load_wabi_data');
		if (result.success && result.data) {
			console.log('[Tauri Storage] Data loaded successfully');
			return result.data;
		} else {
			console.log('[Tauri Storage]', result.error);
			return null;
		}
	} catch (error) {
		console.error('[Tauri Storage] Error loading data:', error);
		throw error;
	}
}

/**
 * Save a single attachment file (image, video, etc.)
 * @param fileName - File name to use (e.g., "message-id-123.png")
 * @param fileData - Raw file data as base64 or binary
 */
export async function saveTauriAttachment(fileName: string, fileData: string | Uint8Array): Promise<string> {
	try {
		// Convert base64 string to Uint8Array if needed
		let data: Uint8Array;
		if (typeof fileData === 'string') {
			// If it's a base64 string starting with "data:", extract the base64 part
			const base64 = fileData.includes(',') ? fileData.split(',')[1] : fileData;
			data = new Uint8Array(atob(base64).split('').map((c) => c.charCodeAt(0)));
		} else {
			data = fileData;
		}

		const result = await invoke<string>('save_attachment', { fileName, fileData: Array.from(data) });
		console.log('[Tauri Storage]', result);
		return result;
	} catch (error) {
		console.error('[Tauri Storage] Error saving attachment:', error);
		throw error;
	}
}

/**
 * Load an attachment file from storage
 */
export async function loadTauriAttachment(fileName: string): Promise<Uint8Array> {
	try {
		const result = await invoke<number[]>('load_attachment', { fileName });
		return new Uint8Array(result);
	} catch (error) {
		console.error('[Tauri Storage] Error loading attachment:', error);
		throw error;
	}
}

/**
 * Delete an attachment file
 */
export async function deleteTauriAttachment(fileName: string): Promise<string> {
	try {
		const result = await invoke<string>('delete_attachment', { fileName });
		console.log('[Tauri Storage]', result);
		return result;
	} catch (error) {
		console.error('[Tauri Storage] Error deleting attachment:', error);
		throw error;
	}
}

/**
 * Get the path to the Wabi data directory
 */
export async function getTauriDataPath(): Promise<string> {
	try {
		const result = await invoke<string>('get_wabi_data_dir_path');
		console.log('[Tauri Storage] Data directory:', result);
		return result;
	} catch (error) {
		console.error('[Tauri Storage] Error getting data path:', error);
		throw error;
	}
}

/**
 * Export all data as a zip file
 * Returns the path to the created zip file
 */
export async function exportTauriDataAsZip(): Promise<string> {
	try {
		const result = await invoke<string>('export_data_as_zip');
		console.log('[Tauri Storage] Data exported to:', result);
		return result;
	} catch (error) {
		console.error('[Tauri Storage] Error exporting data:', error);
		throw error;
	}
}

/**
 * Clear all local Tauri data (destructive!)
 */
export async function clearTauriData(isAdmin: boolean): Promise<string> {
	try {
		if (!isAdmin) {
			throw new Error('Only admins and owners can clear local sidecar data.');
		}
		if (confirm('Are you sure? This will delete all locally stored messages and attachments. This cannot be undone.')) {
			const result = await invoke<string>('clear_wabi_data', { isAdmin });
			console.log('[Tauri Storage]', result);
			return result;
		}
		return 'Cancelled';
	} catch (error) {
		console.error('[Tauri Storage] Error clearing data:', error);
		throw error;
	}
}

/**
 * Check if running in Tauri
 */
export function isRunningInTauri(): boolean {
	return isTauriRuntime();
}

/**
 * Auto-save data periodically (every 30 seconds)
 * Returns a cleanup function to stop the interval
 */
export function startAutoSaveTauri(
	getDataFunction: () => WabiData,
	intervalMs: number = 30000
): () => void {
	if (!isRunningInTauri()) {
		console.log('[Tauri Storage] Not running in Tauri, skipping auto-save');
		return () => {};
	}

	const interval = setInterval(async () => {
		try {
			const data = getDataFunction();
			await saveTauriData(data);
			console.log('[Tauri Storage] Auto-save completed at', new Date().toLocaleTimeString());
		} catch (error) {
			console.error('[Tauri Storage] Auto-save failed:', error);
		}
	}, intervalMs);

	// Return cleanup function
	return () => {
		clearInterval(interval);
		console.log('[Tauri Storage] Auto-save stopped');
	};
}
