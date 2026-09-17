import { setConfiguredServerUrl } from './serverUrl';
import { setAuthToken, setStoredDbUserId, setStoredUsername } from './authSession';
import { setRefreshToken } from './api/authRefresh';

export interface HostStatus {
    running: boolean; ready: boolean; setupRequired: boolean | null; localUrl: string | null;
    sharing: 'local' | 'lan'; error: string | null; dataDirectory: string;
    backupIds: string[]; binaryAvailable: boolean;
    buildRevision: string; testBuild: boolean;
}
export interface HostAccount {
    accessToken: string; refreshToken: string; user: { id: number; username: string };
}
export function hasNativeBridge(): boolean {
    return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}
export async function canUseDesktopHosting(): Promise<boolean> {
    if (!hasNativeBridge()) return false;
    const { invoke } = await import('@tauri-apps/api/core');
    try { return ['linux', 'windows', 'macos'].includes(await invoke<string>('get_platform')); }
    catch { return false; }
}
export async function hostCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(name, args);
}
export function useAccount(server: string, account: HostAccount): void {
    setConfiguredServerUrl(server, true);
    setAuthToken(account.accessToken, server);
    setRefreshToken(account.refreshToken, server);
    setStoredDbUserId(account.user.id, server);
    setStoredUsername(account.user.username, server);
}
