/**
 * T2/T5 invariant tests: chain resolution + fallback execution.
 * Invariant-style — asserts how mode × surface × size map to chains, never
 * snapshotting contents that may legitimately evolve.
 */
import { describe, expect, test, mock } from 'bun:test';

// Mock the store boundary itself — callingFallback only needs
// callTransportState + callOfflineNotice, and mocking here avoids dragging
// mediaRuntime's $app/environment virtual module into bun's module graph.
let offlineNotice: string | null = null;
mock.module('./callingStateStores', () => ({
	callTransportState: { update: (_fn: any) => {}, set: (_v: any) => {} },
	callOfflineNotice: { set: (value: string | null) => { offlineNotice = value; } }
}));
const { FALLBACK_CHAINS, MESH_MAX_PARTICIPANTS, chainForMode, effectiveChain, connectWithFallback } = await import(
	'./callingFallback'
);

describe('transport fallback chains', () => {
	test('cancellation during either a successful or failed attempt cannot fall back', async () => {
		for (const fails of [false, true]) {
			let current = true;
			const attempted: string[] = [];
			const result = connectWithFallback({ mode: 'auto', surface: 'group', stillWanted: () => current,
				connect: async transport => { attempted.push(transport); current = false; if (fails) throw new Error('late failure'); }
			}).catch(error => error);
			expect((await result).name).toBe('AbortError');
			expect(attempted).toEqual(['wabidb']);
		}
	});

	test('every stored mode has a non-empty base chain', () => {
		for (const mode of ['auto', 'wabidb', 'sfu-preferred', 'p2p-only']) {
			const chain = chainForMode(mode);
			expect(chain.length).toBeGreaterThan(0);
		}
	});

	test('auto prefers the local relay over p2p (offline/LAN rule)', () => {
		expect(chainForMode('auto')[0]).toBe('wabidb');
	});

	test('strict modes have single-link base chains (no surprise fallback)', () => {
		expect(chainForMode('wabidb')).toEqual(['wabidb']);
		expect(chainForMode('p2p-only')).toEqual(['p2p']);
	});

	test('sfu-preferred ends somewhere usable even if sfu is down', () => {
		const chain = chainForMode('sfu-preferred');
		expect(chain[0]).toBe('sfu');
		expect(chain.length).toBeGreaterThanOrEqual(2);
	});

	test('community voice never contains a direct p2p downgrade', () => {
		for (const participants of [1, 3, MESH_MAX_PARTICIPANTS, MESH_MAX_PARTICIPANTS + 1]) {
			expect(effectiveChain('auto', 'channel', participants)).toEqual(['wabidb']);
			expect(effectiveChain('sfu-preferred', 'channel', participants)).toEqual(['sfu', 'wabidb']);
		}
	});

	test('p2p-only fails closed for community voice instead of weakening moderation', async () => {
		offlineNotice = null;
		const attempted: string[] = [];
		const error = await connectWithFallback({
			mode: 'p2p-only',
			surface: 'channel',
			expectedParticipants: 2,
			connect: async transport => { attempted.push(transport); }
		}).catch(value => value as Error);
		expect(attempted).toEqual([]);
		expect(error.message).toContain('cannot enforce server mute/deafen');
		expect(offlineNotice).toContain('Direct P2P is unavailable');
	});

	test('large groups trim the p2p mesh tail while small groups keep it', () => {
		const big = effectiveChain('auto', 'group', MESH_MAX_PARTICIPANTS + 1);
		expect(big).not.toContain('p2p');
		const small = effectiveChain('auto', 'group', 3);
		expect(small).toContain('p2p');
	});

	test('DMs always keep their p2p tail regardless of size bookkeeping', () => {
		const chain = effectiveChain('auto', 'direct', 99);
		expect(chain).toContain('p2p');
	});

	test('unknown mode falls back to auto behavior', () => {
		expect(chainForMode('garbage')).toEqual(FALLBACK_CHAINS.auto);
	});
});
