/** Pure checks on Lore data a server returns (docs/audits/2026-11-hostile-server-audit.md). */
/**
 * The signed URL is clicked, opened and fetched by the client, so a server must not be able to
 * hand back `javascript:`, `data:` or `blob:` (docs/audits/2026-11-hostile-server-audit.md, L1).
 * Only absolute http(s) links, or paths on this server, are accepted.
 */
export function checkedSignedLoreUrl(value: unknown, base: string): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const resolved = new URL(value.trim(), new URL(base));
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
		if (resolved.username || resolved.password) return null;
		return resolved.href;
	} catch {
		return null;
	}
}

/**
 * A preview blob keeps the type the server sent. A "PDF" served as text/html or SVG would run as
 * a page with this app's origin inside the preview iframe (finding L2), so the blob shown in the
 * PDF frame always carries application/pdf: the browser then shows its PDF viewer or nothing.
 */
export function pdfPreviewBlob(blob: Blob): Blob {
	return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}
