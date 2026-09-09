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

	// Moderation signals come from the same server snapshot — counts only.
	// The client has no report queue, ban log, or mute history store, so a
	// null here means "not reported by this server", never zero activity.
	const openReports = $derived(stats ? dashboardMetricValue(stats.overview.openReports, 'openReports', stats.extra) : null);
	const bannedUsers = $derived(stats ? dashboardMetricValue(stats.overview.bannedUsers, 'bannedUsers', stats.extra) : null);
	const mutedUsers = $derived(stats ? dashboardMetricValue(stats.overview.mutedUsers, 'mutedUsers', stats.extra) : null);
	const auditEntries = $derived(stats ? dashboardMetricValue(stats.overview.totalAuditEntries, 'totalAuditEntries', stats.extra) : null);

	// Live client-side signals for the cockpit: presence, channels, unreads.
	// Keep offline registered members visible. Online entries provide current presence.
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
			if (cancelled) return;
			if (!list) return;
			const enabled = list.filter((plugin) => plugin.enabled !== false);
			addonSummary = {
				count: enabled.length,
				names: enabled.map((plugin) => String(plugin.name || plugin.id || 'Add-on')).filter(Boolean).slice(0, 6)
			};
		}).catch(() => {
			if (!cancelled) addonSummary = null;
		});
		return () => { cancelled = true; };
	});
	const actionLabels: Record<string, string> = {
		role_assigned: 'Server role assigned',
		role_removed: 'Server role removed',
		channel_settings_updated: 'Channel settings updated',
	};
	const destinations: Array<{ section: AdminSection; label: string; description: string }> = [
		{ section: 'users', label: 'Manage people', description: 'Roles, account recovery and conversations' },
		{ section: 'branding', label: 'Server identity', description: 'Name, artwork and the welcome page' },
		{ section: 'payments', label: 'Payment access', description: 'Control who can create requests' },
	];

	function formatAuditWhen(value: string | null): string | null {
		if (!value) return null;
		const time = Date.parse(value);
		if (!Number.isFinite(time)) return null;
		return new Date(time).toLocaleString();
	}

	function formatCount(value: number | null): string {
		return value === null ? 'n/a' : value.toLocaleString();
	}
</script>

