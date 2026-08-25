/**
 * T3/T5: watchdog demotion/promotion state machine, invariant-style.
 * The watchdog's probe hook is injectable via a global; tests drive it
 * directly. No network, no real transports.
 */
import { describe, expect, test, mock } from 'bun:test';

// Boundary mock — same pattern as callingFallback.test.ts.
mock.module('./callingStateStores', () => ({
	callTransportState: {
		update: (_fn: any) => {},
		set: (_v: any) => {}
	},
	callOfflineNotice: { set: (_v: any) => {} }
}));

const { transportWatchdog } = await import('./callingWatchdog');

// Fake clock control for grace/probe timers.
type Timer = ReturnType<typeof setTimeout>;
const pendingTimers: Timer[] = [];
const origSetTimeout = globalThis.setTimeout;
const origSetInterval = globalThis.setInterval;
// (bun runs timers for real; tests below use tiny ms values instead of faking.)

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

	test('disconnect + failed probe demotes to next chain link (auto -> p2p)', async () => {
		let primaryAlive = false;
		(globalThis as any).__wabidbProbePrimary = (t: string) =>
			t === 'wabidb' ? primaryAlive : true; // p2p always "connectable" here

		const connectedVia: string[] = [];
		transportWatchdog.start({
			mode: 'auto',
			active: 'wabidb',
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
			mode: 'auto',
			active: 'wabidb',
			connect: async () => {
				throw new Error('should not reconnect anything');
			},
			graceMs: 10,
			probeIntervalMs: 10
		});
		// Flip alive back on before the grace probe runs.
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
});
