import type { ZipByteSource } from './zipPreview';

/** Thrown when the server only sends whole files and this one is too big to take whole. */
export class ZipTooLargeError extends Error {
	constructor(readonly limit: number) {
		super('Archive is too large to download whole.');
		this.name = 'ZipTooLargeError';
	}
}

export interface HttpZipSourceOptions {
	/** Size from the attachment, when the message carries it. */
	knownSize?: number;
	/** Largest archive to download whole when the server will not send parts. */
	maxWholeBytes: number;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
	/** Aborts every request this source makes. */
	signal?: AbortSignal;
}

/**
 * An archive on a server, read in parts with HTTP range requests. A server
 * that ignores ranges sends the whole file; that is accepted up to
 * `maxWholeBytes` and kept so later reads cost nothing.
 */
export async function openHttpZipSource(url: string, options: HttpZipSourceOptions): Promise<ZipByteSource> {
	const fetchImpl = options.fetchImpl ?? fetch;
	let whole: Uint8Array | null = null;

	async function request(init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		options.signal?.addEventListener('abort', onAbort);
		if (options.signal?.aborted) controller.abort();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs);
		try {
			const response = await fetchImpl(url, { ...init, signal: controller.signal });
			// Reading the body is part of the request as far as the timeout goes.
			const body = init.method === 'HEAD' ? null : await guardedBody(response);
			return new Response(body, { status: response.status, headers: response.headers });
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
		}
	}

	async function guardedBody(response: Response): Promise<ArrayBuffer | null> {
		if (response.status === 206) return response.arrayBuffer();
		if (response.status !== 200) return null;
		const declared = Number(response.headers.get('content-length') ?? NaN);
		if (Number.isFinite(declared) && declared > options.maxWholeBytes) {
			await response.body?.cancel().catch(() => {});
			throw new ZipTooLargeError(options.maxWholeBytes);
		}
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > options.maxWholeBytes) throw new ZipTooLargeError(options.maxWholeBytes);
		return buffer;
	}

	let size = typeof options.knownSize === 'number' && options.knownSize > 0 ? options.knownSize : NaN;
	if (!Number.isFinite(size)) {
		const head = await request({ method: 'HEAD' });
		if (!head.ok) throw new Error(`Failed to fetch archive (${head.status}).`);
		size = Number(head.headers.get('content-length') ?? NaN);
		if (!Number.isFinite(size) || size <= 0) throw new Error('The server did not say how big the archive is.');
	}

	return {
		size,
		async read(start, end) {
			if (whole) return whole.subarray(start, end);
			if (end <= start) return new Uint8Array(0);
			const response = await request({ headers: { Range: `bytes=${start}-${end - 1}` } });
			if (response.status === 206) return new Uint8Array(await response.arrayBuffer());
			if (response.status === 200) {
				whole = new Uint8Array(await response.arrayBuffer());
				return whole.subarray(start, end);
			}
			throw new Error(`Failed to fetch archive (${response.status}).`);
		}
	};
}
