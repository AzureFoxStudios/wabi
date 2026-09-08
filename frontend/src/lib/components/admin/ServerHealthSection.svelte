<script lang="ts">
	import { formatDashboardBytes, formatDashboardUptime, type AdminServerHealth } from '$lib/adminDashboard';

	let { health, loading = false, stale = false, expanded = false }: {
		health?: AdminServerHealth;
		loading?: boolean;
		stale?: boolean;
		expanded?: boolean;
	} = $props();
	const ready = $derived(Boolean(health?.writerRunning && health?.projectionHealthy && !stale));
	const label = $derived(loading ? 'Checking…' : stale ? 'Last known status' : !health ? 'Not available' : ready ? 'Ready' : 'Needs attention');
</script>

<section class="admin-home-card admin-health" aria-label="Server health">
	<header class="admin-home-card-header">
		<h2>Server health</h2>
		<span class="admin-health-status" class:ready class:degraded={Boolean(health && !ready && !stale)}>{label}</span>
	</header>
	{#if health}
		<p class="admin-home-description">{stale
			? 'These are the last observed values. Refresh before relying on this status.'
			: ready ? 'The database writer is running and changes are being applied to readable state.'
			: 'The database writer or change application is unhealthy. Check the server logs before retrying writes.'}</p>
		<dl class="admin-health-metrics">
			<div><dt>Server uptime</dt><dd>{formatDashboardUptime(health.uptimeSeconds)}</dd></div>
			<div><dt>Server process memory</dt><dd>{formatDashboardBytes(health.processMemoryBytes)}</dd></div>
			<div><dt>Database writer</dt><dd>{health.writerRunning ? 'Running' : 'Stopped'}</dd></div>
			<div><dt>Applying changes</dt><dd>{health.projectionHealthy ? 'Healthy' : 'Failed'}</dd></div>
		</dl>
		{#if expanded}
			<div class="admin-health-details">
				<h3>Applied database state</h3>
				<p>Applied commit: <code>{health.appliedCommitSeq}</code></p>
				<p>This is the latest database commit visible to queries. It is not a message count, backup status or replication confirmation.</p>
				<p>Memory is the server process’s resident memory, not the whole computer or container. CPU, disk capacity, external call relays and backups are not measured here.</p>
			</div>
		{/if}
	{:else}
		<p class="admin-home-description">{loading ? 'Waiting for a fresh server health snapshot.' : 'This server has not supplied health measurements. A successful connection alone does not confirm database health.'}</p>
	{/if}
</section>