<div class="admin-overview admin-home" aria-busy={loading && !stats}>
	{#if !stats}
		<div class="admin-home-card admin-snapshot-empty" role="status">
			<h2>{loading ? 'Reading server status…' : 'No server snapshot'}</h2>
			<p>{loading ? 'Checking the database and loading the latest recorded changes.' : 'Refresh to try again. Missing data is not a healthy server or an empty server.'}</p>
		</div>
	{:else}
		<span class="admin-section-label" id="admin-overview-heading">Overview</span>
		<div class="admin-summary-grid" aria-labelledby="admin-overview-heading">
			<div class="admin-summary"><span>Accounts</span><strong class="admin-stat-value">{stats.overview.totalUsers.toLocaleString()}</strong><small>Including guest accounts</small></div>
			<div class="admin-summary"><span>Online now</span><strong class="admin-stat-value">{stats.overview.onlineUsers.toLocaleString()}</strong><small>{stale ? 'At the last snapshot' : 'Connected to this server'}</small></div>
			<div class="admin-summary"><span>Channels</span><strong class="admin-stat-value">{stats.overview.totalChannels.toLocaleString()}</strong><small>Including conversations and folders</small></div>
		</div>

		<section class="admin-home-card" aria-labelledby="admin-moderation-heading">
			<header class="admin-home-card-header">
				<h2 id="admin-moderation-heading">Moderation signals</h2>
				{#if stale}<span class="admin-health-status">Last snapshot</span>{/if}
			</header>
			<p class="admin-home-description">Snapshot counts for triage. This client has no report queue, ban log, or mute history — the recent staff activity below is the full moderation history available here. “n/a” means this server version does not report the metric.</p>
			<div class="admin-summary-grid admin-moderation-grid">
				<div class="admin-summary"><span>Open reports</span><strong class="admin-stat-value">{formatCount(openReports)}</strong><small>{openReports === null ? 'Not reported by this server' : openReports === 0 ? 'Queue is clear' : 'Awaiting moderator review'}</small></div>
				<div class="admin-summary"><span>Banned accounts</span><strong class="admin-stat-value">{formatCount(bannedUsers)}</strong><small>Server-wide enforcement total</small></div>
				<div class="admin-summary"><span>Muted accounts</span><strong class="admin-stat-value">{formatCount(mutedUsers)}</strong><small>{mutedUsers === null ? 'Not reported by this server' : 'Currently restricted from speaking'}</small></div>
				<div class="admin-summary"><span>Audit entries</span><strong class="admin-stat-value">{formatCount(auditEntries)}</strong><small>{auditEntries === null ? 'Not reported by this server' : 'Recorded staff actions'}</small></div>
			</div>
			<div class="admin-moderation-actions">
				<button class="admin-refresh" onclick={() => onNavigate('users')}>Review people</button>
			</div>
		</section>

		<ServerHealthSection health={stats.extra?.health} {stale} />

		<section class="admin-home-card" aria-labelledby="admin-live-heading">
			<header class="admin-home-card-header"><h2 id="admin-live-heading">Connection &amp; activity</h2></header>
			<p class="admin-home-description">Live client-side signals for this session — no server round-trip.</p>
			<div class="admin-summary-grid">
				<div class="admin-summary"><span>Connection</span><strong class="admin-stat-value admin-stat-presence">{$connected ? 'Online' : 'Offline'}</strong><small>{$connected ? 'Socket to this server is up' : 'Reconnect before moderating'}</small></div>
				<div class="admin-summary"><span>Members online</span><strong class="admin-stat-value">{onlineMembers.toLocaleString()}</strong><small>{offlineMembers.toLocaleString()} offline · {roster.length.toLocaleString()} known</small></div>
				<div class="admin-summary"><span>Unread messages</span><strong class="admin-stat-value">{unreadTotal.toLocaleString()}</strong><small>Across all channels</small></div>
				<div class="admin-summary"><span>Channels</span><strong class="admin-stat-value">{$channels.length.toLocaleString()}</strong><small>{textChannels} text · {voiceChannels} voice · {otherChannels} other</small></div>
				<div class="admin-summary"><span>Add-ons</span><strong class="admin-stat-value">{addonSummary ? addonSummary.count.toLocaleString() : 'n/a'}</strong><small>{addonSummary ? (addonSummary.names.length > 0 ? addonSummary.names.join(' · ') : 'Enabled, none named') : 'Not reported by this server'}</small></div>
			</div>
		</section>

		<div class="admin-home-columns">
			<section class="admin-home-card" aria-labelledby="admin-latest-heading">
				<header class="admin-home-card-header"><h2 id="admin-latest-heading">Recent staff actions</h2></header>
				<p class="admin-home-description">Server role and channel settings changes, newest first. Joins, leaves, bans, and mutes are not tracked by this client, so they cannot appear here — this is not a complete moderation log.</p>
				{#if stats.extra?.auditCoverage?.length}
					<p class="admin-home-description">Tracked change types: {stats.extra.auditCoverage.join(', ')}</p>
				{/if}
				{#if unavailable.has('recentAudit')}
					<p class="admin-home-empty">This server version does not provide recorded activity.</p>
				{:else if !stats.recentAudit.length}
					<p class="admin-home-empty">No role or channel settings changes have been recorded yet.</p>
				{:else}
					<ol class="admin-recorded-activity">
						{#each stats.recentAudit as entry (entry.id)}
							<li>
								<strong>{actionLabels[entry.action] ?? 'Administration change'}</strong>
								{#if entry.details}<p>{entry.details}</p>{/if}
								<div class="admin-recorded-meta">
									<span>{entry.performedBy ? 'By ' + entry.performedBy : 'Actor not recorded'}</span>
									{#if entry.targetUser}<span>Account: {entry.targetUser}</span>{/if}
									{#if entry.targetChannel}<span>Channel: {entry.targetChannel}</span>{/if}
									<span>{formatAuditWhen(entry.createdAt) ?? 'Time not recorded'}</span>
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			</section>
			<div class="admin-home-secondary">
				<section class="admin-home-card" aria-labelledby="admin-manage-heading">
					<h2 id="admin-manage-heading">Manage your server</h2>
					<div class="admin-home-destinations">
						{#each destinations as destination (destination.section)}
							<button onclick={() => onNavigate(destination.section)}><strong>{destination.label}</strong><span>{destination.description}</span></button>
						{/each}
					</div>
				</section>
				<section class="admin-home-card" aria-labelledby="admin-roles-heading">
					<h2 id="admin-roles-heading">People by role</h2>
					<ul class="admin-role-summary">
						{#each roles as row}
							<li><RoleBadge role={row.role} /><span>{row.count.toLocaleString()}</span></li>
						{/each}
					</ul>
				</section>
			</div>
		</div>
	{/if}
</div>

<style>
	.admin-moderation-grid {
		margin-top: 16px;
	}
	.admin-moderation-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}
	.admin-moderation-actions .admin-refresh {
		min-height: 40px;
		padding: 8px 14px;
		border: 1px solid var(--border-default);
		background: var(--surface-base);
		color: var(--text-primary);
		-webkit-text-fill-color: currentColor;
		border-radius: var(--radius-md);
		font: inherit;
		cursor: pointer;
	}
	.admin-moderation-actions .admin-refresh:hover {
		background: var(--surface-hover);
	}
	.admin-stat-presence {
		font-size: 1.35rem;
	}
</style>
