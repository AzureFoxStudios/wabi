/**
 * WabidbRelayCalls — wabidb relay call routing, compatibility layer.
 *
 * wabidb relay is now the DEFAULT call transport (see
 * `mediaRuntime.ts:resolveCallTransportPlan()`), so the old "experimental
 * wabidb calls" feature flag is obsolete. Nothing gates call routing on it
 * anymore — `calling_impl_core.ts` no longer calls
 * `shouldUseExperimentalWabidbCall`.
 *
 * This module is a thin compatibility layer: the modern `WabidbRelay*` names
 * below describe the current default-on behavior, and the legacy
 * `ExperimentalWabidbCall*` exports are kept as deprecated aliases so
 * existing importers (Chat.svelte, AudioSettingsTab.svelte, ChatHeader.svelte,
 * calling_impl_core.ts) keep compiling unchanged.
 */

import { browser } from '$app/environment';
import { getStoredCallTransportMode } from './mediaRuntime';

// Legacy localStorage key, kept so the old "wabiDB EXP" toggle still
// round-trips on upgrade. It no longer gates anything.
const LEGACY_WABIDB_RELAY_KEY = 'wabi_experimental_wabidb_calls_enabled';

/** Scopes that wabidb relay call routing applies to. */
export type WabidbRelayCallScope = 'dm' | 'group' | 'channel' | 'unknown';

/**
 * Whether wabidb relay routing is the effective choice for a scope.
 * wabidb relay is the default transport for DM/group calls (`auto` mode
 * resolves to wabidb); only an explicit `p2p-only` or `sfu-preferred` mode
 * opts out.
 */
export function isWabidbRelayDefault(scope: WabidbRelayCallScope): boolean {
	if (scope !== 'dm' && scope !== 'group') return false;
	const mode = getStoredCallTransportMode();
	return mode === 'auto' || mode === 'wabidb';
}

/**
 * Legacy toggle state, kept so the old settings switch keeps working. It no
 * longer gates anything — wabidb relay is the default transport.
 */
export function isWabidbRelayToggleEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem(LEGACY_WABIDB_RELAY_KEY) === 'true';
}

export async function setWabidbRelayToggleEnabled(enabled: boolean): Promise<void> {
	if (!browser) return;
	localStorage.setItem(LEGACY_WABIDB_RELAY_KEY, String(enabled));
}

/**
 * Record a wabidb-relay-routed call attempt. The Tauri backend command
 * (`wabidb_record_experimental_call`) was removed when wabidb relay became the
 * default transport, so there is nothing left to record; kept as a no-op for
 * call-site compatibility.
 */
export async function recordWabidbRelayCallAttempt(params: {
	targetUserId: string;
	isVideoCall: boolean;
	scope: WabidbRelayCallScope;
}): Promise<void> {
	void params;
}

// ---------------------------------------------------------------------------
// Legacy exports — kept so existing imports don't break.
// ---------------------------------------------------------------------------

/** @deprecated Use {@link WabidbRelayCallScope}. */
export type ExperimentalWabidbCallScope = WabidbRelayCallScope;

/** @deprecated Use {@link isWabidbRelayDefault}. */
export function shouldUseExperimentalWabidbCall(scope: ExperimentalWabidbCallScope): boolean {
	return isWabidbRelayDefault(scope);
}

/** @deprecated Use {@link isWabidbRelayToggleEnabled}. */
export function isExperimentalWabidbCallEnabled(): boolean {
	return isWabidbRelayToggleEnabled();
}

/** @deprecated Use {@link setWabidbRelayToggleEnabled}. */
export async function setExperimentalWabidbCallEnabled(enabled: boolean): Promise<void> {
	return setWabidbRelayToggleEnabled(enabled);
}

/** @deprecated Use {@link recordWabidbRelayCallAttempt}. */
export async function markExperimentalWabidbCallAttempt(params: {
	targetUserId: string;
	isVideoCall: boolean;
	scope: ExperimentalWabidbCallScope;
}): Promise<void> {
	return recordWabidbRelayCallAttempt(params);
}
