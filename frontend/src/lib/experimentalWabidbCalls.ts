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
 * `ExperimentalWabidbCall*` exports are kept as deprecated aliases for
 * calling_impl_core.ts.
 *
 * The old DM/group header toggle ("wabiDB Relay ON/OFF") and its
 * localStorage key are gone (design contract §8.10, §9.4): the toggle gated
 * nothing, so it showed members a false state. The transport choice lives in
 * Settings › Audio & video (`getStoredCallTransportMode`).
 */

import { getStoredCallTransportMode } from './mediaRuntime';

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

/** @deprecated Use {@link recordWabidbRelayCallAttempt}. */
export async function markExperimentalWabidbCallAttempt(params: {
	targetUserId: string;
	isVideoCall: boolean;
	scope: ExperimentalWabidbCallScope;
}): Promise<void> {
	return recordWabidbRelayCallAttempt(params);
}
