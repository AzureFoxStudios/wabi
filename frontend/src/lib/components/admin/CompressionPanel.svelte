<script lang="ts">
	import type { AdminCompressionConfig, AdminCompressionMetrics } from '$lib/api';

	export let compressionConfig: AdminCompressionConfig | null;
	export let compressionMetrics: AdminCompressionMetrics | null;
	export let compressionLoading: boolean;
	export let compressionError: string;
	export let onRefresh: () => void;
	export let onResetMetrics: () => void;
</script>

<div class="admin-section">
	<div class="compression-header">
		<h4>Compression Observability</h4>
		<div class="compression-actions">
			<button class="admin-btn" disabled={compressionLoading} on:click={onRefresh}>
				{compressionLoading ? 'Loading...' : 'Refresh'}
			</button>
			<button class="admin-btn danger" disabled={compressionLoading} on:click={onResetMetrics}>
				Reset Metrics
			</button>
		</div>
	</div>
	{#if compressionError}
		<div class="admin-empty">{compressionError}</div>
	{:else if compressionConfig && compressionMetrics}
		<div class="compression-grid">
			<div class="compression-stat">
				<span class="k">HTTP Text</span>
				<span class="v">{compressionConfig.httpTextCompression.enabled ? 'Enabled' : 'Disabled'}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Upload Compression</span>
				<span class="v">{compressionConfig.uploadCompression.enabled ? 'Enabled' : 'Disabled'}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Upload Rollout</span>
				<span class="v">{compressionConfig.uploadCompression.rolloutPercent}%</span>
			</div>
			<div class="compression-stat">
				<span class="k">Uploads</span>
				<span class="v">{compressionMetrics.counters.uploadCount}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Downloads</span>
				<span class="v">{compressionMetrics.counters.downloadCount}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Upload Ratio</span>
				<span class="v">{formatRatio(compressionMetrics.counters.uploadStoredToOriginalRatio)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Download Ratio</span>
				<span class="v">{formatRatio(compressionMetrics.counters.downloadResponseToStoredRatio)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Upload Bytes</span>
				<span class="v">{formatBytes(compressionMetrics.counters.uploadStoredBytes)} / {formatBytes(compressionMetrics.counters.uploadOriginalBytes)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Download Bytes</span>
				<span class="v">{formatBytes(compressionMetrics.counters.downloadResponseBytes)} / {formatBytes(compressionMetrics.counters.downloadStoredBytes)}</span>
			</div>
			{#if compressionMetrics.clientVideoCompression}
				<div class="compression-stat">
					<span class="k">Client Attempts</span>
					<span class="v">{compressionMetrics.clientVideoCompression.counters.attemptCount}</span>
				</div>
				<div class="compression-stat">
					<span class="k">Client Success Rate</span>
					<span class="v">{formatRatio(compressionMetrics.clientVideoCompression.counters.successRate)}</span>
				</div>
				<div class="compression-stat">
					<span class="k">Client Timeouts</span>
					<span class="v">{compressionMetrics.clientVideoCompression.counters.timeoutCount}</span>
				</div>
				<div class="compression-stat">
					<span class="k">Client Output Ratio</span>
					<span class="v">{formatRatio(compressionMetrics.clientVideoCompression.counters.outputToInputRatio)}</span>
				</div>
			{/if}
		</div>
		{#if compressionMetrics.clientVideoCompression}
			{#if compressionMetrics.clientVideoCompression.summaryByRuntime.length > 0}
				<div class="compression-grid">
					{#each compressionMetrics.clientVideoCompression.summaryByRuntime as runtimeSummary (runtimeSummary.runtime)}
						<div class="compression-stat">
							<span class="k">Client {runtimeSummary.runtime}</span>
							<span class="v">
								{runtimeSummary.successCount} ok / {runtimeSummary.failureCount} fail / {runtimeSummary.cancelledCount} cancel
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
		<div class="admin-empty">No compression metrics yet.</div>
	{/if}
</div>

<script lang="ts">
	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatRatio(value: number | null): string {
		if (value == null || !Number.isFinite(value)) return 'n/a';
		return value.toFixed(3);
	}
</script>
