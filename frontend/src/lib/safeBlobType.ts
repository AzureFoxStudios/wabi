/**
 * Bytes whose type a server or another member chose (Lore files, decrypted attachments, files
 * workspace previews) become `blob:` URLs with this app's own origin. Opened as a document (new
 * tab, iframe, object) an `image/svg+xml`, `text/html` or XML blob runs its script as this app,
 * with every saved server's tokens and keys in reach (docs/audits/2026-11-hostile-server-audit.md,
 * L2 and review finding F4). So a blob may only carry a type that cannot run script when opened;
 * anything else is `application/octet-stream` and is offered as a download, never shown.
 */

/** Raster images the app shows. SVG is deliberately absent. */
export const DISPLAYABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

function baseType(type: string | null | undefined): string {
	return String(type ?? '').split(';')[0].trim().toLowerCase();
}

export function isDisplayableImageType(type: string | null | undefined): boolean {
	return DISPLAYABLE_IMAGE_TYPES.has(baseType(type));
}

/**
 * The type a blob built from untrusted bytes may carry: a displayable raster image, audio or
 * video, a PDF or plain text keep their type (none of them runs script when opened); every other
 * type becomes application/octet-stream.
 */
export function inertBlobType(type: string | null | undefined): string {
	const base = baseType(type);
	if (DISPLAYABLE_IMAGE_TYPES.has(base)) return base;
	if (/^(audio|video)\/[a-z0-9.+-]+$/.test(base)) return base;
	if (base === 'application/pdf' || base === 'text/plain') return base;
	return 'application/octet-stream';
}

/** The same bytes with an inert type (the blob is returned unchanged when it already has one). */
export function inertBlob(blob: Blob, declaredType?: string | null): Blob {
	const type = inertBlobType(declaredType ?? blob.type);
	return blob.type === type ? blob : new Blob([blob], { type });
}

/**
 * A file URL from server data that the UI may link to or show: http(s), a relative path, a blob:
 * URL (only this app can mint one), or a data: URL of a displayable raster image. Anything else,
 * including `data:text/html` and `data:image/svg+xml`, is refused (null).
 */
export function safeFileHref(url: string): string | null {
	const trimmed = url.trim();
	if (/^data:/i.test(trimmed)) {
		const type = trimmed.slice(5).split(/[;,]/)[0];
		return isDisplayableImageType(type) ? trimmed : null;
	}
	if (/^blob:/i.test(trimmed) || /^https?:/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
	return trimmed;
}
