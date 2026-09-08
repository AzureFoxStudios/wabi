import { expect, test } from 'bun:test';
import { dashboardMetricValue, dashboardRoleOrder, normalizeDashboardRole, unavailableDashboardMetrics } from './adminDashboard';

test('legacy placeholder zeroes are unavailable, not activity/count claims', () => {
	for (const metric of ['totalMessages', 'totalEmojis', 'mutedUsers', 'totalAuditEntries', 'openReports']) {
		expect(dashboardMetricValue(0, metric)).toBeNull();
		expect(dashboardMetricValue(42, metric)).toBeNull();
	}
	expect(unavailableDashboardMetrics().has('recentAudit')).toBe(true);
	expect(unavailableDashboardMetrics().has('topUsers')).toBe(true);
});

test('real known counters preserve genuine zeroes and future servers can declare support', () => {
	for (const metric of ['totalUsers', 'onlineUsers', 'totalChannels', 'totalRoles', 'bannedUsers']) {
		expect(dashboardMetricValue(0, metric)).toBe(0);
		expect(dashboardMetricValue(5, metric)).toBe(5);
	}
	expect(dashboardMetricValue(0, 'totalMessages', { unavailableMetrics: [] })).toBe(0);
	expect(dashboardMetricValue(7, 'totalMessages', { unavailableMetrics: ['openReports'] })).toBe(7);
	expect(unavailableDashboardMetrics({ unavailableMetrics: [] }).has('recentAudit')).toBe(false);
});

test('malformed availability/counts fail conservatively', () => {
	for (const unavailableMetrics of [null, 'all', [1]]) {
		expect(dashboardMetricValue(0, 'totalMessages', { unavailableMetrics })).toBeNull();
	}
	expect(dashboardMetricValue(NaN, 'totalUsers')).toBeNull();
	expect(dashboardMetricValue(-1, 'onlineUsers')).toBeNull();
});

test('TitleCase RBAC values and lowercase socket values use identical presentation/order', () => {
	expect(normalizeDashboardRole('Moderator')).toBe('mod');
	expect(normalizeDashboardRole(' Owner ')).toBe('owner');
	expect(['Member', 'guest', 'Admin', 'OWNER', 'Moderator'].sort((a, b) => dashboardRoleOrder(a) - dashboardRoleOrder(b)))
		.toEqual(['OWNER', 'Admin', 'Moderator', 'Member', 'guest']);
	expect(dashboardRoleOrder('unknown')).toBeGreaterThan(dashboardRoleOrder('guest'));
});
