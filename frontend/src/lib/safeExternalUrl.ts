/**
 * A link whose address a server chose (launch page call to action, and similar) may only be an
 * absolute http(s) URL. `javascript:`, `data:`, `blob:`, `file:` and custom schemes are refused,
 * so a click can neither run script in this app nor hand a URL to an OS protocol handler
 * (docs/audits/2026-11-hostile-server-audit.md, finding L3).
 */
export function safeExternalHttpUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!/^https?:\/\//i.test(trimmed)) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password || !url.hostname) return null;
		return url.href;
	} catch {
		return null;
	}
}
