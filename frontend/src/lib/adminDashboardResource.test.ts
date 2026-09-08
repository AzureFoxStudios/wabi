import { describe, expect, test } from 'bun:test';
import { createAdminDashboardResource, emptyAdminSnapshot, AdminDashboardAccessError } from './adminDashboardResource';
import { parseDashboardStats, formatDashboardBytes, formatDashboardUptime } from './adminDashboard';

export function dashboardFixture() {
	return {
		overview: { totalUsers: 4, onlineUsers: 1, bannedUsers: 0, mutedUsers: 0, totalChannels: 3, totalRoles: 2, totalEmojis: 0, totalMessages: 0, totalAuditEntries: 12, openReports: 0 },
		roleDistribution: [{ role: 'Owner', count: 1 }], statusDistribution: [{ status: 'online', count: 1 }], recentAudit: [],
		extra: { unavailableMetrics: ['openReports', 'totalMessages'], health: {
			status: 'ready', writerRunning: true, projectionHealthy: true, appliedCommitSeq: '9007199254740993', committedSeq: null,
			uptimeSeconds: 120.25, processMemoryBytes: 1024 ** 2, sampledAt: '2026-09-08T12:00:00Z',
		} },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
	return { promise, resolve, reject };
}

describe('administration snapshot boundary', () => {
	test('preserves sequence strings and does not require new health fields from old servers', () => {
		expect(parseDashboardStats(dashboardFixture()).extra?.health?.appliedCommitSeq).toBe('9007199254740993');
		expect(parseDashboardStats(dashboardFixture()).extra?.health?.uptimeSeconds).toBe(120.25);
		expect(parseDashboardStats({ ...dashboardFixture(), extra: undefined }).extra).toBeUndefined();
	});
	test('rejects fake success, fractional counts and contradictory health', () => {
		expect(() => parseDashboardStats('<html>fallback</html>')).toThrow('invalid');
		const badCount = dashboardFixture(); badCount.overview.totalUsers = 0.5;
		expect(() => parseDashboardStats(badCount)).toThrow('invalid');
		const badHealth = dashboardFixture(); badHealth.extra.health.writerRunning = false;
		expect(() => parseDashboardStats(badHealth)).toThrow('invalid');
	});
	test('missing measurements are not formatted as zero', () => {
		expect(formatDashboardBytes(null)).toBe('Not available');
		expect(formatDashboardBytes(0)).toBe('0 B');
		expect(formatDashboardBytes(2 * 1024 ** 2)).toBe('2.0 MiB');
		expect(formatDashboardUptime(undefined)).toBe('Not available');
		expect(formatDashboardUptime(90061)).toBe('1d 1h');
		expect(formatDashboardUptime(120.25)).toBe('2m');
		expect(formatDashboardUptime(Infinity)).toBe('Not available');
	});
});

describe('mounted Admin read ownership', () => {
	test('coalesces polling and refresh, records arrival only after a valid response', async () => {
		const read = deferred<unknown>(); let calls = 0; let state = emptyAdminSnapshot();
		const resource = createAdminDashboardResource({ read: () => { calls++; return read.promise; }, onChange: value => { state = value; }, now: () => 55 });
		const first = resource.refresh(); const second = resource.refresh();
		expect(first).toBe(second);
		await Promise.resolve(); expect(calls).toBe(1); expect(state.loading).toBe(true); expect(state.receivedAt).toBeNull();
		read.resolve(dashboardFixture()); await first;
		expect(state.loading).toBe(false); expect(state.receivedAt).toBe(55); expect(state.stats?.overview.totalUsers).toBe(4);
		resource.dispose();
	});
	test('a failed poll retains an explicitly stale snapshot, never a fabricated zero', async () => {
		let fail = false; let state = emptyAdminSnapshot();
		const resource = createAdminDashboardResource({ read: async () => { if (fail) throw new Error('Network unavailable'); return dashboardFixture(); }, onChange: value => { state = value; }, now: () => 55 });
		await resource.refresh(); fail = true; await resource.refresh();
		expect(state.stats?.overview.totalUsers).toBe(4); expect(state.error).toBe('Network unavailable'); expect(state.receivedAt).toBe(55);
		resource.dispose();
	});
	test('access loss discards privileged snapshots', async () => {
		let denied = false; let state = emptyAdminSnapshot();
		const resource = createAdminDashboardResource({ read: async () => { if (denied) throw new AdminDashboardAccessError('Access changed'); return dashboardFixture(); }, onChange: value => { state = value; } });
		await resource.refresh(); denied = true; await resource.refresh();
		expect(state.stats).toBeNull(); expect(state.receivedAt).toBeNull(); expect(state.error).toBe('Access changed'); resource.dispose();
	});
	test('close/logout cancels even a reader that ignores abort and suppresses late publication', async () => {
		const read = deferred<unknown>(); let changes = 0; let signal: AbortSignal | undefined;
		const resource = createAdminDashboardResource({ read: value => { signal = value; return read.promise; }, onChange: () => changes++ });
		const pending = resource.refresh(); await Promise.resolve(); resource.dispose(); await pending;
		expect(signal?.aborted).toBe(true); expect(changes).toBe(1);
		read.resolve(dashboardFixture()); await Promise.resolve(); await resource.refresh(); expect(changes).toBe(1);
	});
	test('an unresponsive reader has a bounded, retryable failure', async () => {
		let state = emptyAdminSnapshot();
		const resource = createAdminDashboardResource({ read: () => new Promise(() => {}), onChange: value => { state = value; }, timeoutMs: 1 });
		await resource.refresh(); expect(state.loading).toBe(false); expect(state.error).toContain('did not respond'); resource.dispose();
	});
});
