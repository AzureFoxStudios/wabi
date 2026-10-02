import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/tauri-platform';
import { getServerUrl, normalizeServerUrl } from '$lib/serverUrl';
import { setRefreshToken } from '$lib/api/authRefresh';
import {
	clearPlaintextPersistentAuthTokenForMigration,
	getPlaintextPersistentAuthTokenForMigration,
	setAuthToken, getAuthToken, authSessionGeneration, markNativeAuthRemembered
} from '$lib/authSession';

import { nativeAuthQueue } from './nativeAuthQueue';

type SecureAuthBundle = {
	accessToken: string;
	refreshToken?: string | null;
};

function resolveScope(serverUrl?: string | null): string {
	return normalizeServerUrl(serverUrl || getServerUrl()) || serverUrl || getServerUrl();
}

export async function persistNativeAuthToken(
	token: string | null,
	serverUrl?: string | null,
	refreshToken: string | null = null
): Promise<boolean> {
	if (!isTauriRuntime()) return false;
	const serverScope = resolveScope(serverUrl);
	if (!serverScope) return false;

	if (token) {
		await invoke('secure_auth_set', {
			serverScope,
			accessToken: token,
			refreshToken
		});
	} else {
		await invoke('secure_auth_delete', { serverScope });
	}
	return true;
}

/**
 * Hydrate remembered installed-app credentials before SvelteKit page hydration.
 *
 * Older Tauri builds may have a server-scoped plaintext localStorage access
 * token. Migration is fail-safe: native persistence must succeed before that
 * legacy value is erased. New installed builds never write a plaintext
 * persistent credential in the first place.
 */
export async function hydrateNativePersistentAuthToken(serverUrl?: string | null): Promise<void> {
	if (!isTauriRuntime()) return;
	const serverScope = resolveScope(serverUrl);
	if (!serverScope) return;

	const generation = authSessionGeneration(serverScope);
	const accessBefore = getAuthToken(serverScope);
	await nativeAuthQueue.run(serverScope, async (latest) => {
		const current = () => latest() && authSessionGeneration(serverScope) === generation && getAuthToken(serverScope) === accessBefore;
		const legacyToken = getPlaintextPersistentAuthTokenForMigration(serverScope);
		let nativeBundle: SecureAuthBundle | null;
		try {
			if (!current()) return;
			nativeBundle = await invoke<SecureAuthBundle | null>('secure_auth_get', { serverScope });
		} catch (error) {
			console.warn('[auth] Native credential store unavailable during bootstrap:', error);
			return;
		}
		if (!current()) return;
		if (nativeBundle?.accessToken) {
			if (accessBefore && accessBefore !== legacyToken) return;
			setAuthToken(nativeBundle.accessToken, serverScope);
			setRefreshToken(nativeBundle.refreshToken || null, serverScope);
			markNativeAuthRemembered(serverScope);
			if (legacyToken) clearPlaintextPersistentAuthTokenForMigration(serverScope);
			return;
		}
		if (!legacyToken || (accessBefore && accessBefore !== legacyToken)) return;
		try {
			await invoke('secure_auth_set', { serverScope, accessToken: legacyToken, refreshToken: null });
			if (!current()) return;
			setAuthToken(legacyToken, serverScope);
			markNativeAuthRemembered(serverScope);
			clearPlaintextPersistentAuthTokenForMigration(serverScope);
		} catch (error) {
			console.warn('[auth] Could not migrate remembered token into OS credential store:', error);
		}
	});
}
