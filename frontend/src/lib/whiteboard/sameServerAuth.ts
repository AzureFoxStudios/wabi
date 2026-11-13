/**
 * Board data (raster layers, fonts, images) is written by members, so an asset URL can name any
 * host. The current server's bearer token or guest session may only go to that server's own
 * origin (docs/audits/2026-11-hostile-server-audit.md, finding W1).
 */
export function resolvesToServer(assetUrl: string, serverUrl: string): boolean {
	try {
		const server = new URL(serverUrl);
		return new URL(assetUrl, server).origin === server.origin;
	} catch {
		return false;
	}
}

/** Credentials for an asset fetch: none at all unless the asset is on this server. */
export function serverAssetHeaders(
	assetUrl: string,
	serverUrl: string,
	token: string | null | undefined,
	guestSessionId: string | null | undefined
): Record<string, string> {
	if (!resolvesToServer(assetUrl, serverUrl)) return {};
	if (token) return { Authorization: `Bearer ${token}` };
	if (guestSessionId) return { 'X-Session-Id': guestSessionId };
	return {};
}
