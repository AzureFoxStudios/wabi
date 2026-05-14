#!/usr/bin/env node
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';

const AT_REST_MAGIC = Buffer.from('WABIENC1');
const COMP_MAGIC = Buffer.from('WBZ1');
const COMP_CODEC_GZIP = 1;
const COMP_HEADER_SIZE = COMP_MAGIC.length + 1 + 4;

function maybeEncrypt(payload, key) {
	if (!key) return payload;
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([AT_REST_MAGIC, iv, tag, encrypted]);
}

function maybeDecrypt(buffer, key) {
	if (!buffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) return buffer;
	if (!key) throw new Error('Encrypted payload without key');
	const headerEnd = AT_REST_MAGIC.length + 12 + 16;
	const iv = buffer.slice(AT_REST_MAGIC.length, AT_REST_MAGIC.length + 12);
	const tag = buffer.slice(AT_REST_MAGIC.length + 12, headerEnd);
	const ciphertext = buffer.slice(headerEnd);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function maybeCompress(payload) {
	const compressed = gzipSync(payload, { level: 6 });
	if (compressed.length >= payload.length) {
		return { payload, compressed: false };
	}
	const header = Buffer.alloc(COMP_HEADER_SIZE);
	COMP_MAGIC.copy(header, 0);
	header.writeUInt8(COMP_CODEC_GZIP, COMP_MAGIC.length);
	header.writeUInt32BE(payload.length, COMP_MAGIC.length + 1);
	return { payload: Buffer.concat([header, compressed]), compressed: true };
}

function maybeDecompress(buffer) {
	if (buffer.length < COMP_HEADER_SIZE) return { payload: buffer, compressed: false };
	if (!buffer.slice(0, COMP_MAGIC.length).equals(COMP_MAGIC)) {
		return { payload: buffer, compressed: false };
	}
	const codec = buffer.readUInt8(COMP_MAGIC.length);
	const originalSize = buffer.readUInt32BE(COMP_MAGIC.length + 1);
	if (codec !== COMP_CODEC_GZIP) {
		return { payload: buffer, compressed: false };
	}
	const payload = gunzipSync(buffer.slice(COMP_HEADER_SIZE));
	if (payload.length !== originalSize) {
		throw new Error(`Decompressed size mismatch: expected ${originalSize}, got ${payload.length}`);
	}
	return { payload, compressed: true };
}

function assertBufferEq(label, left, right) {
	if (!left.equals(right)) {
		throw new Error(`${label} failed`);
	}
	console.log(`ok: ${label}`);
}

function run() {
	const key = createHash('sha256').update('wabi-test-key').digest();
	const compressible = Buffer.from('hello wabi compression '.repeat(2000), 'utf8');
	const noisy = randomBytes(64 * 1024);

	const c1 = maybeCompress(compressible);
	const e1 = maybeEncrypt(c1.payload, key);
	const d1 = maybeDecrypt(e1, key);
	const out1 = maybeDecompress(d1).payload;
	assertBufferEq('compressible roundtrip compress->encrypt->decrypt->decompress', compressible, out1);
	console.log(`info: compressible compressed=${c1.compressed} ratio=${(c1.payload.length / compressible.length).toFixed(3)}`);

	const c2 = maybeCompress(noisy);
	const e2 = maybeEncrypt(c2.payload, key);
	const d2 = maybeDecrypt(e2, key);
	const out2 = maybeDecompress(d2).payload;
	assertBufferEq('noisy roundtrip compress->encrypt->decrypt->decompress', noisy, out2);
	console.log(`info: noisy compressed=${c2.compressed} ratio=${(c2.payload.length / noisy.length).toFixed(3)}`);

	const e3 = maybeEncrypt(compressible, key);
	const out3 = maybeDecrypt(e3, key);
	assertBufferEq('encrypt->decrypt without compression', compressible, out3);
}

try {
	run();
} catch (error) {
	console.error('compression-storage-smoke failed:', error);
	process.exitCode = 1;
}
