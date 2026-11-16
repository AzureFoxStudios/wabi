<script module lang="ts">
	export type { DashboardStats } from '$lib/adminDashboard';
</script>

<script lang="ts">
	import { _ } from '$lib/i18n';
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
			addonSummary = { count: enabled.length, names: enabled.map((plugin) => String(plugin.name || plugin.id || $_('overview.addon_default'))).filter(Boolean).slice(0, 6) };
		}).catch(() => { if (!cancelled) addonSummary = null; });
		return () => { cancelled = true; };
	});

	const actionLabels: Record<string, string> = {
		role_assigned: $_('overview.action_role_assigned'),
		role_removed: $_('overview.action_role_removed'),
		channel_settings_updated: $_('overview.action_channel_settings'),
	};
	const destinations: Array<{ section: AdminSection; label: string; description: string }> = [
		{ section: 'moderation', label: $_('mod.inbox'), description: $_('overview.dest_moderation_desc') },
		{ section: 'safety', label: $_('safety.eyebrow'), description: $_('overview.dest_safety_desc') },
		{ section: 'privacy', label: $_('pc.eyebrow'), description: $_('overview.dest_privacy_desc') },
		{ section: 'storage', label: $_('settings.tabs.storage'), description: $_('overview.dest_storage_desc') },
		{ section: 'infrastructure', label: $_('overview.dest_infrastructure'), description: $_('overview.dest_infrastructure_desc') },
		{ section: 'users', label: $_('places.people'), description: $_('overview.dest_people_desc') },
		{ section: 'branding', label: $_('overview.dest_identity'), description: $_('overview.dest_identity_desc') },
	];

	function formatAuditWhen(value: string | null): string | null {
		if (!value) return null;
		const time = Date.parse(value);
		if (!Number.isFinite(time)) return null;
		return new Date(time).toLocaleString();
	}
	function formatCount(value: number | null): string { return value === null ? $_('payment_intent.na') : value.toLocaleString(); }
</script>

