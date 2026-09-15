import type { ClientInit } from '@sveltejs/kit';
import { hydrateNativePersistentAuthToken } from '$lib/nativeAuthPersistence';

/**
 * Installed Tauri clients must hydrate OS-backed remember-me credentials before
 * the root page performs its synchronous session check. SvelteKit awaits this
 * hook before hydration, so login bootstrap never races native credential I/O.
 */
export const init: ClientInit = async () => {
	await hydrateNativePersistentAuthToken();
};
