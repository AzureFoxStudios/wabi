/** These fields were historically placeholder zeroes/empty arrays, not real
 * counters. Older servers omit availability metadata, so stay conservative. */
export const LEGACY_UNAVAILABLE_DASHBOARD_METRICS = [
	'totalMessages', 'totalEmojis', 'mutedUsers', 'totalAuditEntries',
	'openReports', 'recentAudit', 'topUsers',
] as const;

export type DashboardAvailability = { unavailableMetrics?: unknown };

export function unavailableDashboardMetrics(extra?: DashboardAvailability | null): Set<string> {
	const declared = extra?.unavailableMetrics;
	return new Set(Array.isArray(declared) && declared.every((metric) => typeof metric === 'string')
		? declared : LEGACY_UNAVAILABLE_DASHBOARD_METRICS);
}

export function normalizeDashboardRole(role: string): string {
	const normalized = role.trim().toLowerCase();
	return normalized === 'moderator' ? 'mod' : normalized;
}

export function dashboardRoleOrder(role: string): number {
	const rank = ['owner', 'admin', 'mod', 'member', 'guest'].indexOf(normalizeDashboardRole(role));
	return rank < 0 ? 5 : rank;
}

export function dashboardMetricValue(value: number, metric: string, extra?: DashboardAvailability | null): number | null {
	return unavailableDashboardMetrics(extra).has(metric) || !Number.isFinite(value) || value < 0 ? null : value;
}
