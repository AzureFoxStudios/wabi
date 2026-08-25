/**
 * T2/T5 invariant tests: chain resolution + fallback execution.
 * Invariant-style — asserts how mode × surface × size map to chains, never
 * snapshotting contents that may legitimately evolve.
 */
import { describe, expect, test, mock } from 'bun:test';

// Mock the store boundary itself — callingFallback only needs
// callTransportState + callOfflineNotice, and mocking here avoids dragging
// mediaRuntime's $app/environment virtual module into bun's module graph.
mock.module('./callingStateStores', () => ({
	callTransportState: { update: (_fn: any) => {}, set: (_v: any) => {} },
	callOfflineNotice: { set: (_v: any) => {} }
}));
const { FALLBACK_CHAINS, MESH_MAX_PARTICIPANTS, chainForMode, effectiveChain } = await import(
	'./callingFallback'
);

describe('transport fallback chains', () => {
	test('every stored mode has a non-empty chain', () => {
		for (const mode of ['auto', 'wabidb', 'sfu-preferred', 'p2p-only']) {
			const chain = chainForMode(mode);
			expect(chain.length).toBeGreaterThan(0);
		}
	});

	test('auto prefers the local relay over p2p (offline/LAN rule)', () => {
		expect(chainForMode('auto')[0]).toBe('wabidb');
	});

	test('strict modes have single-link chains (no surprise fallback)', () => {
		expect(chainForMode('wabidb')).toEqual(['wabidb']);
		expect(chainForMode('p2p-only')).toEqual(['p2p']);
	});

	test('sfu-preferred ends somewhere usable even if sfu is down', () => {
		const chain = chainForMode('sfu-preferred');
		expect(chain[0]).toBe('sfu');
		expect(chain.length).toBeGreaterThanOrEqual(2);
	});

	test('large channels/groups trim the p2p mesh tail', () => {
		const big = effectiveChain('auto', 'channel', MESH_MAX_PARTICIPANTS + 1);
		expect(big).not.toContain('p2p');
		const small = effectiveChain('auto', 'channel', 3);
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
