export interface ZipPreviewEntry {
	path: string;
	compressedSize: number;
	uncompressedSize: number;
	compressionMethod: number;
	isDirectory: boolean;
	encrypted: boolean;
	localHeaderOffset: number;
}

export interface ZipPreviewMetadata {
	entryCount: number;
	totalCompressedSize: number;
	totalUncompressedSize: number;
	entries: ZipPreviewEntry[];
	truncated: boolean;
	encryptedEntryCount: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const ZIP_COMMENT_MAX = 0xffff;
const CENTRAL_DIRECTORY_FIXED_LENGTH = 46;
const LOCAL_FILE_HEADER_FIXED_LENGTH = 30;
const ENCRYPTED_BIT_FLAG = 0x0001;
const UTF8_BIT_FLAG = 0x0800;

function sanitizeEntryName(value: string): string {
	const sanitized = value
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/\\+/g, '/')
		.trim();
	return sanitized || '(unnamed)';
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
	const decoder = new TextDecoder(utf8 ? 'utf-8' : 'latin1');
	const decoded = decoder.decode(bytes);
	return sanitizeEntryName(decoded);
}

function findEndOfCentralDirectory(view: DataView): number {
	const minOffset = Math.max(0, view.byteLength - (EOCD_MIN_LENGTH + ZIP_COMMENT_MAX));
	for (let offset = view.byteLength - EOCD_MIN_LENGTH; offset >= minOffset; offset -= 1) {
		if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
			return offset;
		}
	}
	return -1;
}


/** Somewhere an archive's bytes can be read from, a piece at a time. */
export interface ZipByteSource {
	/** Size of the whole archive in bytes. */
	size: number;
	/** Bytes from `start` up to, not including, `end`. */
	read(start: number, end: number): Promise<Uint8Array>;
}

export function memoryZipSource(bytes: Uint8Array): ZipByteSource {
	return { size: bytes.byteLength, read: async (start, end) => bytes.subarray(start, end) };
}

/** The file list of a very large archive is still small; refuse absurd ones. */
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
/** Local headers repeat the name and may carry a longer extra field. */
const LOCAL_HEADER_SLACK = 4096;

/**
 * Reads an archive's file list by fetching only its tail and its central
 * directory, so the archive's size does not matter.
 */
