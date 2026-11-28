import { describe, expect, test } from 'bun:test';
import { openHttpZipSource, ZipTooLargeError } from './zipHttpSource';
import { memoryZipSource, readZipEntryBytes, readZipPreviewMetadata, type ZipByteSource } from './zipPreview';

/** A stored (uncompressed) archive, enough to exercise the reader. */
function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = enc.encode(file.name);
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint32(18, file.data.length, true);
		lv.setUint32(22, file.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const record = new Uint8Array(46 + name.length);
		const cv = new DataView(record.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint32(20, file.data.length, true);
		cv.setUint32(24, file.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		record.set(name, 46);
		parts.push(local, file.data);
		central.push(record);
		offset += local.length + file.data.length;
	}
	const directorySize = central.reduce((sum, record) => sum + record.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, directorySize, true);
	ev.setUint32(16, offset, true);
	const all = [...parts, ...central, end];
	const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of all) { out.set(part, at); at += part.length; }
	return out;
}

const text = (value: string) => new TextEncoder().encode(value);
const BIG = 40 * 1024 * 1024;
const archive = makeZip([
	{ name: 'footage/roof.bin', data: new Uint8Array(BIG) },
	{ name: 'notes/readme.txt', data: text('measure twice') }
]);

function counted(source: ZipByteSource): ZipByteSource & { bytesRead: number } {
	const wrapped = {
		size: source.size,
		bytesRead: 0,
		async read(start: number, end: number) { wrapped.bytesRead += end - start; return source.read(start, end); }
	};
	return wrapped;
}

/** A server over `archive`; `ranges` says whether it honours Range. */
function server(ranges: boolean) {
	const calls: string[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
		const range = new Headers(init.headers).get('range');
		calls.push(`${init.method ?? 'GET'} ${range ?? 'whole'}`);
		if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(archive.length) } });
		if (ranges && range) {
			const [start, end] = range.replace('bytes=', '').split('-').map(Number);
			return new Response(archive.slice(start, end + 1), { status: 206 });
		}
		return new Response(archive.slice(), { headers: { 'content-length': String(archive.length) } });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe('zip preview', () => {
	test('lists a 40 MB archive by reading only its last few kilobytes', async () => {
		const source = counted(memoryZipSource(archive));
		const listing = await readZipPreviewMetadata(source);
		expect(listing.entries.map((entry) => entry.path)).toEqual(['footage/roof.bin', 'notes/readme.txt']);
		expect(listing.totalUncompressedSize).toBe(BIG + 13);
		expect(source.bytesRead).toBeLessThan(70 * 1024);
	});

	test('opens one small file inside it without reading the big one', async () => {
		const source = counted(memoryZipSource(archive));
		const listing = await readZipPreviewMetadata(source);
		const before = source.bytesRead;
		const bytes = await readZipEntryBytes(source, listing.entries[1], { maxOutputBytes: 64 * 1024 });
		expect(new TextDecoder().decode(bytes)).toBe('measure twice');
		expect(source.bytesRead - before).toBeLessThan(8 * 1024);
	});

	test('asks the server for parts, not the whole archive', async () => {
		const { calls, fetchImpl } = server(true);
		const source = await openHttpZipSource('https://example.test/a.zip', { knownSize: archive.length, maxWholeBytes: 25 * 1024 * 1024, timeoutMs: 5000, fetchImpl });
		const listing = await readZipPreviewMetadata(source);
		expect(listing.entryCount).toBe(2);
		expect(calls).toEqual([`GET bytes=${archive.length - 65557}-${archive.length - 1}`]);
	});

	test('finds the size itself when the message does not carry it', async () => {
		const { calls, fetchImpl } = server(true);
		const source = await openHttpZipSource('https://example.test/a.zip', { maxWholeBytes: 25 * 1024 * 1024, timeoutMs: 5000, fetchImpl });
		expect(source.size).toBe(archive.length);
		expect(calls).toEqual(['HEAD whole']);
	});

	test('a server that only sends whole files still works up to the limit, and says so past it', async () => {
		const { fetchImpl } = server(false);
		const roomy = await openHttpZipSource('https://example.test/a.zip', { knownSize: archive.length, maxWholeBytes: 64 * 1024 * 1024, timeoutMs: 5000, fetchImpl });
		expect((await readZipPreviewMetadata(roomy)).entryCount).toBe(2);
		const tight = await openHttpZipSource('https://example.test/a.zip', { knownSize: archive.length, maxWholeBytes: 25 * 1024 * 1024, timeoutMs: 5000, fetchImpl });
		await expect(readZipPreviewMetadata(tight)).rejects.toBeInstanceOf(ZipTooLargeError);
	});
});
