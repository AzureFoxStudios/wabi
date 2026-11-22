import { afterEach, describe, expect, test } from 'bun:test';
import {
	PEER_CONNECTION_UNAVAILABLE,
	createVideoCodecGlGuard,
	hasPeerConnection,
	isWebKitGtk,
	requirePeerConnection
} from './mediaCapabilities';

const scope = globalThis as { RTCPeerConnection?: unknown };
const original = scope.RTCPeerConnection;
afterEach(() => {
	if (original === undefined) delete scope.RTCPeerConnection;
	else scope.RTCPeerConnection = original;
});

describe('peer connection capability', () => {
	test('is read from the runtime each time, not cached at import', () => {
		delete scope.RTCPeerConnection;
		expect(hasPeerConnection()).toBe(false);
		expect(() => requirePeerConnection()).toThrow(PEER_CONNECTION_UNAVAILABLE);
		scope.RTCPeerConnection = class {};
		expect(hasPeerConnection()).toBe(true);
		expect(() => requirePeerConnection()).not.toThrow();
	});
});

describe('WebKitGTK detection', () => {
	test('matches the Linux system webview and nothing Chromium, Gecko, Apple or Android', () => {
		// As reported by WebKitGTK 2.54 inside the desktop app.
		expect(isWebKitGtk('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15')).toBe(true);
		for (const other of [
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
			'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
			'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
			''
		]) {
			expect(isWebKitGtk(other)).toBe(false);
		}
	});
});

describe('video codec GL guard', () => {
	test('does nothing where the engine does not need it', () => {
		let created = 0;
		const guard = createVideoCodecGlGuard(() => false, () => { created++; return {}; });
		expect(guard()).toBe(true);
		expect(created).toBe(0);
	});

	test('creates one context on first use and keeps answering yes', () => {
		let created = 0;
		const guard = createVideoCodecGlGuard(() => true, () => { created++; return {}; });
		expect(created).toBe(0); // nothing at construction: idle memory must not move
		expect(guard()).toBe(true);
		expect(guard()).toBe(true);
		expect(created).toBe(1);
	});

	test('no context means video must not be attempted, and it is not retried', () => {
		for (const createContext of [() => null, () => { throw new Error('no GL'); }]) {
			let calls = 0;
			const guard = createVideoCodecGlGuard(() => true, () => { calls++; return createContext(); });
			expect(guard()).toBe(false);
			expect(guard()).toBe(false);
			expect(calls).toBe(1);
		}
	});
});
