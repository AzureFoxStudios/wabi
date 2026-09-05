import { describe, expect, test } from 'bun:test';
import {
	wabidbDmSessionKey,
	wabidbChannelSessionKey,
	resolveWabidbSessionKey,
	oggHasBosPage
} from './wabidbMediaRelay';
import {
	parseWabidbMediaEnvelope,
	buildAudioEnvelope,
	splitFrameIntoChunks,
	videoStreamKey,
	WabidbVideoReassembler
} from './wabidbVideoLane';

/** Synthetic Ogg page: "OggS" magic + version + header_type byte. */
function oggPage(headerType: number, bodyLen = 16): Uint8Array {
	const page = new Uint8Array(27 + bodyLen);
	page.set([0x4f, 0x67, 0x67, 0x53, 0x00, headerType], 0);
	return page;
}

describe('oggHasBosPage — BOS gating for the decoder', () => {
	test('page with BOS flag (header_type bit 1) is detected', () => {
		expect(oggHasBosPage(oggPage(0x02))).toBe(true);
		expect(oggHasBosPage(oggPage(0x03))).toBe(true); // BOS+EOS combined
	});

	test('non-BOS pages (continuation 0x00, EOS 0x04) are not', () => {
		expect(oggHasBosPage(oggPage(0x00))).toBe(false);
		expect(oggHasBosPage(oggPage(0x04))).toBe(false);
	});

	test('BOS page found after leading garbage (scan, not just offset 0)', () => {
		const buf = new Uint8Array(40);
		buf.set(oggPage(0x02).subarray(0, 27), 9);
		expect(oggHasBosPage(buf)).toBe(true);
	});

	test('garbage, empty, and too-short buffers are false without throwing', () => {
		expect(oggHasBosPage(new Uint8Array(0))).toBe(false);
		expect(oggHasBosPage(new Uint8Array([0x4f, 0x67, 0x67]))).toBe(false);
		expect(oggHasBosPage(new Uint8Array(64).fill(0xff))).toBe(false);
	});

	test('magic without the flag byte in range is false (no OOB read)', () => {
		const buf = new Uint8Array(5);
		buf.set([0x4f, 0x67, 0x67, 0x53, 0x00], 0);
		expect(oggHasBosPage(buf)).toBe(false);
	});
});

describe('wabidb media envelope — audio compatibility', () => {
	test('legacy audio emit (no kind) is parsed as audio with payload preserved', () => {
		const legacy = { sessionId: 's1', userId: 'u1', payload: 'Zm9vYmFy' };
		const env = parseWabidbMediaEnvelope(legacy);
		expect(env).not.toBeNull();
		expect(env!.kind).toBe('audio');
		expect(env!.payload).toBe('Zm9vYmFy');
		expect(env!.seq).toBe(0);
	});

	test('new audio envelope round-trips through JSON and keeps kind/seq', () => {
		const env = buildAudioEnvelope('s1', 'u1', 'Zm9v', 7);
		const round = parseWabidbMediaEnvelope(JSON.parse(JSON.stringify(env)));
		expect(round).not.toBeNull();
		expect(round!.kind).toBe('audio');
		expect(round!.seq).toBe(7);
		expect(round!.payload).toBe('Zm9v');
	});

	test('screen-share audio parses as audio with the screen source preserved', () => {
		// 2026-09-04: second opus stream from a sharer. Receivers key the
		// decoder path by a composite id off this source field — dropping it
		// would interleave the streams into one decoder.
		const env = parseWabidbMediaEnvelope({
			sessionId: 's1',
			userId: 'u1',
			kind: 'audio',
			source: 'screen',
			seq: 3,
			payload: 'Zm9v'
		});
		expect(env).not.toBeNull();
		expect(env!.kind).toBe('audio');
		expect(env!.source).toBe('screen');
		expect(env!.seq).toBe(3);
	});

	test('inbound handler ignores malformed / non-matching envelopes', () => {
		expect(parseWabidbMediaEnvelope(null)).toBeNull();
		expect(parseWabidbMediaEnvelope({ foo: 1 })).toBeNull();
		expect(parseWabidbMediaEnvelope('not-an-object')).toBeNull();
	});
});

describe('wabidb media envelope — video routing', () => {
	test('video kind is recognized and metadata carried', () => {
		const raw = {
			sessionId: 's1',
			userId: 'u2',
			kind: 'video',
			seq: 3,
			payload: 'YWFh',
			chunkIndex: 0,
			chunkCount: 2,
			keyFrame: true,
			codec: 'vp8',
			width: 1280,
			height: 720
		};
		const env = parseWabidbMediaEnvelope(raw);
		expect(env!.kind).toBe('video');
		expect(env!.seq).toBe(3);
		expect(env!.chunkCount).toBe(2);
		expect(env!.keyFrame).toBe(true);
		expect(env!.codec).toBe('vp8');
		expect(env!.width).toBe(1280);
		expect(env!.height).toBe(720);
	});
});

