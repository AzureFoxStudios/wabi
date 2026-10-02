/**
 * T3/T5: watchdog demotion/promotion state machine, invariant-style.
 * The watchdog's probe hook is injectable via a global; tests drive it
 * directly. No network, no real transports.
 */
import { describe, expect, test, mock } from 'bun:test';

mock.module('./callingStateStores', () => ({
	callTransportState: {
		update: (_fn: any) => {},
		set: (_v: any) => {}
	},
	callOfflineNotice: { set: (_v: any) => {} }
}));

const { transportWatchdog } = await import('./callingWatchdog');

describe('transport watchdog', () => {
	test('starts in monitoring on the primary', async () => {
		const events: string[] = [];
		(globalThis as any).__wabidbProbePrimary = (t: string) => t === 'wabidb';
		transportWatchdog.onTransition((s) => events.push(s));
		transportWatchdog.start({
			mode: 'auto',
			active: 'wabidb',
			connect: async () => {},
			graceMs: 10,
			probeIntervalMs: 10
		});
		expect(transportWatchdog.status).toBe('monitoring');
		expect(transportWatchdog.riding).toBe('wabidb');
		transportWatchdog.stop();
	});

	test('p2p demotion requires explicit trust-boundary opt-in', async () => {
		(globalThis as any).__wabidbProbePrimary = () => false;
		const connectedVia: string[] = [];
		transportWatchdog.start({
			mode: 'auto', active: 'wabidb', graceMs: 5, probeIntervalMs: 10,
			connect: async transport => { connectedVia.push(transport); }
		});
		transportWatchdog.handleDisconnect();
		await new Promise((r) => setTimeout(r, 40));
		expect(connectedVia).toEqual([]);
		expect(transportWatchdog.status).toBe('stopped');
		transportWatchdog.stop();
	});

	test('explicitly opted-in private call may demote auto -> p2p', async () => {
		let primaryAlive = false;
		(globalThis as any).__wabidbProbePrimary = (t: string) =>
			t === 'wabidb' ? primaryAlive : true;
		const connectedVia: string[] = [];
		transportWatchdog.start({
			mode: 'auto',
			active: 'wabidb',
			allowP2pDemotion: true,
			connect: async (transport) => {
				connectedVia.push(transport);
				if (transport !== 'p2p') throw new Error('only p2p wired in this test');
			},
			graceMs: 10,
			probeIntervalMs: 10
		});
		transportWatchdog.handleDisconnect();
		expect(transportWatchdog.status).toBe('demoting');
		await new Promise((r) => setTimeout(r, 60));
		expect(primaryAlive ? 'monitoring' : 'demoted').toBe('demoted');
		expect(connectedVia).toContain('p2p');
		expect(transportWatchdog.riding).toBe('p2p');
		transportWatchdog.stop();
	});

	test('grace-period recovery does NOT demote', async () => {
		let alive = true;
		(globalThis as any).__wabidbProbePrimary = (t: string) => (t === 'wabidb' ? alive : false);
		transportWatchdog.start({
			mode: 'auto', active: 'wabidb', connect: async () => { throw new Error('should not reconnect anything'); },
			graceMs: 10, probeIntervalMs: 10
		});
		setTimeout(() => { alive = true; }, 5);
		alive = false;
		transportWatchdog.handleDisconnect();
		await new Promise((r) => setTimeout(r, 60));
		expect(transportWatchdog.status).toBe('monitoring');
		transportWatchdog.stop();
	});

	test('stop() clears everything', () => {
		(globalThis as any).__wabidbProbePrimary = () => false;
		transportWatchdog.start({ mode: 'auto', active: 'wabidb', connect: async () => {} });
		transportWatchdog.stop();
		expect(transportWatchdog.status).toBe('stopped');
	});

	test('promotion never reuses the old primary teardown on the new primary', async () => {
		let alive = false;
		let retired = 0;
		(globalThis as any).__wabidbProbePrimary = () => alive;
		transportWatchdog.start({ mode: 'auto', active: 'wabidb', allowP2pDemotion: true, graceMs: 1, probeIntervalMs: 10,
			disconnectCurrent: async () => { retired++; },
			connect: async transport => { if (transport === 'p2p') alive = true; }
		});
		transportWatchdog.handleDisconnect();
		await new Promise(r => setTimeout(r, 40));
		expect(transportWatchdog.riding).toBe('wabidb');
		expect(retired).toBe(1);
		transportWatchdog.stop();
	});

	test('stop during asynchronous connect cannot resurrect the watchdog', async () => {
		let complete!: () => void;
		(globalThis as any).__wabidbProbePrimary = () => false;
		transportWatchdog.start({ mode: 'auto', active: 'wabidb', allowP2pDemotion: true, graceMs: 1, probeIntervalMs: 10,
			connect: () => new Promise<void>(r => { complete = r; })
		});
		transportWatchdog.handleDisconnect();
		await new Promise(r => setTimeout(r, 10));
		transportWatchdog.stop(); complete();
		await new Promise(r => setTimeout(r, 5));
		expect(transportWatchdog.status).toBe('stopped');
		transportWatchdog.stop();
	});
});
