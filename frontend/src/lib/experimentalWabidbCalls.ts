import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { isDesktopTauri } from './tauri-platform';
import { getStoredCallTransportMode } from './mediaRuntime';

export type ExperimentalWabidbCallScope = 'dm' | 'group' | 'channel' | 'unknown';

const EXPERIMENTAL_WABIDB_CALL_KEY = 'wabi_experimental_wabidb_calls_enabled';

export function isExperimentalWabidbCallEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem(EXPERIMENTAL_WABIDB_CALL_KEY) === 'true';
}

export async function setExperimentalWabidbCallEnabled(enabled: boolean): Promise<void> {
	if (!browser) return;
	localStorage.setItem(EXPERIMENTAL_WABIDB_CALL_KEY, String(enabled));

	if (!isDesktopTauri()) return;
	try {
		await invoke<string>('set_experimental_wabidb_call_enabled', { enabled });
	} catch (error) {
		console.warn('[Experimental Wabidb Calls] Failed to persist desktop toggle:', error);
	}
}

export function shouldUseExperimentalWabidbCall(scope: ExperimentalWabidbCallScope): boolean {
	if (scope !== 'dm' && scope !== 'group') return false;
	if (getStoredCallTransportMode() as string === "wabidb") return true;
	if (!isDesktopTauri()) return false;
	return isExperimentalWabidbCallEnabled();
}

export async function markExperimentalWabidbCallAttempt(params: {
	targetUserId: string;
	isVideoCall: boolean;
	scope: ExperimentalWabidbCallScope;
}): Promise<void> {
	if (!isDesktopTauri()) return;
	if (!(params.scope === 'dm' || params.scope === 'group')) return;

	try {
		await invoke<string>('wabidb_record_experimental_call', {
			record: {
				timestampMs: Date.now(),
				targetUserId: params.targetUserId,
				isVideoCall: params.isVideoCall,
				scope: params.scope,
				label: 'experimental-wabidb-call'
			}
		});
	} catch (error) {
		console.warn('[Experimental Wabidb Calls] Failed to record desktop attempt:', error);
	}
}
