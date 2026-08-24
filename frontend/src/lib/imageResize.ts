/**
 * Client-side image downscaling for uploads.
 *
 * The server stores uploads verbatim (no server-side thumbnails), so a
 * 4000px phone photo uploaded as an avatar used to be downloaded at full
 * size by every client that renders it — visible as progressive
 * "scan-line" decode on profile pictures and slow boots.
 *
 * Downscales raster images in the browser before they hit /api/upload-*.
 * GIFs are passed through untouched (canvas would strip animation).
 */

export interface DownscaleOptions {
	/** Longest-edge cap in pixels. Default 1920 (backgrounds). */
	maxEdge?: number;
	/** Output MIME. Default 'image/webp' — best size/quality tradeoff. */
	outputMime?: string;
	/** Encoder quality 0..1. Default 0.85. */
	quality?: number;
}

const DEFAULTS: Required<DownscaleOptions> = {
	maxEdge: 1920,
	outputMime: 'image/webp',
	quality: 0.85
};

/** File types we must never re-encode. */
function isPassThrough(file: File | Blob): boolean {
	const type = (file.type || '').toLowerCase();
	return (
		type === 'image/gif' ||
		type.startsWith('video/') ||
		type === 'image/svg+xml' ||
		type === '' // unknown — let the server validate
	);
}

function replaceExtension(name: string, mime: string): string {
	const ext = mime === 'image/webp' ? '.webp' : mime === 'image/png' ? '.png' : '.jpg';
	return name.replace(/\.[^./\\]+$/, '') + ext;
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
	if (typeof createImageBitmap === 'function') {
		return await createImageBitmap(file);
	}
	// Legacy fallback (older Safari)
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('Image decode failed'));
			img.src = url;
		});
		return img;
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}
}

function bitmapSize(bmp: ImageBitmap | HTMLImageElement): { w: number; h: number } {
	if ('naturalWidth' in bmp) return { w: bmp.naturalWidth || bmp.width, h: bmp.naturalHeight || bmp.height };
	return { w: bmp.width, h: bmp.height };
}

/**
 * Returns a downscaled/re-encoded File when beneficial, otherwise the
 * original input unchanged (pass-through types, decode failures, or cases
 * where re-encoding would make the payload bigger).
 */
export async function downscaleImageFile(file: File, options: DownscaleOptions = {}): Promise<File> {
	const opts = { ...DEFAULTS, ...options };
	if (isPassThrough(file)) return file;

	let bitmap: ImageBitmap | HTMLImageElement;
	try {
		bitmap = await loadBitmap(file);
	} catch {
		return file; // undecodable — ship it as-is, server will reject if truly bad
	}

	const { w, h } = bitmapSize(bitmap);
	if (w <= 0 || h <= 0) return file;

	const scale = Math.min(1, opts.maxEdge / Math.max(w, h));
	// Already comfortably under budget AND a compact modern encoding? Skip work.
	if (scale === 1 && file.size <= 256 * 1024 && file.type === opts.outputMime) return file;

	const targetW = Math.max(1, Math.round(w * scale));
	const targetH = Math.max(1, Math.round(h * scale));

	let blob: Blob | null = null;
	try {
		if (typeof OffscreenCanvas === 'function') {
			const canvas = new OffscreenCanvas(targetW, targetH);
			const ctx = canvas.getContext('2d');
			ctx?.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);
			blob = await canvas.convertToBlob({ type: opts.outputMime, quality: opts.quality });
		} else {
			const canvas = document.createElement('canvas');
			canvas.width = targetW;
			canvas.height = targetH;
			const ctx = canvas.getContext('2d');
			ctx?.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);
			blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, opts.outputMime, opts.quality)
			);
		}
	} catch {
		return file;
	}

	if (!blob || blob.size >= file.size) {
		// Re-encode didn't help — keep the original bytes.
		return file;
	}
	return new File([blob], replaceExtension(file.name || 'image', opts.outputMime), {
		type: opts.outputMime
	});
}
