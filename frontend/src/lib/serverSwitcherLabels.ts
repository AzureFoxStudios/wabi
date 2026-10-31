/**
 * Labels for the saved-servers switcher and rail (design contract §8.1).
 *
 * A saved server is named by its own branding and located by its host, set in mono without the
 * scheme ("127.0.0.1:5196", "wabi.example.org/community"). Each saved server keeps its own
 * account; nothing here merges identities across servers.
 */

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
	return value.slice(0, end);
}

/** The host (and any path) of a server URL, without its scheme, credentials or trailing slash. */
export function serverHostLabel(url: string | null | undefined): string {
	const raw = (url ?? '').trim();
	if (!raw) return '';
	const schemeEnd = raw.indexOf('://');
	try {
		const parsed = new URL(schemeEnd > 0 ? raw : `https://${raw}`);
		return trimTrailingSlashes(`${parsed.host}${parsed.pathname}`);
	} catch {
		const bare = schemeEnd > 0 ? raw.slice(schemeEnd + 3) : raw;
		const at = bare.indexOf('@');
		return trimTrailingSlashes(at >= 0 ? bare.slice(at + 1) : bare);
	}
}

/** "N unread" for a server's followed channels; '' when there is nothing unread. */
export function serverUnreadLabel(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return '';
	return `${Math.floor(count)} unread`;
}

/** Badge numerals: 1–99, then "99+". */
export function serverUnreadBadge(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return '';
	return count > 99 ? '99+' : String(Math.floor(count));
}
