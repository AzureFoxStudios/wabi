<script module lang="ts">
	export type { DashboardStats } from '$lib/adminDashboard';
</script>

<script lang="ts">
	import { dashboardRoleOrder, normalizeDashboardRole, unavailableDashboardMetrics, type DashboardStats } from '$lib/adminDashboard';
	import type { AdminSection } from '$lib/adminNavigation';
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
</script>

<div class="admin-overview admin-home" aria-busy={loading && !stats}>
	{#if !stats}
		<div class="admin-home-card admin-snapshot-empty" role="status">
			<h2>{loading ? 'Reading server status…' : 'No server snapshot'}</h2>
			<p>{loading ? 'Checking the database and loading the latest recorded changes.' : 'Refresh to try again. Missing data is not a healthy server or an empty server.'}</p>
		</div>
	{:else}
		<div class="admin-summary-grid">
			<div class="admin-summary"><span>Accounts</span><strong class="admin-stat-value">{stats.overview.totalUsers.toLocaleString()}</strong><small>Including guest accounts</small></div>
			<div class="admin-summary"><span>Online now</span><strong class="admin-stat-value">{stats.overview.onlineUsers.toLocaleString()}</strong><small>{stale ? 'At the last snapshot' : 'Connected to this server'}</small></div>
			<div class="admin-summary"><span>Channels</span><strong class="admin-stat-value">{stats.overview.totalChannels.toLocaleString()}</strong><small>Including conversations and folders</small></div>
		</div>

		<ServerHealthSection health={stats.extra?.health} {stale} />

		<div class="admin-home-columns">
			<section class="admin-home-card" aria-labelledby="admin-latest-heading">
				<header class="admin-home-card-header"><h2 id="admin-latest-heading">Latest recorded changes</h2></header>
				<p class="admin-home-description">Server role and channel settings changes, newest first. This is not a complete moderation log.</p>
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
