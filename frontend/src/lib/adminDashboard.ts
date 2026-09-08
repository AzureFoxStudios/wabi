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

export interface AdminServerHealth {
	status: 'ready' | 'degraded';
	writerRunning: boolean;
	projectionHealthy: boolean;
	appliedCommitSeq: string;
	committedSeq: string | null;
	uptimeSeconds: number | null;
	processMemoryBytes: number | null;
	sampledAt: string;
}

export interface AdminActivity {
	id: string;
	action: string;
	performedBy: string | null;
	targetUser: string | null;
	targetChannel: string | null;
	details: string | null;
	createdAt: string | null;
}

export interface DashboardStats {
	overview: Record<'totalUsers' | 'onlineUsers' | 'bannedUsers' | 'mutedUsers' | 'totalChannels' | 'totalRoles' | 'totalEmojis' | 'totalMessages' | 'totalAuditEntries' | 'openReports', number>;
	roleDistribution: Array<{ role: string; count: number }>;
	statusDistribution: Array<{ status: string; count: number }>;
	recentAudit: AdminActivity[];
	extra?: DashboardAvailability & {
		health?: AdminServerHealth;
		registeredUsers?: number;
		botUsers?: number;
		channelsByKind?: Record<string, number>;
		auditCoverage?: string[];
	};
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';

/** Validate before mounting the dashboard. An HTML fallback or malformed snapshot
 * is an error, not an empty server or a successful health check. */
export function parseDashboardStats(value: unknown): DashboardStats {
	const invalid = () => new Error('The server returned an invalid administration snapshot.');
	if (!object(value) || !object(value.overview)) throw invalid();
	for (const key of ['totalUsers', 'onlineUsers', 'bannedUsers', 'mutedUsers', 'totalChannels', 'totalRoles', 'totalEmojis', 'totalMessages', 'totalAuditEntries', 'openReports']) {
		if (!count(value.overview[key])) throw invalid();
	}
	if (!Array.isArray(value.roleDistribution) || !value.roleDistribution.every(row => object(row) && typeof row.role === 'string' && count(row.count))) throw invalid();
	if (!Array.isArray(value.statusDistribution) || !value.statusDistribution.every(row => object(row) && typeof row.status === 'string' && count(row.count))) throw invalid();
	if (!Array.isArray(value.recentAudit) || !value.recentAudit.every(row => object(row) &&
		(typeof row.id === 'string' || count(row.id)) && typeof row.action === 'string' &&
		['performedBy', 'targetUser', 'targetChannel', 'details', 'createdAt'].every(key => nullableText(row[key])))) throw invalid();
	const extra = object(value.extra) ? value.extra : undefined;
	const health = extra?.health;
	if (health !== undefined) {
		if (!object(health) || !['ready', 'degraded'].includes(String(health.status)) ||
			typeof health.writerRunning !== 'boolean' || typeof health.projectionHealthy !== 'boolean' ||
			typeof health.appliedCommitSeq !== 'string' || !/^\d+$/.test(health.appliedCommitSeq) ||
			!(health.committedSeq === null || (typeof health.committedSeq === 'string' && /^\d+$/.test(health.committedSeq))) ||
			!(health.uptimeSeconds === null || duration(health.uptimeSeconds)) ||
			!(health.processMemoryBytes === null || count(health.processMemoryBytes)) ||
			typeof health.sampledAt !== 'string' || !Number.isFinite(Date.parse(health.sampledAt))) throw invalid();
		if ((health.status === 'ready') !== (health.writerRunning && health.projectionHealthy)) throw invalid();
	}
	return {
		overview: value.overview as DashboardStats['overview'],
		roleDistribution: value.roleDistribution as DashboardStats['roleDistribution'],
		statusDistribution: value.statusDistribution as DashboardStats['statusDistribution'],
		recentAudit: value.recentAudit.map(row => ({ ...row, id: String(row.id) })) as AdminActivity[],
		extra: extra as DashboardStats['extra'],
	};
}

export function formatDashboardBytes(bytes: number | null | undefined): string {
	if (bytes == null || !count(bytes)) return 'Not available';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatDashboardUptime(seconds: number | null | undefined): string {
	if (seconds == null || !duration(seconds)) return 'Not available';
	if (seconds < 60) return 'Less than a minute';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
