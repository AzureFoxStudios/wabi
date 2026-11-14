import { isTauriRuntime } from '$lib/tauri-platform';
import { steamAppId } from './model';

/**
 * Hand a `steam://run/<id>` launch to the OS. The caller has already asked the user.
 *
 * In the desktop app the webview never navigates to a custom scheme: its navigation guard
 * refuses anything but Wabi's own pages (docs/audits/2026-11-hostile-server-audit.md, N2), so the
 * launch goes through the origin-checked `open_external_url` command, which allows exactly this
 * one Steam form. In a browser the page navigates to the URL as before; the browser asks too.
 */
export async function openSteamLaunch(key: string): Promise<boolean> {
	const id = steamAppId(key);
	if (!id) return false;
	const url = `steam://run/${id}`;
	if (isTauriRuntime()) {
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('open_external_url', { url });
		return true;
	}
	window.location.href = url;
	return true;
}