describe('wabidb video chunk reassembly', () => {
	test('single-chunk frame reassembles exactly', () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 255]);
		const chunks = splitFrameIntoChunks('s1', 'u1', 1, bytes, {
			codec: 'vp8',
			width: 640,
			height: 360,
			keyFrame: true
		});
		expect(chunks.length).toBe(1);
		const reasm = new WabidbVideoReassembler();
		const frame = reasm.push(chunks[0]);
		expect(frame).not.toBeNull();
		expect(Array.from(frame!.frame)).toEqual(Array.from(bytes));
		expect(frame!.codec).toBe('vp8');
		expect(frame!.keyFrame).toBe(true);
	});

	test('multi-chunk frame reassembles exactly regardless of arrival order', () => {
		// >16 KiB raw forces multiple chunks
		const bytes = new Uint8Array(50000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
		const chunks = splitFrameIntoChunks('s1', 'u1', 9, bytes, {
			codec: 'vp8',
			width: 1280,
			height: 720,
			keyFrame: false
		});
		expect(chunks.length).toBeGreaterThan(1);

		const reasm = new WabidbVideoReassembler();
		// Deliver in reverse (worst-case) order; only the last completes.
		let completed: Uint8Array | null = null;
		for (let i = chunks.length - 1; i >= 0; i--) {
			const res = reasm.push(chunks[i]);
			if (res) completed = res.frame;
		}
		expect(completed).not.toBeNull();
		expect(Array.from(completed!)).toEqual(Array.from(bytes));
	});

	test('different (userId, seq) frames do not cross-contaminate', () => {
		const a = new Uint8Array([10, 20, 30]);
		const b = new Uint8Array([99, 88, 77]);
		const reasm = new WabidbVideoReassembler();
		reasm.push({
			sessionId: 's', userId: 'uA', kind: 'video', seq: 1, payload: btoa(String.fromCharCode(...a)), chunkIndex: 0, chunkCount: 1
		});
		// different user -> independent buffer
		const fb = reasm.push({
			sessionId: 's', userId: 'uB', kind: 'video', seq: 1, payload: btoa(String.fromCharCode(...b)), chunkIndex: 0, chunkCount: 1
		});
		expect(Array.from(fb!.frame)).toEqual(Array.from(b));
	});
});

describe('wabidbDmSessionKey', () => {
	test('is deterministic for the same two peers', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7')).toBe(wabidbDmSessionKey('user-5', 'user-7'));
	});

	test('is symmetric regardless of caller/callee order', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7')).toBe(wabidbDmSessionKey('user-7', 'user-5'));
	});

	test('normalizes bare numeric ids to the stable user-{id} form', () => {
		expect(wabidbDmSessionKey('5', '7')).toBe(wabidbDmSessionKey('user-7', 'user-5'));
		expect(wabidbDmSessionKey('5', 'user-7')).toBe(wabidbDmSessionKey('user-5', 'user-7'));
	});

	test('is distinct per peer pair', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7')).not.toBe(wabidbDmSessionKey('user-5', 'user-8'));
		expect(wabidbDmSessionKey('user-5', 'user-7')).not.toBe(wabidbDmSessionKey('user-7', 'user-8'));
	});

	test('cannot collide with channel session ids (dm: prefix)', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7').startsWith('dm:')).toBe(true);
		expect(wabidbDmSessionKey('user-5', 'user-7')).not.toBe('session-1720000000000-abc123');
	});
});

describe('wabidbChannelSessionKey', () => {
	test('is deterministic for the same channel', () => {
		expect(wabidbChannelSessionKey('channel-abc')).toBe(wabidbChannelSessionKey('channel-abc'));
	});

	test('is identical for EVERY participant in the same channel', () => {
		// Two different users joining the same voice channel must derive the
		// same key or their audio never crosses (F19 gap).
		expect(wabidbChannelSessionKey('channel-abc')).toBe(wabidbChannelSessionKey('channel-abc'));
	});

	test('differs across channels', () => {
		expect(wabidbChannelSessionKey('channel-abc')).not.toBe(wabidbChannelSessionKey('channel-def'));
	});

	test('cannot collide with dm session keys (channel: prefix)', () => {
		expect(wabidbChannelSessionKey('user-5:user-7').startsWith('channel:')).toBe(true);
		expect(wabidbChannelSessionKey('user-5')).not.toBe(wabidbDmSessionKey('user-5', 'user-7'));
	});
});

