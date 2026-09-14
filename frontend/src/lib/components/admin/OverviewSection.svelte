<script module lang="ts">
	export type { DashboardStats } from '$lib/adminDashboard';
</script>

<script lang="ts">
	import {
		dashboardMetricValue,
		dashboardRoleOrder,
		normalizeDashboardRole,
		unavailableDashboardMetrics,
		type DashboardStats
	} from '$lib/adminDashboard';
	import type { AdminSection } from '$lib/adminNavigation';
	import { channels, connected, serverMembers, users, type User } from '$lib/socket';
	import { channelUnreadCounts } from '$lib/messageStore';
	import { fetchPluginInventory } from '$lib/addonInventory';
	import { activeServerUrl } from '$lib/serverUrl';
	import ServerHealthSection from './ServerHealthSection.svelte';
	import RoleBadge from './ui/RoleBadge.svelte';

	let { stats = null, loading = false, stale = false, onNavigate }: {
		stats?: DashboardStats | null;
		loading?: boolean;
		stale?: boolean;
		onNavigate: (section: AdminSection) => void;
	} = $props();

	const unavailable = $derived(unavailableDashboardMetrics(stats?.extra));
	const roles = $derived(stats?.roleDistribution.map(row => ({ ...row, role: normalizeDashboardRole(row.role) }))
		.sort((a, b) => dashboardRoleOrder(a.role) - dashboardRoleOrder(b.role)) ?? []);
	const openReports = $derived(stats ? dashboardMetricValue(stats.overview.openReports, 'openReports', stats.extra) : null);
	const bannedUsers = $derived(stats ? dashboardMetricValue(stats.overview.bannedUsers, 'bannedUsers', stats.extra) : null);
	const mutedUsers = $derived(stats ? dashboardMetricValue(stats.overview.mutedUsers, 'mutedUsers', stats.extra) : null);
	const auditEntries = $derived(stats ? dashboardMetricValue(stats.overview.totalAuditEntries, 'totalAuditEntries', stats.extra) : null);

	const roster = $derived.by(() => {
		const byId = new Map<string, User>();
		for (const user of $serverMembers) byId.set(String(user.dbUserId ?? user.id), user);
		for (const user of $users) byId.set(String(user.dbUserId ?? user.id), user);
		return [...byId.values()];
	});
	const onlineMembers = $derived($users.filter((user) => user.status === 'active' || user.status === 'away' || user.status === 'busy').length);
	const offlineMembers = $derived(Math.max(0, roster.length - onlineMembers));
	const textChannels = $derived($channels.filter((channel) => channel.type === 'text' || channel.type === 'public' || channel.type === 'thread_public').length);
	const voiceChannels = $derived($channels.filter((channel) => channel.type === 'voice' || channel.type === 'stage').length);
	const otherChannels = $derived(Math.max(0, $channels.length - textChannels - voiceChannels));
	const unreadTotal = $derived(Object.values($channelUnreadCounts).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0));

	let addonSummary = $state<{ count: number; names: string[] } | null>(null);
	$effect(() => {
		$activeServerUrl;
		let cancelled = false;
		addonSummary = null;
		void fetchPluginInventory().then((list) => {
			if (cancelled || !list) return;
			const enabled = list.filter((plugin) => plugin.enabled !== false);
			addonSummary = { count: enabled.length, names: enabled.map((plugin) => String(plugin.name || plugin.id || 'Add-on')).filter(Boolean).slice(0, 6) };
		}).catch(() => { if (!cancelled) addonSummary = null; });
		return () => { cancelled = true; };
	});

	const actionLabels: Record<string, string> = {
		role_assigned: 'Server role assigned',
		role_removed: 'Server role removed',
		channel_settings_updated: 'Channel settings updated',
	};
	const destinations: Array<{ section: AdminSection; label: string; description: string }> = [
		{ section: 'moderation', label: 'Moderation inbox', description: 'Reports, case comments and staff triage' },
		{ section: 'safety', label: 'Safety rules', description: 'Literal trigger → action automation' },
		{ section: 'privacy', label: 'Privacy & retention', description: 'Ephemeral, durable and private-space policy by choice' },
		{ section: 'storage', label: 'Storage', description: 'See what uploads are actually using disk' },
		{ section: 'infrastructure', label: 'Infrastructure', description: 'Relays, helpers and heartbeat health' },
		{ section: 'users', label: 'People', description: 'Roles, account recovery and member context' },
		{ section: 'branding', label: 'Server identity', description: 'Name, artwork and the welcome page' },
	];

	function formatAuditWhen(value: string | null): string | null {
		if (!value) return null;
		const time = Date.parse(value);
		if (!Number.isFinite(time)) return null;
		return new Date(time).toLocaleString();
	}
	function formatCount(value: number | null): string { return value === null ? 'n/a' : value.toLocaleString(); }