<div class="admin-overview admin-home" aria-busy={loading && !stats}>
	{#if !stats}
		<div class="admin-home-card admin-snapshot-empty" role="status">
			<h2>{loading ? $_('overview.reading_status') : $_('overview.no_snapshot')}</h2>
			<p>{loading ? $_('overview.checking_db') : $_('overview.refresh_again')}</p>
		</div>
	{:else}
		<section class="server-center-hero" aria-labelledby="admin-overview-heading">
			<div>
				<span class="admin-section-label">{$_('overview.server_center')}</span>
				<h2 id="admin-overview-heading">{$connected ? $_('overview.hero_title_online') : $_('overview.hero_title_offline')}</h2>
				<p>{$_('overview.hero_summary', { values: { online: onlineMembers.toLocaleString(), channels: stats.overview.totalChannels.toLocaleString(), known: roster.length.toLocaleString() } })}</p>
			</div>
			<div class:healthy={$connected} class="server-center-health-dot"><span></span>{$connected ? $_('lore_channel.connected') : $_('call_tile.disconnected')}</div>
		</section>

		<div class="admin-summary-grid">
			<div class="admin-summary"><span>{$_('overview.accounts')}</span><strong class="admin-stat-value">{stats.overview.totalUsers.toLocaleString()}</strong><small>{$_('overview.including_guests')}</small></div>
			<div class="admin-summary"><span>{$_('overview.online_now')}</span><strong class="admin-stat-value">{stats.overview.onlineUsers.toLocaleString()}</strong><small>{stale ? $_('overview.at_last_snapshot') : $_('overview.connected_to_server')}</small></div>
			<div class="admin-summary"><span>{$_('overview.unread_messages')}</span><strong class="admin-stat-value">{unreadTotal.toLocaleString()}</strong><small>{$_('overview.across_client')}</small></div>
		</div>

		<section class="admin-home-card attention-card" aria-labelledby="admin-moderation-heading">
			<header class="admin-home-card-header">
				<div><span class="card-kicker">{$_('overview.community_health')}</span><h2 id="admin-moderation-heading">{$_('admin.sec_moderation')}</h2></div>
				<button class="admin-refresh" onclick={() => onNavigate('moderation')}>{$_('overview.open_inbox')}</button>
			</header>
			<p class="admin-home-description">{$_('overview.moderation_desc')}</p>
			<div class="admin-summary-grid admin-moderation-grid">
				<div class="admin-summary"><span>{$_('admin.card_open_reports')}</span><strong class="admin-stat-value">{formatCount(openReports)}</strong><small>{openReports === null ? $_('overview.open_inbox_live') : openReports === 0 ? $_('overview.snapshot_clear') : $_('overview.awaiting_review')}</small></div>
				<div class="admin-summary"><span>{$_('overview.banned_accounts')}</span><strong class="admin-stat-value">{formatCount(bannedUsers)}</strong><small>{bannedUsers === null ? $_('overview.not_in_snapshot') : $_('overview.recorded_total')}</small></div>
				<div class="admin-summary"><span>{$_('overview.muted_accounts')}</span><strong class="admin-stat-value">{formatCount(mutedUsers)}</strong><small>{mutedUsers === null ? $_('network_health.not_measured') : $_('overview.currently_restricted')}</small></div>
				<div class="admin-summary"><span>{$_('overview.audit_entries')}</span><strong class="admin-stat-value">{formatCount(auditEntries)}</strong><small>{auditEntries === null ? $_('overview.not_in_snapshot') : $_('overview.recorded_actions')}</small></div>
			</div>
		</section>

		<ServerHealthSection health={stats.extra?.health} {stale} />

		<section class="admin-home-card" aria-labelledby="admin-live-heading">
			<header class="admin-home-card-header"><div><span class="card-kicker">{$_('overview.right_now')}</span><h2 id="admin-live-heading">{$_('overview.connection_activity')}</h2></div></header>
			<div class="admin-summary-grid">
				<div class="admin-summary"><span>{$_('overview.connection')}</span><strong class="admin-stat-value admin-stat-presence">{$connected ? $_('user.status.online') : $_('user.status.offline')}</strong><small>{$connected ? $_('overview.socket_up') : $_('overview.reconnect_first')}</small></div>
				<div class="admin-summary"><span>{$_('overview.members_online')}</span><strong class="admin-stat-value">{onlineMembers.toLocaleString()}</strong><small>{$_('overview.members_summary', { values: { offline: offlineMembers.toLocaleString(), known: roster.length.toLocaleString() } })}</small></div>
				<div class="admin-summary"><span>{$_('shell.mobile.channels')}</span><strong class="admin-stat-value">{$channels.length.toLocaleString()}</strong><small>{$_('overview.channels_summary', { values: { text: textChannels, voice: voiceChannels, other: otherChannels } })}</small></div>
				<div class="admin-summary"><span>{$_('settings.tabs.addons')}</span><strong class="admin-stat-value">{addonSummary ? addonSummary.count.toLocaleString() : $_('payment_intent.na')}</strong><small>{addonSummary ? (addonSummary.names.length > 0 ? addonSummary.names.join(' · ') : $_('overview.enabled_none_named')) : $_('about_settings.not_reported')}</small></div>
			</div>
		</section>

		<section class="admin-home-card" aria-labelledby="admin-manage-heading">
			<header class="admin-home-card-header"><div><span class="card-kicker">{$_('overview.go_somewhere')}</span><h2 id="admin-manage-heading">{$_('overview.server_tools')}</h2></div></header>
			<div class="server-tool-grid">
				{#each destinations as destination (destination.section)}
					<button onclick={() => onNavigate(destination.section)}><strong>{destination.label}</strong><span>{destination.description}</span><b aria-hidden="true">→</b></button>
				{/each}
			</div>
		</section>

		<div class="admin-home-columns">
			<section class="admin-home-card" aria-labelledby="admin-latest-heading">
				<header class="admin-home-card-header"><h2 id="admin-latest-heading">{$_('overview.recent_changes')}</h2></header>
				<p class="admin-home-description">{$_('overview.audit_feed_desc')}</p>
				{#if stats.extra?.auditCoverage?.length}<p class="admin-home-description">{$_('overview.tracked_types')} {stats.extra.auditCoverage.join(', ')}</p>{/if}
				{#if unavailable.has('recentAudit')}
					<p class="admin-home-empty">{$_('overview.no_activity')}</p>
				{:else if !stats.recentAudit.length}
					<p class="admin-home-empty">{$_('overview.no_changes')}</p>
				{:else}
					<ol class="admin-recorded-activity">
						{#each stats.recentAudit as entry (entry.id)}
							<li><strong>{actionLabels[entry.action] ?? $_('overview.admin_change')}</strong>{#if entry.details}<p>{entry.details}</p>{/if}<div class="admin-recorded-meta"><span>{entry.performedBy ? $_('overview.by', { values: { name: entry.performedBy } }) : $_('overview.actor_not_recorded')}</span>{#if entry.targetUser}<span>{$_('overview.account', { values: { name: entry.targetUser } })}</span>{/if}{#if entry.targetChannel}<span>{$_('overview.channel', { values: { name: entry.targetChannel } })}</span>{/if}<span>{formatAuditWhen(entry.createdAt) ?? $_('overview.time_not_recorded')}</span></div></li>
						{/each}
					</ol>
				{/if}
			</section>
			<section class="admin-home-card" aria-labelledby="admin-roles-heading">
				<h2 id="admin-roles-heading">{$_('overview.people_by_role')}</h2>
				<ul class="admin-role-summary">{#each roles as row}<li><RoleBadge role={row.role} /><span>{row.count.toLocaleString()}</span></li>{/each}</ul>
			</section>
		</div>
	{/if}
</div>

<style>
	.server-center-hero{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px;border:1px solid var(--w-line-strong);border-radius:18px;background:linear-gradient(135deg,var(--w-raise),var(--w-bg2));margin-bottom:16px}.server-center-hero h2{margin:5px 0 5px;font-size:clamp(1.35rem,3vw,2rem)}.server-center-hero p{margin:0;color:var(--w-mute)}.server-center-health-dot{display:flex;align-items:center;gap:8px;white-space:nowrap;padding:7px 11px;border:1px solid var(--w-line-strong);border-radius:999px;color:var(--w-mute)}.server-center-health-dot span{width:9px;height:9px;border-radius:50%;background:var(--w-mute)}.server-center-health-dot.healthy span{background:#57b66b;box-shadow:0 0 0 4px color-mix(in srgb,#57b66b 18%,transparent)}.card-kicker{display:block;margin-bottom:2px;font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--w-mute)}.attention-card{overflow:hidden}.admin-moderation-grid{margin-top:16px}.admin-home-card-header .admin-refresh{min-height:38px;padding:7px 12px;border:1px solid var(--w-line-strong);background:var(--w-bg2);color:var(--w-text);border-radius:calc(10px * var(--w-rs, 1));font:inherit;cursor:pointer}.admin-home-card-header .admin-refresh:hover{background:var(--w-raise)}.server-tool-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.server-tool-grid button{display:grid;grid-template-columns:1fr auto;text-align:left;gap:3px 10px;align-items:center;padding:14px;border:1px solid var(--w-line-strong);border-radius:12px;background:var(--w-bg2);color:var(--w-text);font:inherit;cursor:pointer}.server-tool-grid button:hover{background:var(--w-raise)}.server-tool-grid strong,.server-tool-grid span{grid-column:1}.server-tool-grid span{color:var(--w-mute);font-size:.82rem}.server-tool-grid b{grid-column:2;grid-row:1/3;font-size:1.15rem}.admin-stat-presence{font-size:1.35rem}@media(max-width:850px){.server-tool-grid{grid-template-columns:1fr 1fr}}@media(max-width:600px){.server-center-hero{display:grid}.server-tool-grid{grid-template-columns:1fr}}
</style>