describe('resolveWabidbSessionKey', () => {
	test('channel kind keeps the caller-provided sessionId', () => {
		expect(resolveWabidbSessionKey('channel', 'session-abc', '5', 'user-7')).toBe('session-abc');
	});

	test('undefined kind keeps the caller-provided sessionId', () => {
		expect(resolveWabidbSessionKey(undefined, 'session-abc', '5')).toBe('session-abc');
	});

	test('dm kind derives a shared rendezvous key from both peers', () => {
		expect(resolveWabidbSessionKey('dm', 'session-ignored', 'user-5', 'user-7')).toBe(
			wabidbDmSessionKey('user-5', 'user-7')
		);
	});

	test('dm kind is symmetric across the two endpoints', () => {
		const callerKey = resolveWabidbSessionKey('dm', 'caller-session', 'user-5', 'user-7');
		const calleeKey = resolveWabidbSessionKey('dm', 'callee-session', 'user-7', 'user-5');
		expect(callerKey).toBe(calleeKey);
		expect(callerKey).not.toBe('caller-session');
		expect(calleeKey).not.toBe('callee-session');
	});

	test('dm kind without a peer falls back to sessionId', () => {
		expect(resolveWabidbSessionKey('dm', 'session-abc', 'user-5')).toBe('session-abc');
	});
});

describe('wabidb video source discrimination (P1 dual-source)', () => {
	test('envelope round-trip preserves source', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const chunks = splitFrameIntoChunks('s1', 'u1', 5, bytes, {
			codec: 'vp8', width: 640, height: 360, keyFrame: true, source: 'screen'
		});
		for (const c of chunks) {
			const parsed = parseWabidbMediaEnvelope(c);
			expect(parsed!.source).toBe('screen');
		}
	});

	test('legacy video (no source) defaults to camera on reassembly', () => {
		const reasm = new WabidbVideoReassembler();
		const frame = reasm.push({
			sessionId: 's', userId: '2', kind: 'video', seq: 1,
			payload: btoa(String.fromCharCode(...[7, 8])), chunkIndex: 0, chunkCount: 1
		});
		expect(frame).not.toBeNull();
		expect(frame!.source).toBe('camera');
	});

	test('same user camera + screen do not cross-contaminate (composite keys)', () => {
		const cam = new Uint8Array([1, 1, 1]);
		const scr = new Uint8Array([9, 9, 9]);
		const mk = (userId: string, payload: number[]) => ({
			sessionId: 's', userId, kind: 'video' as const, seq: 42,
			payload: btoa(String.fromCharCode(...payload)), chunkIndex: 0, chunkCount: 1
		});
		const reasm = new WabidbVideoReassembler();
		reasm.push({ ...mk('user-7', [0]), source: 'camera' } as any);
		// push real payloads with sources via envelopes carrying `source`
		const fCam = reasm.push({ sessionId: 's', userId: 'user-7', kind: 'video', seq: 43, source: 'camera', payload: btoa(String.fromCharCode(...cam)), chunkIndex: 0, chunkCount: 1 });
		const fScr = reasm.push({ sessionId: 's', userId: 'user-7', kind: 'video', seq: 44, source: 'screen', payload: btoa(String.fromCharCode(...scr)), chunkIndex: 0, chunkCount: 1 });
		expect(fCam).not.toBeNull();
		expect(fScr).not.toBeNull();
		expect(fCam!.source).toBe('camera');
		expect(fScr!.source).toBe('screen');
		expect(Array.from(fCam!.frame)).toEqual(Array.from(cam));
		expect(Array.from(fScr!.frame)).toEqual(Array.from(scr));
	});

	test('videoStreamKey normalizes raw ids and defaults source', () => {
		expect(videoStreamKey('2')).toBe('user-2:camera');
		expect(videoStreamKey('2', 'screen')).toBe('user-2:screen');
		expect(videoStreamKey('user-9', 'screen')).toBe('user-9:screen');
	});

	test('clearStream removes only that source; clearUser removes all', () => {
		const env = (source?: 'camera' | 'screen') => ({
			sessionId: 's', userId: '3', kind: 'video' as const, seq: 1,
			source, payload: btoa('ab'), chunkIndex: 0, chunkCount: 1
		});
		const reasm = new WabidbVideoReassembler();
		reasm.push(env('camera'));
		reasm.push(env('screen'));
		reasm.clearStream('3', 'camera'); // raw id form must hit the stable key
		const afterClear = reasm.push({ ...env('camera'), seq: 2 });
		expect(afterClear).not.toBeNull(); // fresh buffer for camera again
		const stillBufferedScreen = reasm.push({ ...env('screen'), seq: 1 });
		expect(stillBufferedScreen).not.toBeNull();
		reasm.clearUser('3');
		const fresh = reasm.push({ ...env('screen'), seq: 3 });
		expect(fresh).not.toBeNull();
	});
});
