import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { isDesktopTauri } from './tauri-platform';

export type ExperimentalStdbCallScope = 'dm' | 'group' | 'channel' | 'unknown';

const EXPERIMENTAL_STDB_CALL_KEY = 'wabi_experimental_stdb_calls_enabled';

export function isExperimentalStdbCallEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem(EXPERIMENTAL_STDB_CALL_KEY) === 'true';
}

export async function setExperimentalStdbCallEnabled(enabled: boolean): Promise<void> {
	if (!browser) return;
	localStorage.setItem(EXPERIMENTAL_STDB_CALL_KEY, String(enabled));

	if (!isDesktopTauri()) return;
	try {
		await invoke<string>('set_experimental_stdb_call_enabled', { enabled });
	} catch (error) {
		console.warn('[Experimental STDB Calls] Failed to persist desktop toggle:', error);
	}
}

export function shouldUseExperimentalStdbCall(scope: ExperimentalStdbCallScope): boolean {
	if (!isDesktopTauri()) return false;
	if (!isExperimentalStdbCallEnabled()) return false;
	return scope === 'dm' || scope === 'group';
}

export async function markExperimentalStdbCallAttempt(params: {
	targetUserId: string;
	isVideoCall: boolean;
	scope: ExperimentalStdbCallScope;
}): Promise<void> {
	if (!isDesktopTauri()) return;
	if (!(params.scope === 'dm' || params.scope === 'group')) return;

	try {
		await invoke<string>('spacechatdb_record_experimental_call', {
			record: {
				timestampMs: Date.now(),
				targetUserId: params.targetUserId,
				isVideoCall: params.isVideoCall,
				scope: params.scope,
				label: 'experimental-spacechatdb-stdb-call'
			}
		});
	} catch (error) {
		console.warn('[Experimental STDB Calls] Failed to record desktop attempt:', error);
	}
}