export async function readZipPreviewMetadata(
	source: ZipByteSource,
	options?: { maxEntries?: number }
): Promise<ZipPreviewMetadata> {
	const requestedMaxEntries = options?.maxEntries ?? 200;
	const maxEntries = Number.isFinite(requestedMaxEntries)
		? Math.max(1, Math.floor(requestedMaxEntries))
		: 200;
	if (source.size < EOCD_MIN_LENGTH) {
		throw new Error('Archive is too small to be a valid ZIP file.');
	}

	const tailStart = Math.max(0, source.size - (EOCD_MIN_LENGTH + ZIP_COMMENT_MAX));
	const tailBytes = await source.read(tailStart, source.size);
	if (tailBytes.byteLength !== source.size - tailStart) {
		throw new Error('Could not read the end of the archive.');
	}
	const view = new DataView(tailBytes.buffer, tailBytes.byteOffset, tailBytes.byteLength);
	const eocdOffset = findEndOfCentralDirectory(view);
	if (eocdOffset < 0) {
		throw new Error('Could not find ZIP directory metadata.');
	}

	const diskNumber = view.getUint16(eocdOffset + 4, true);
	const centralDirectoryDiskNumber = view.getUint16(eocdOffset + 6, true);
	const entriesOnThisDisk = view.getUint16(eocdOffset + 8, true);
	const totalEntries = view.getUint16(eocdOffset + 10, true);
	const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
	const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

	if (diskNumber !== 0 || centralDirectoryDiskNumber !== 0) {
		throw new Error('Multi-disk ZIP archives are not supported in preview mode.');
	}
	if (entriesOnThisDisk !== totalEntries) {
		throw new Error('Split ZIP archives are not supported in preview mode.');
	}
	if (
		totalEntries === 0xffff ||
		centralDirectorySize === 0xffffffff ||
		centralDirectoryOffset === 0xffffffff
	) {
		throw new Error('ZIP64 archives are not supported in preview mode yet.');
	}
	if (centralDirectoryOffset + centralDirectorySize > source.size) {
		throw new Error('ZIP metadata points outside the archive.');
	}
	if (centralDirectorySize > MAX_DIRECTORY_BYTES) {
		throw new Error('This archive lists too many files to preview.');
	}

	let directory: Uint8Array;
	if (centralDirectoryOffset >= tailStart) {
		const from = centralDirectoryOffset - tailStart;
		directory = tailBytes.subarray(from, from + centralDirectorySize);
	} else {
		directory = await source.read(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize);
	}
	if (directory.byteLength !== centralDirectorySize) {
		throw new Error('ZIP entry metadata is truncated.');
	}
	const dirView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

	const entries: ZipPreviewEntry[] = [];
	let totalCompressedSize = 0;
	let totalUncompressedSize = 0;
	let encryptedEntryCount = 0;
	let cursor = 0;

	for (let parsed = 0; parsed < totalEntries; parsed += 1) {
		if (cursor + CENTRAL_DIRECTORY_FIXED_LENGTH > centralDirectorySize) {
			throw new Error('ZIP entry metadata is truncated.');
		}
		if (dirView.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
			throw new Error('ZIP central directory is malformed.');
		}
		const generalPurposeFlags = dirView.getUint16(cursor + 8, true);
		const compressionMethod = dirView.getUint16(cursor + 10, true);
		const compressedSize = dirView.getUint32(cursor + 20, true);
		const uncompressedSize = dirView.getUint32(cursor + 24, true);
		const fileNameLength = dirView.getUint16(cursor + 28, true);
		const extraFieldLength = dirView.getUint16(cursor + 30, true);
		const fileCommentLength = dirView.getUint16(cursor + 32, true);
		const localHeaderOffset = dirView.getUint32(cursor + 42, true);
		const recordEnd =
			cursor + CENTRAL_DIRECTORY_FIXED_LENGTH + fileNameLength + extraFieldLength + fileCommentLength;
		if (recordEnd > centralDirectorySize) {
			throw new Error('ZIP entry payload is truncated.');
		}
		if (localHeaderOffset >= source.size) {
			throw new Error('ZIP local entry offset is outside archive bounds.');
		}
		const fileNameStart = cursor + CENTRAL_DIRECTORY_FIXED_LENGTH;
		const utf8 = (generalPurposeFlags & UTF8_BIT_FLAG) !== 0;
		const isEncrypted = (generalPurposeFlags & ENCRYPTED_BIT_FLAG) !== 0;
		const path = decodeEntryName(directory.slice(fileNameStart, fileNameStart + fileNameLength), utf8);

		totalCompressedSize += compressedSize;
		totalUncompressedSize += uncompressedSize;
		if (isEncrypted) encryptedEntryCount += 1;
		if (entries.length < maxEntries) {
			entries.push({
				path,
				compressedSize,
				uncompressedSize,
				compressionMethod,
				isDirectory: path.endsWith('/'),
				encrypted: isEncrypted,
				localHeaderOffset
			});
		}
		cursor = recordEnd;
	}

	if (cursor !== centralDirectorySize) {
		throw new Error('ZIP directory metadata is inconsistent.');
	}

	return {
		entryCount: totalEntries,
		totalCompressedSize,
		totalUncompressedSize,
		entries,
		truncated: totalEntries > entries.length,
		encryptedEntryCount
	};
}