</script>

<div class="admin-overview admin-home" aria-busy={loading && !stats}>
	{#if !stats}
		<div class="admin-home-card admin-snapshot-empty" role="status">
			<h2>{loading ? 'Reading server status…' : 'No server snapshot'}</h2>
			<p>{loading ? 'Checking the database and loading the latest recorded changes.' : 'Refresh to try again. Missing data is not a healthy server or an empty server.'}</p>
		</div>
	{:else}
		<section class="server-center-hero" aria-labelledby="admin-overview-heading">
			<div>
				<span class="admin-section-label">Server Center</span>
				<h2 id="admin-overview-heading">{$connected ? 'Your server is reachable.' : 'This client is offline.'}</h2>
				<p>{onlineMembers.toLocaleString()} members online · {stats.overview.totalChannels.toLocaleString()} channels · {roster.length.toLocaleString()} known members</p>
			</div>
			<div class:healthy={$connected} class="server-center-health-dot"><span></span>{$connected ? 'Connected' : 'Disconnected'}</div>
		</section>

		<div class="admin-summary-grid">
			<div class="admin-summary"><span>Accounts</span><strong class="admin-stat-value">{stats.overview.totalUsers.toLocaleString()}</strong><small>Including guest accounts</small></div>
			<div class="admin-summary"><span>Online now</span><strong class="admin-stat-value">{stats.overview.onlineUsers.toLocaleString()}</strong><small>{stale ? 'At the last snapshot' : 'Connected to this server'}</small></div>
			<div class="admin-summary"><span>Unread messages</span><strong class="admin-stat-value">{unreadTotal.toLocaleString()}</strong><small>Across this client</small></div>
		</div>

		<section class="admin-home-card attention-card" aria-labelledby="admin-moderation-heading">
			<header class="admin-home-card-header">
				<div><span class="card-kicker">Community health</span><h2 id="admin-moderation-heading">Moderation</h2></div>
				<button class="admin-refresh" onclick={() => onNavigate('moderation')}>Open inbox</button>
			</header>
			<p class="admin-home-description">Reports have a real inbox with preserved message evidence, assignment, resolution state and private staff comments. Snapshot counters below are shown only when the server reports them.</p>
			<div class="admin-summary-grid admin-moderation-grid">
				<div class="admin-summary"><span>Open reports</span><strong class="admin-stat-value">{formatCount(openReports)}</strong><small>{openReports === null ? 'Open the inbox for live cases' : openReports === 0 ? 'Snapshot queue is clear' : 'Awaiting moderator review'}</small></div>
				<div class="admin-summary"><span>Banned accounts</span><strong class="admin-stat-value">{formatCount(bannedUsers)}</strong><small>{bannedUsers === null ? 'Not in this snapshot' : 'Recorded enforcement total'}</small></div>
				<div class="admin-summary"><span>Muted accounts</span><strong class="admin-stat-value">{formatCount(mutedUsers)}</strong><small>{mutedUsers === null ? 'Not in this snapshot' : 'Currently restricted'}</small></div>
				<div class="admin-summary"><span>Audit entries</span><strong class="admin-stat-value">{formatCount(auditEntries)}</strong><small>{auditEntries === null ? 'Not in this snapshot' : 'Recorded staff actions'}</small></div>
			</div>
		</section>

		<ServerHealthSection health={stats.extra?.health} {stale} />

		<section class="admin-home-card" aria-labelledby="admin-live-heading">
			<header class="admin-home-card-header"><div><span class="card-kicker">Right now</span><h2 id="admin-live-heading">Connection &amp; activity</h2></div></header>
			<div class="admin-summary-grid">
				<div class="admin-summary"><span>Connection</span><strong class="admin-stat-value admin-stat-presence">{$connected ? 'Online' : 'Offline'}</strong><small>{$connected ? 'Socket to this server is up' : 'Reconnect before moderating'}</small></div>
				<div class="admin-summary"><span>Members online</span><strong class="admin-stat-value">{onlineMembers.toLocaleString()}</strong><small>{offlineMembers.toLocaleString()} offline · {roster.length.toLocaleString()} known</small></div>
				<div class="admin-summary"><span>Channels</span><strong class="admin-stat-value">{$channels.length.toLocaleString()}</strong><small>{textChannels} text · {voiceChannels} voice · {otherChannels} other</small></div>
				<div class="admin-summary"><span>Add-ons</span><strong class="admin-stat-value">{addonSummary ? addonSummary.count.toLocaleString() : 'n/a'}</strong><small>{addonSummary ? (addonSummary.names.length > 0 ? addonSummary.names.join(' · ') : 'Enabled, none named') : 'Not reported by this server'}</small></div>
			</div>
		</section>

		<section class="admin-home-card" aria-labelledby="admin-manage-heading">
			<header class="admin-home-card-header"><div><span class="card-kicker">Go somewhere useful</span><h2 id="admin-manage-heading">Server tools</h2></div></header>
			<div class="server-tool-grid">
				{#each destinations as destination (destination.section)}
					<button onclick={() => onNavigate(destination.section)}><strong>{destination.label}</strong><span>{destination.description}</span><b aria-hidden="true">→</b></button>
				{/each}
			</div>
		</section>

		<div class="admin-home-columns">
			<section class="admin-home-card" aria-labelledby="admin-latest-heading">
				<header class="admin-home-card-header"><h2 id="admin-latest-heading">Recent recorded changes</h2></header>
				<p class="admin-home-description">This audit feed covers the change types the server currently records. The moderation inbox is the better place for report/case work.</p>
				{#if stats.extra?.auditCoverage?.length}<p class="admin-home-description">Tracked change types: {stats.extra.auditCoverage.join(', ')}</p>{/if}
				{#if unavailable.has('recentAudit')}
					<p class="admin-home-empty">This server version does not provide recorded activity.</p>
				{:else if !stats.recentAudit.length}
					<p class="admin-home-empty">No recorded administration changes yet.</p>
				{:else}
					<ol class="admin-recorded-activity">
						{#each stats.recentAudit as entry (entry.id)}
							<li><strong>{actionLabels[entry.action] ?? 'Administration change'}</strong>{#if entry.details}<p>{entry.details}</p>{/if}<div class="admin-recorded-meta"><span>{entry.performedBy ? 'By ' + entry.performedBy : 'Actor not recorded'}</span>{#if entry.targetUser}<span>Account: {entry.targetUser}</span>{/if}{#if entry.targetChannel}<span>Channel: {entry.targetChannel}</span>{/if}<span>{formatAuditWhen(entry.createdAt) ?? 'Time not recorded'}</span></div></li>
						{/each}
					</ol>
				{/if}
			</section>
			<section class="admin-home-card" aria-labelledby="admin-roles-heading">
				<h2 id="admin-roles-heading">People by role</h2>
				<ul class="admin-role-summary">{#each roles as row}<li><RoleBadge role={row.role} /><span>{row.count.toLocaleString()}</span></li>{/each}</ul>
			</section>
		</div>
	{/if}
</div>

<style>
	.server-center-hero{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px;border:1px solid var(--border-default);border-radius:18px;background:linear-gradient(135deg,var(--surface-raised),var(--surface-base));margin-bottom:16px}.server-center-hero h2{margin:5px 0 5px;font-size:clamp(1.35rem,3vw,2rem)}.server-center-hero p{margin:0;color:var(--text-secondary)}.server-center-health-dot{display:flex;align-items:center;gap:8px;white-space:nowrap;padding:7px 11px;border:1px solid var(--border-default);border-radius:999px;color:var(--text-secondary)}.server-center-health-dot span{width:9px;height:9px;border-radius:50%;background:var(--text-muted)}.server-center-health-dot.healthy span{background:#57b66b;box-shadow:0 0 0 4px color-mix(in srgb,#57b66b 18%,transparent)}.card-kicker{display:block;margin-bottom:2px;font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--text-muted)}.attention-card{overflow:hidden}.admin-moderation-grid{margin-top:16px}.admin-home-card-header .admin-refresh{min-height:38px;padding:7px 12px;border:1px solid var(--border-default);background:var(--surface-base);color:var(--text-primary);border-radius:var(--radius-md);font:inherit;cursor:pointer}.admin-home-card-header .admin-refresh:hover{background:var(--surface-hover)}.server-tool-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.server-tool-grid button{display:grid;grid-template-columns:1fr auto;text-align:left;gap:3px 10px;align-items:center;padding:14px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-base);color:var(--text-primary);font:inherit;cursor:pointer}.server-tool-grid button:hover{background:var(--surface-hover)}.server-tool-grid strong,.server-tool-grid span{grid-column:1}.server-tool-grid span{color:var(--text-secondary);font-size:.82rem}.server-tool-grid b{grid-column:2;grid-row:1/3;font-size:1.15rem}.admin-stat-presence{font-size:1.35rem}@media(max-width:850px){.server-tool-grid{grid-template-columns:1fr 1fr}}@media(max-width:600px){.server-center-hero{display:grid}.server-tool-grid{grid-template-columns:1fr}}
</style>
