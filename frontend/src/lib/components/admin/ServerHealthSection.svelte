<script lang="ts">
	import { _ } from '$lib/i18n';
	import { formatDashboardBytes, formatDashboardUptime, type AdminServerHealth } from '$lib/adminDashboard';

	let { health, loading = false, stale = false, expanded = false }: {
		health?: AdminServerHealth;
		loading?: boolean;
		stale?: boolean;
		expanded?: boolean;
	} = $props();
	const ready = $derived(Boolean(health?.writerRunning && health?.projectionHealthy && !stale));
	const label = $derived(loading ? $_('server_health.checking') : stale ? $_('server_health.last_known') : !health ? $_('server_health.not_available') : ready ? $_('server_health.ready') : $_('server_health.needs_attention'));
</script>

<section class="admin-home-card admin-health" aria-label={$_('server_health.label')}>
	<header class="admin-home-card-header">
		<h2>{$_('server_health.label')}</h2>
		<span class="admin-health-status" class:ready class:degraded={Boolean(health && !ready && !stale)}>{label}</span>
	</header>
	{#if health}
		<p class="admin-home-description">{stale
			? $_('server_health.stale_note')
			: ready ? $_('server_health.ready_note')
			: $_('server_health.unhealthy_note')}</p>
		<dl class="admin-health-metrics">
			<div><dt>{$_('server_health.uptime')}</dt><dd>{formatDashboardUptime(health.uptimeSeconds)}</dd></div>
			<div><dt>{$_('server_health.memory')}</dt><dd>{formatDashboardBytes(health.processMemoryBytes)}</dd></div>
			<div><dt>{$_('server_health.writer')}</dt><dd>{health.writerRunning ? $_('server_health.running') : $_('server_health.stopped')}</dd></div>
			<div><dt>{$_('server_health.applying')}</dt><dd>{health.projectionHealthy ? $_('server_health.healthy') : $_('server_health.failed')}</dd></div>
		</dl>
		{#if expanded}
			<div class="admin-health-details">
				<h3>{$_('server_health.applied_heading')}</h3>
				<p>{$_('server_health.applied_commit')} <code>{health.appliedCommitSeq}</code></p>
				<p>{$_('server_health.applied_note')}</p>
				<p>{$_('server_health.memory_note')}</p>
			</div>
		{/if}
	{:else}
		<p class="admin-home-description">{loading ? $_('server_health.waiting') : $_('server_health.no_measure')}</p>
	{/if}
</section>
