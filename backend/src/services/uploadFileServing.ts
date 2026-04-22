import { createReadStream, existsSync, readFileSync, statSync } from "fs";

interface UploadRequestLike {
	method?: string;
	headers: Record<string, string | string[] | undefined>;
}

type UploadResponseLike = NodeJS.WritableStream & {
	writeHead(statusCode: number, headers?: Record<string, string | number>): void;
	end(chunk?: unknown): void;
};

interface CompressionDownloadSample {
	timestamp: number;
	fileExt: string;
	mimeType: string;
	storedBytes: number;
	responseBytes: number;
	durationMs: number;
	decryptedAtRest: boolean;
	rangeRequest: boolean;
	streamed: boolean;
	statusCode: number;
}

interface CreateUploadFileServingOptions {
	resolveUploadPath: (fileId: string) => string | null;
	isAtRestEncryptedBuffer: (buffer: Buffer) => boolean;
	maybeDecryptFromAtRest: (buffer: Buffer) => Buffer;
	maybeDecompressUploadPayload: (buffer: Buffer) => { payload: Buffer; compressed: boolean };
	getFileExtension: (fileId: string) => string;
	recordCompressionDownloadSample: (sample: CompressionDownloadSample) => void;
}

interface ServeUploadOptions {
	cacheControl: string;
	allowRange?: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	bmp: 'image/bmp',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	mp4: 'video/mp4',
	webm: 'video/webm',
	pdf: 'application/pdf',
	zip: 'application/zip'
};

export function createUploadFileServing({
	resolveUploadPath,
	isAtRestEncryptedBuffer,
	maybeDecryptFromAtRest,
	maybeDecompressUploadPayload,
	getFileExtension,
	recordCompressionDownloadSample
}: CreateUploadFileServingOptions) {
	const serveUploadByFileId = (
		req: UploadRequestLike,
		res: UploadResponseLike,
		fileId: string,
		options: ServeUploadOptions
	): void => {
		const downloadStartedAt = Date.now();
		const filePath = resolveUploadPath(fileId);
		if (!filePath) {
			res.writeHead(403);
			res.end("Access denied");
			return;
		}

		if (!existsSync(filePath)) {
			res.writeHead(404);
			res.end("Upload not found");
			return;
		}

		const stat = statSync(filePath);
		const ext = filePath.split('.').pop()?.toLowerCase();
		const contentType = CONTENT_TYPES[ext || ''] || 'application/octet-stream';
		let encryptedAtRest = false;
		let responseBuffer: Buffer | null = null;
		let compressedAtRest = false;
		let responseSize = stat.size;

		try {
			const storedBuffer = readFileSync(filePath);
			let plainBuffer = storedBuffer;
			if (isAtRestEncryptedBuffer(storedBuffer)) {
				encryptedAtRest = true;
				plainBuffer = maybeDecryptFromAtRest(storedBuffer);
			}

			const maybeDecompressed = maybeDecompressUploadPayload(plainBuffer);
			compressedAtRest = maybeDecompressed.compressed;
			responseBuffer = maybeDecompressed.payload;
			responseSize = responseBuffer.length;
		} catch (error) {
			console.error('Upload read/decrypt error:', error);
			res.writeHead(500);
			res.end("Failed to read upload");
			return;
		}

		const etag = `"${responseSize}-${Math.floor(stat.mtimeMs)}"`;
		const headers: Record<string, string | number> = {
			'Content-Type': contentType,
			'Cache-Control': options.cacheControl,
			ETag: etag,
			'Last-Modified': stat.mtime.toUTCString(),
			'Accept-Ranges': (encryptedAtRest || compressedAtRest || options.allowRange === false) ? 'none' : 'bytes',
			'X-Content-Type-Options': 'nosniff'
		};

		const originHeader = req.headers.origin;
		if (typeof originHeader === 'string' && originHeader.length > 0) {
			headers['Access-Control-Allow-Origin'] = originHeader;
			headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
		}

		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			res.end();
			return;
		}

		const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null;
		if (rangeHeader && options.allowRange !== false && !encryptedAtRest && !compressedAtRest) {
			const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
			if (match) {
				const start = parseInt(match[1], 10);
				const end = match[2] ? parseInt(match[2], 10) : responseSize - 1;
				if (start >= responseSize || end >= responseSize || start > end) {
					res.writeHead(416, { 'Content-Range': `bytes */${responseSize}` });
					res.end();
					return;
				}
				headers['Content-Range'] = `bytes ${start}-${end}/${responseSize}`;
				headers['Content-Length'] = end - start + 1;
				res.writeHead(206, headers);
				recordCompressionDownloadSample({
					timestamp: Date.now(),
					fileExt: getFileExtension(fileId),
					mimeType: contentType,
					storedBytes: stat.size,
					responseBytes: end - start + 1,
					durationMs: Date.now() - downloadStartedAt,
					decryptedAtRest: false,
					rangeRequest: true,
					streamed: true,
					statusCode: 206
				});
				if (req.method === 'HEAD') {
					res.end();
				} else {
					createReadStream(filePath, { start, end }).pipe(res);
				}
				return;
			}
		}

		headers['Content-Length'] = responseSize;
		res.writeHead(200, headers);
		if (req.method === 'HEAD') {
			res.end();
			return;
		}

		if ((encryptedAtRest || compressedAtRest) && responseBuffer) {
			recordCompressionDownloadSample({
				timestamp: Date.now(),
				fileExt: getFileExtension(fileId),
				mimeType: contentType,
				storedBytes: stat.size,
				responseBytes: responseBuffer.length,
				durationMs: Date.now() - downloadStartedAt,
				decryptedAtRest: encryptedAtRest || compressedAtRest,
				rangeRequest: false,
				streamed: false,
				statusCode: 200
			});
			res.end(responseBuffer);
			return;
		}

		recordCompressionDownloadSample({
			timestamp: Date.now(),
			fileExt: getFileExtension(fileId),
			mimeType: contentType,
			storedBytes: stat.size,
			responseBytes: responseSize,
			durationMs: Date.now() - downloadStartedAt,
			decryptedAtRest: false,
			rangeRequest: false,
			streamed: true,
			statusCode: 200
		});
		createReadStream(filePath).pipe(res);
	};

	return {
		serveUploadByFileId
	};
}
