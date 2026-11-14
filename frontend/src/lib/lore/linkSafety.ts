/** Pure checks on Lore data a server returns (docs/audits/2026-11-hostile-server-audit.md). */
/**
 * The signed URL is downloaded, previewed and fetched by the client, so a server must not be able
 * to hand back `javascript:`, `data:` or `blob:` (finding L1), nor another host: a download link
 * to another origin makes the browser ignore `download` and navigate the app's own window there
 * (review finding F2). The honest server returns a path on itself
 * (core/crates/wabi-server/src/api/lore.rs), so only this server's origin is accepted.
 */
export function checkedSignedLoreUrl(value: unknown, base: string): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const server = new URL(base);
		const resolved = new URL(value.trim(), server);
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
		if (resolved.username || resolved.password) return null;
		if (resolved.origin !== server.origin) return null;
		return resolved.href;
	} catch {
		return null;
	}
}

/** Largest Lore file saved through the app (bytes). Bigger files: use the Lore client or CLI. */
export const LORE_SAVE_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * Save a Lore file without navigating: fetch the (same-origin, checked) signed URL, then save the
 * bytes from a blob typed application/octet-stream, so nothing the server sent is shown as a page.
 * The body is read in chunks and refused once it passes LORE_SAVE_LIMIT_BYTES, so a server cannot
 * make the app buffer without bound (review finding N7).
 */
export async function saveSignedLoreFile(url: string, fileName: string, limit = LORE_SAVE_LIMIT_BYTES): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Download failed (${response.status})`);
	const tooLarge = () => new Error(`This file is larger than ${Math.round(limit / (1024 * 1024))} MB, the most Wabi saves directly. Use the Lore client to fetch it.`);
	const declared = Number(response.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > limit) throw tooLarge();
	const parts: BlobPart[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				throw tooLarge();
			}
			parts.push(value);
		}
	} else {
		const whole = await response.arrayBuffer();
		if (whole.byteLength > limit) throw tooLarge();
		parts.push(whole);
	}
	const blob = new Blob(parts, { type: 'application/octet-stream' });
	const objectUrl = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement('a');
		anchor.href = objectUrl;
		anchor.download = fileName || 'file';
		anchor.rel = 'noopener';
		anchor.click();
	} finally {
		setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
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
