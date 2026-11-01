/**
 * "Show connection details during calls" (design contract §8.5, §8.9, §9.5): one per-device
 * switch under Settings › Audio & video › Troubleshooting, off by default. When it is on, the
 * Calls page opens its Connection details section (route, latency, packet loss) while you are in
 * a call; the call's ⋯ menu still opens and closes that section on demand.
 *
 * Settings never pushes the live section open during a call: on the Calls page store that would
 * uncover the Calls page and dock a full-window call, so a settings control would change center
 * stage. Outside a call it mirrors the switch into the live store for the next call, and the live
 * store (callSurfaces.ts) starts from the stored preference, so the choice survives a reload.
 */

export const CONNECTION_DETAILS_KEY = 'wabi:call-connection-details';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Off unless this device chose it. */
export function readConnectionDetailsPreference(storage: StorageLike | null = defaultStorage()): boolean {
	try {
		return storage?.getItem(CONNECTION_DETAILS_KEY) === 'on';
	} catch {
		return false;
	}
}

export function writeConnectionDetailsPreference(on: boolean, storage: StorageLike | null = defaultStorage()): void {
	try {
		storage?.setItem(CONNECTION_DETAILS_KEY, on ? 'on' : 'off');
	} catch {
		// Private windows can refuse storage; the switch still applies to this session.
	}
}

/** Whether Settings may mirror the switch into the live store: only while no call or call stage is up. */
export function shouldMirrorConnectionDetails(inCall: boolean, callSessionCount = 0): boolean {
	return !inCall && callSessionCount === 0;
}
