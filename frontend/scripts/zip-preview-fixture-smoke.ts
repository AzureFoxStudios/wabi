import { parseZipPreviewMetadata } from '../src/lib/zip/zipPreview';

type ZipFixtureEntry = {
	name: string;
	compressedSize: number;
	uncompressedSize: number;
	compressionMethod?: number;
	encrypted?: boolean;
};

type ZipFixtureOptions = {
	diskNumber?: number;
	centralDirectoryDiskNumber?: number;
	entriesOnThisDisk?: number;
	totalEntries?: number;
	centralDirectorySizeOverride?: number;
	centralDirectoryOffsetOverride?: number;
	forceZip64Sentinels?: boolean;
};

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ENCRYPTED_BIT_FLAG = 0x0001;
const UTF8_BIT_FLAG = 0x0800;
const CENTRAL_DIRECTORY_FIXED_LENGTH = 46;

function expect(condition: unknown, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

function buildCentralDirectoryRecord(entry: ZipFixtureEntry): Uint8Array {
	const fileName = new TextEncoder().encode(entry.name);
	const output = new Uint8Array(CENTRAL_DIRECTORY_FIXED_LENGTH + fileName.length);
	const view = new DataView(output.buffer);
	const flags = UTF8_BIT_FLAG | (entry.encrypted ? ENCRYPTED_BIT_FLAG : 0);

	view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
	view.setUint16(4, 20, true); // version made by
	view.setUint16(6, 20, true); // version needed to extract
	view.setUint16(8, flags, true);
	view.setUint16(10, entry.compressionMethod ?? 8, true);
	view.setUint16(12, 0, true); // mod time
	view.setUint16(14, 0, true); // mod date
	view.setUint32(16, 0, true); // crc32
	view.setUint32(20, entry.compressedSize >>> 0, true);
	view.setUint32(24, entry.uncompressedSize >>> 0, true);
	view.setUint16(28, fileName.length, true);
	view.setUint16(30, 0, true); // extra field length
	view.setUint16(32, 0, true); // file comment length
	view.setUint16(34, 0, true); // disk number start
	view.setUint16(36, 0, true); // internal attrs
	view.setUint32(38, 0, true); // external attrs
	view.setUint32(42, 0, true); // local header offset

	output.set(fileName, CENTRAL_DIRECTORY_FIXED_LENGTH);
	return output;
}

function buildZipFixture(entries: ZipFixtureEntry[], options: ZipFixtureOptions = {}): Uint8Array {
	const centralDirectoryRecords = entries.map((entry) => buildCentralDirectoryRecord(entry));
	const centralDirectory = concatBytes(centralDirectoryRecords);

	const diskNumber = options.diskNumber ?? 0;
	const centralDirectoryDiskNumber = options.centralDirectoryDiskNumber ?? 0;
	const entriesOnThisDisk = options.entriesOnThisDisk ?? entries.length;
	const totalEntries = options.totalEntries ?? entries.length;
	const centralDirectorySize =
		options.centralDirectorySizeOverride ?? centralDirectory.length;
	const centralDirectoryOffset =
		options.centralDirectoryOffsetOverride ?? 0;

	const eocd = new Uint8Array(22);
	const view = new DataView(eocd.buffer);
	view.setUint32(0, EOCD_SIGNATURE, true);
	view.setUint16(4, diskNumber, true);
	view.setUint16(6, centralDirectoryDiskNumber, true);
	view.setUint16(8, entriesOnThisDisk, true);
	view.setUint16(10, totalEntries, true);
	view.setUint32(
		12,
		options.forceZip64Sentinels ? 0xffffffff : (centralDirectorySize >>> 0),
		true
	);
	view.setUint32(
		16,
		options.forceZip64Sentinels ? 0xffffffff : (centralDirectoryOffset >>> 0),
		true
	);
	view.setUint16(20, 0, true); // comment length

	return concatBytes([centralDirectory, eocd]);
}

function expectThrows(name: string, fn: () => void, expectedMessagePart: string): void {
	try {
		fn();
		throw new Error(`${name}: expected throw`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		expect(
			message.includes(expectedMessagePart),
			`${name}: expected message to include "${expectedMessagePart}", got "${message}"`
		);
	}
}

function run(): void {
	const validFixture = buildZipFixture([
		{
			name: 'photos/',
			compressedSize: 0,
			uncompressedSize: 0,
			compressionMethod: 0
		},
		{
			name: 'photos/cat.jpg',
			compressedSize: 1200,
			uncompressedSize: 3400
		},
		{
			name: 'secret.txt',
			compressedSize: 32,
			uncompressedSize: 64,
			encrypted: true
		}
	]);

	const metadata = parseZipPreviewMetadata(validFixture, { maxEntries: 200 });
	expect(metadata.entryCount === 3, 'valid fixture entryCount');
	expect(metadata.entries.length === 3, 'valid fixture rendered entries');
	expect(metadata.totalCompressedSize === 1232, 'valid fixture compressed sum');
	expect(metadata.totalUncompressedSize === 3464, 'valid fixture uncompressed sum');
	expect(metadata.encryptedEntryCount === 1, 'valid fixture encrypted count');
	expect(metadata.entries[0]?.isDirectory === true, 'directory detection');

	const truncated = parseZipPreviewMetadata(validFixture, { maxEntries: 2 });
	expect(truncated.entries.length === 2, 'maxEntries truncates output');
	expect(truncated.truncated === true, 'maxEntries sets truncated');

	expectThrows(
		'no eocd',
		() => parseZipPreviewMetadata(new Uint8Array([1, 2, 3, 4])),
		'Archive is too small'
	);

	expectThrows(
		'multi-disk',
		() => parseZipPreviewMetadata(buildZipFixture([{ name: 'a.txt', compressedSize: 1, uncompressedSize: 1 }], { diskNumber: 1 })),
		'Multi-disk ZIP archives are not supported'
	);

	expectThrows(
		'split archive',
		() =>
			parseZipPreviewMetadata(
				buildZipFixture([{ name: 'a.txt', compressedSize: 1, uncompressedSize: 1 }], {
					entriesOnThisDisk: 1,
					totalEntries: 2
				})
			),
		'Split ZIP archives are not supported'
	);

	expectThrows(
		'zip64 sentinel',
		() =>
			parseZipPreviewMetadata(
				buildZipFixture([{ name: 'a.txt', compressedSize: 1, uncompressedSize: 1 }], {
					forceZip64Sentinels: true
				})
			),
		'ZIP64 archives are not supported'
	);

	expectThrows(
		'central directory out of range',
		() =>
			parseZipPreviewMetadata(
				buildZipFixture([{ name: 'a.txt', compressedSize: 1, uncompressedSize: 1 }], {
					centralDirectoryOffsetOverride: 999_999
				})
			),
		'ZIP metadata points outside the downloaded data'
	);

	expectThrows(
		'central directory inconsistent',
		() =>
			parseZipPreviewMetadata(
				buildZipFixture(
					[
						{ name: 'a.txt', compressedSize: 1, uncompressedSize: 2 },
						{ name: 'b.txt', compressedSize: 3, uncompressedSize: 4 }
					],
					{ centralDirectorySizeOverride: (CENTRAL_DIRECTORY_FIXED_LENGTH * 2) + 14 + 4 }
				)
			),
		'ZIP directory metadata is inconsistent'
	);

	const malformedSignatureFixture = buildZipFixture([
		{ name: 'a.txt', compressedSize: 1, uncompressedSize: 1 }
	]);
	const tampered = malformedSignatureFixture.slice();
	tampered[0] = 0;
	tampered[1] = 0;
	tampered[2] = 0;
	tampered[3] = 0;
	expectThrows(
		'malformed central signature',
		() => parseZipPreviewMetadata(tampered),
		'ZIP central directory is malformed'
	);

	console.log('[zip-preview-fixture-smoke] all checks passed');
}

run();
