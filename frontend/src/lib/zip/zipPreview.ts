export interface ZipPreviewEntry {
	path: string;
	compressedSize: number;
	uncompressedSize: number;
	compressionMethod: number;
	isDirectory: boolean;
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
const EOCD_MIN_LENGTH = 22;
const ZIP_COMMENT_MAX = 0xffff;
const CENTRAL_DIRECTORY_FIXED_LENGTH = 46;
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

export function parseZipPreviewMetadata(
	bytes: Uint8Array,
	options?: {
		maxEntries?: number;
	}
): ZipPreviewMetadata {
	const requestedMaxEntries = options?.maxEntries ?? 200;
	const maxEntries = Number.isFinite(requestedMaxEntries)
		? Math.max(1, Math.floor(requestedMaxEntries))
		: 200;
	if (bytes.byteLength < EOCD_MIN_LENGTH) {
		throw new Error('Archive is too small to be a valid ZIP file.');
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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

	const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
	if (centralDirectoryEnd > bytes.byteLength) {
		throw new Error('ZIP metadata points outside the downloaded data.');
	}

	const entries: ZipPreviewEntry[] = [];
	let totalCompressedSize = 0;
	let totalUncompressedSize = 0;
	let encryptedEntryCount = 0;
	let cursor = centralDirectoryOffset;
	let parsedEntries = 0;

	while (parsedEntries < totalEntries) {
		if (cursor + CENTRAL_DIRECTORY_FIXED_LENGTH > centralDirectoryEnd) {
			throw new Error('ZIP entry metadata is truncated.');
		}
		if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
			throw new Error('ZIP central directory is malformed.');
		}

		const generalPurposeFlags = view.getUint16(cursor + 8, true);
		const compressionMethod = view.getUint16(cursor + 10, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const uncompressedSize = view.getUint32(cursor + 24, true);
		const fileNameLength = view.getUint16(cursor + 28, true);
		const extraFieldLength = view.getUint16(cursor + 30, true);
		const fileCommentLength = view.getUint16(cursor + 32, true);
		const recordLength =
			CENTRAL_DIRECTORY_FIXED_LENGTH + fileNameLength + extraFieldLength + fileCommentLength;
		const recordEnd = cursor + recordLength;

		if (recordEnd > centralDirectoryEnd) {
			throw new Error('ZIP entry payload is truncated.');
		}

		const fileNameStart = cursor + CENTRAL_DIRECTORY_FIXED_LENGTH;
		const fileNameEnd = fileNameStart + fileNameLength;
		const utf8 = (generalPurposeFlags & UTF8_BIT_FLAG) !== 0;
		const isEncrypted = (generalPurposeFlags & ENCRYPTED_BIT_FLAG) !== 0;
		const path = decodeEntryName(bytes.slice(fileNameStart, fileNameEnd), utf8);

		totalCompressedSize += compressedSize;
		totalUncompressedSize += uncompressedSize;
		if (isEncrypted) {
			encryptedEntryCount += 1;
		}
		if (entries.length < maxEntries) {
			entries.push({
				path,
				compressedSize,
				uncompressedSize,
				compressionMethod,
				isDirectory: path.endsWith('/')
			});
		}

		parsedEntries += 1;
		cursor = recordEnd;
	}

	if (cursor !== centralDirectoryEnd) {
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
