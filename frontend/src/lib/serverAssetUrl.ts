/** Resolve an Authority-owned asset without inheriting the browser's host. */
export function resolveServerAssetUrl(serverUrl: string, assetUrl: string | null | undefined): string | null {
	if (!assetUrl) return null;
	const trimmed = assetUrl.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed, serverUrl).toString();
	} catch {
		return trimmed;
	}
}
