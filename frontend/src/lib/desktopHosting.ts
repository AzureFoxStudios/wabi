import { setConfiguredServerUrl } from './serverUrl';
import { setAuthToken, setPersistentAuthToken, setStoredDbUserId, setStoredUsername } from './authSession';
import { setRefreshToken } from './api/authRefresh';
import { recordSuccessfulServerConnection, renameLocalSavedServer } from './savedServerActions';
import { isDesktopTauri } from './tauri-platform';
import type { HostAccount } from './desktopHostFlow';
export type { HostStatus, HostAccount } from './desktopHostFlow';

export async function canUseDesktopHosting(): Promise<boolean> {
	if (!isDesktopTauri()) return false;
	try { return ['linux', 'windows', 'macos'].includes(await hostCommand<string>('get_platform')); }
	catch { return false; }
}

export async function hostCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<T>(name, args);
}

export function useCommunityAccount(server: string, account: HostAccount, communityName?: string): void {
	setConfiguredServerUrl(server, true);
	setAuthToken(account.accessToken, server);
	setPersistentAuthToken(account.accessToken, server);
	setRefreshToken(account.refreshToken, server);
	setStoredDbUserId(account.user.id, server);
	setStoredUsername(account.user.username, server);
	recordSuccessfulServerConnection({ url: server, username: account.user.username, dbUserId: account.user.id });
	if (communityName) renameLocalSavedServer(server, communityName);
}

export function openCommunity(server: string): void {
	setConfiguredServerUrl(server, true);
	// The root route reconnects through the existing scoped auth/socket bootstrap.
	window.location.assign('/');
}
