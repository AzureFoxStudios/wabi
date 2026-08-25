/**
 * T4/T5: adapter registry contract — invariant-style. Proves the seam works
 * for third-party transports without touching core call paths.
 */
import { describe, expect, test } from 'bun:test';
import {
	registerCallTransport,
	getCallTransport,
	listCallTransports,
	resolveAvailable
} from './registry';
import { ensureBuiltinTransports } from './builtins';

ensureBuiltinTransports();

describe('transport adapter registry', () => {
	test('all three built-ins are registered through the same seam a plugin uses', () => {
		const ids = listCallTransports().map((a) => a.id);
		expect(ids).toContain('wabidb');
		expect(ids).toContain('p2p');
		expect(ids).toContain('sfu');
	});

	test('unknown ids resolve to null (server-advertised but not installed)', async () => {
		expect(await resolveAvailable('vendor-xyz', null)).toBeNull();
		expect(getCallTransport('vendor-xyz')).toBeNull();
	});

	test('sfu availability follows the runtime snapshot, soft-failing on null', async () => {
		expect(await resolveAvailable('sfu', null)).toBeNull();
		const ready = await resolveAvailable('sfu', {
			media: { sfu: { provider: 'livekit' }, livekit: { configured: true, url: 'wss://x' } }
		} as any);
		expect(ready?.id).toBe('sfu');
	});

	test('third-party adapters register and resolve exactly like built-ins', async () => {
		registerCallTransport({
			id: 'vendor-mesh',
			label: 'VendorMesh',
			isAvailable: () => true,
			connect: async () => {}
		});
		const adapter = await resolveAvailable('vendor-mesh', null);
		expect(adapter?.label).toBe('VendorMesh');
	});

	test('isAvailable that throws degrades to unavailable, never crashes the chain', async () => {
		registerCallTransport({
			id: 'broken',
			label: 'Broken',
			isAvailable: () => {
				throw new Error('boom');
			},
			connect: async () => {}
		});
		expect(await resolveAvailable('broken', null)).toBeNull();
	});
});
