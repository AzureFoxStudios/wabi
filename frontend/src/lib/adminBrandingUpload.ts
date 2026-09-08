export const ADMIN_BRANDING_UPLOAD_TIMEOUT_MS = 60_000;

/** Artwork is only an uploaded draft, never a publication acknowledgement.
 * Bound the response body too, and retire the request with its mounted editor. */
export async function uploadAdminBrandingAsset(options: {
	server: string;
	token: string;
	file: File;
	signal: AbortSignal;
	request?: (url: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
}): Promise<string> {
	if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(options.file.type)) throw new Error('Use PNG, JPG, GIF, or WebP.');
	if (options.file.size > 10 * 1024 * 1024) throw new Error('Image must be 10 MB or smaller.');
	options.signal.throwIfAborted();
	const controller = new AbortController();
	const cancel = () => controller.abort(options.signal.reason);
	options.signal.addEventListener('abort', cancel, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error('The artwork upload could not be confirmed in time. Your published identity has not changed. Try uploading again.')), options.timeoutMs ?? ADMIN_BRANDING_UPLOAD_TIMEOUT_MS);
	let removeAbort = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		const abort = () => reject(controller.signal.reason);
		controller.signal.addEventListener('abort', abort, { once: true });
		removeAbort = () => controller.signal.removeEventListener('abort', abort);
	});
	try {
		const uploaded = (async () => {
			const body = new FormData();
			body.append('file', options.file);
			const response = await (options.request ?? fetch)(`${options.server.replace(/\/+$/, '')}/api/upload`, {
				method: 'POST', headers: { Authorization: `Bearer ${options.token}` }, body, signal: controller.signal
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok || typeof payload?.fileUrl !== 'string' || !payload.fileUrl.trim()) {
				throw new Error(typeof payload?.error === 'string' ? payload.error : 'The server did not confirm the artwork upload. Try again.');
			}
			return payload.fileUrl as string;
		})();
		return await Promise.race([uploaded, cancelled]);
	} finally {
		clearTimeout(timeout);
		options.signal.removeEventListener('abort', cancel);
		removeAbort();
	}
}
