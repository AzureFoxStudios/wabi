<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { AdminCompressionConfig, AdminCompressionMetrics } from '$lib/api';

	export let compressionConfig: AdminCompressionConfig | null;
	export let compressionMetrics: AdminCompressionMetrics | null;
	export let compressionLoading: boolean;
	export let compressionError: string;
	export let onRefresh: () => void;
	export let onResetMetrics: () => void;

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatRatio(value: number | null): string {
		if (value == null || !Number.isFinite(value)) return $_('compression.na');
		return value.toFixed(3);
	}
</script>

<div class="admin-section">
	<div class="compression-header">
		<h4>{$_('compression.observability')}</h4>
		<div class="compression-actions">
			<button class="admin-btn" disabled={compressionLoading} on:click={onRefresh}>
				{compressionLoading ? $_('compression.loading') : $_('network_health.refresh')}
			</button>
			<button class="admin-btn danger" disabled={compressionLoading} on:click={onResetMetrics}>
				{$_('compression.reset')}
			</button>
		</div>
	</div>
	{#if compressionError}
		<div class="admin-empty">{compressionError}</div>
	{:else if compressionConfig && compressionMetrics}
		<div class="compression-grid">
			<div class="compression-stat">
				<span class="k">{$_('compression.http_text')}</span>
				<span class="v">{compressionConfig.httpTextCompression.enabled ? $_('compression.enabled') : $_('compression.disabled')}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.upload_compression')}</span>
				<span class="v">{compressionConfig.uploadCompression.enabled ? $_('compression.enabled') : $_('compression.disabled')}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.upload_rollout')}</span>
				<span class="v">{compressionConfig.uploadCompression.rolloutPercent}%</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.uploads')}</span>
				<span class="v">{compressionMetrics.counters.uploadCount}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.downloads')}</span>
				<span class="v">{compressionMetrics.counters.downloadCount}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.upload_ratio')}</span>
				<span class="v">{formatRatio(compressionMetrics.counters.uploadStoredToOriginalRatio)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.download_ratio')}</span>
				<span class="v">{formatRatio(compressionMetrics.counters.downloadResponseToStoredRatio)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.upload_bytes')}</span>
				<span class="v">{formatBytes(compressionMetrics.counters.uploadStoredBytes)} / {formatBytes(compressionMetrics.counters.uploadOriginalBytes)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('compression.download_bytes')}</span>
				<span class="v">{formatBytes(compressionMetrics.counters.downloadResponseBytes)} / {formatBytes(compressionMetrics.counters.downloadStoredBytes)}</span>
			</div>
			{#if compressionMetrics.clientVideoCompression}
				<div class="compression-stat">
					<span class="k">{$_('compression.client_attempts')}</span>
					<span class="v">{compressionMetrics.clientVideoCompression.counters.attemptCount}</span>
				</div>
				<div class="compression-stat">
					<span class="k">{$_('compression.client_success')}</span>
					<span class="v">{formatRatio(compressionMetrics.clientVideoCompression.counters.successRate)}</span>
				</div>
				<div class="compression-stat">
					<span class="k">{$_('compression.client_timeouts')}</span>
					<span class="v">{compressionMetrics.clientVideoCompression.counters.timeoutCount}</span>
				</div>
				<div class="compression-stat">
					<span class="k">{$_('compression.client_output')}</span>
					<span class="v">{formatRatio(compressionMetrics.clientVideoCompression.counters.outputToInputRatio)}</span>
				</div>
			{/if}
		</div>
		{#if compressionMetrics.clientVideoCompression}
			{#if compressionMetrics.clientVideoCompression.summaryByRuntime.length > 0}
				<div class="compression-grid">
					{#each compressionMetrics.clientVideoCompression.summaryByRuntime as runtimeSummary (runtimeSummary.runtime)}
						<div class="compression-stat">
							<span class="k">{$_('compression.client_runtime', { values: { runtime: runtimeSummary.runtime } })}</span>
							<span class="v">
								{$_('compression.runtime_summary', { values: { ok: runtimeSummary.successCount, fail: runtimeSummary.failureCount, cancel: runtimeSummary.cancelledCount } })}
							</span>
						</div>
					{/each}
				</div>
			{/if}
			{#if compressionMetrics.clientVideoCompression.topFailureCodes.length > 0}
				<div class="compression-failure-tags">
					{#each compressionMetrics.clientVideoCompression.topFailureCodes as item (item.failureCode)}
						<span class="compression-failure-tag">{item.failureCode}: {item.count}</span>
					{/each}
				</div>
			{/if}
		{/if}
	{:else}
		<div class="admin-empty">{$_('compression.no_metrics')}</div>
	{/if}
</div>


