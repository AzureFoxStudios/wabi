import { getServerUrl } from './serverUrl';

/**
 * Resolve server-relative media URLs (e.g. `/uploads/<uuid>.png`) against the
 * active server origin.
 *
 * Why: in the Tauri desktop shell the page origin is `tauri://localhost`, so a
 * raw relative URL resolves against the embedded frontend bundle instead of the
 * Wabi server. Tauri's asset handler then falls back to index.html for every
 * media request, which both breaks avatars/banners/overlays and can pin the CPU
 * in a fallback-retry loop. Message attachments already prefix the server URL
 * at render time (MessageList/MessageFileContent `getFileUrl`); this helper
 * gives profile media the same treatment.
 *
 * Absolute (http/https), data:, blob:, and tauri: URLs pass through unchanged.
 */
export function mediaUrl(url: string | null | undefined): string {
	if (!url) return '';
	if (/^(https?:|data:|blob:|tauri:)/i.test(url)) return url;
	return `${getServerUrl()}${url.startsWith('/') ? '' : '/'}${url}`;
}