/** Reads one file out of an archive, fetching only that file's bytes. */
export async function readZipEntryBytes(
	source: ZipByteSource,
	entry: ZipPreviewEntry,
	options?: { maxOutputBytes?: number }
): Promise<Uint8Array> {
	const maxOutputBytes = Math.max(1, Math.floor(options?.maxOutputBytes ?? 1024 * 1024));
	if (entry.uncompressedSize > maxOutputBytes || entry.compressedSize > maxOutputBytes * 4 + 1024) {
		throw new Error(`Entry exceeds preview limit (${maxOutputBytes} bytes).`);
	}
	const nameBytes = new TextEncoder().encode(entry.path).byteLength;
	const end = Math.min(
		source.size,
		entry.localHeaderOffset + LOCAL_FILE_HEADER_FIXED_LENGTH + nameBytes + LOCAL_HEADER_SLACK + entry.compressedSize
	);
	const piece = await source.read(entry.localHeaderOffset, end);
	return extractZipEntryBytes(piece, { ...entry, localHeaderOffset: 0 }, options);
}


async function inflateDeflateRaw(
	bytes: Uint8Array,
	maxOutputBytes: number
): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('Deflate preview is not supported in this runtime.');
	}
	const normalizedInput = new Uint8Array(bytes.byteLength);
	normalizedInput.set(bytes);
	const source = new Blob([normalizedInput.buffer]).stream();
	const inflateStream = source.pipeThrough(new DecompressionStream('deflate-raw'));
	const reader = inflateStream.getReader();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
			totalLength += chunk.byteLength;
			if (totalLength > maxOutputBytes) {
				await reader.cancel();
				throw new Error(`Entry exceeds preview limit (${maxOutputBytes} bytes).`);
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export async function extractZipEntryBytes(
	archiveBytes: Uint8Array,
	entry: ZipPreviewEntry,
	options?: {
		maxOutputBytes?: number;
	}
): Promise<Uint8Array> {
	const maxOutputBytes = Math.max(1, Math.floor(options?.maxOutputBytes ?? 1024 * 1024));
	if (entry.isDirectory) {
		throw new Error('Directory entries cannot be previewed.');
	}
	if (entry.encrypted) {
		throw new Error('Encrypted entries cannot be previewed.');
	}
	if (entry.uncompressedSize > maxOutputBytes) {
		throw new Error(`Entry exceeds preview limit (${maxOutputBytes} bytes).`);
	}

	const view = new DataView(
		archiveBytes.buffer,
		archiveBytes.byteOffset,
		archiveBytes.byteLength
	);
	const localHeaderOffset = entry.localHeaderOffset;
	if (localHeaderOffset + LOCAL_FILE_HEADER_FIXED_LENGTH > archiveBytes.byteLength) {
		throw new Error('ZIP local entry header is truncated.');
	}
	if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
		throw new Error('ZIP local entry header is malformed.');
	}

	const fileNameLength = view.getUint16(localHeaderOffset + 26, true);
	const extraFieldLength = view.getUint16(localHeaderOffset + 28, true);
	const dataOffset = localHeaderOffset + LOCAL_FILE_HEADER_FIXED_LENGTH + fileNameLength + extraFieldLength;
	const dataEnd = dataOffset + entry.compressedSize;
	if (dataEnd > archiveBytes.byteLength) {
		throw new Error('ZIP entry data is truncated.');
	}

	const compressedBytes = archiveBytes.slice(dataOffset, dataEnd);
	if (entry.compressionMethod === 0) {
		if (compressedBytes.byteLength > maxOutputBytes) {
			throw new Error(`Entry exceeds preview limit (${maxOutputBytes} bytes).`);
		}
		return compressedBytes;
	}
	if (entry.compressionMethod === 8) {
		const inflated = await inflateDeflateRaw(compressedBytes, maxOutputBytes);
		if (inflated.byteLength > maxOutputBytes) {
			throw new Error(`Entry exceeds preview limit (${maxOutputBytes} bytes).`);
		}
		return inflated;
	}

	throw new Error(`Compression method ${entry.compressionMethod} is not previewable.`);
}
