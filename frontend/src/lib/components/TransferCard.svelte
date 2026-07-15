<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { FileTransfer } from '$lib/p2pFileTransfer';

	export let transfer: FileTransfer;

	const dispatch = createEventDispatcher<{
		cancel: void;
		pause: void;
		resume: void;
		restart: void;
	}>();

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		const val = bytes / Math.pow(1024, i);
		return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
	}

	function formatSpeed(bytesPerSec?: number): string {
		if (bytesPerSec == null || bytesPerSec <= 0) return '';
		return `${formatBytes(bytesPerSec)}/s`;
	}

	function statusLabel(status: string): string {
		const labels: Record<string, string> = {
			pending: 'Pending',
			connecting: 'Connecting',
			preparing: 'Preparing',
			hashing: 'Hashing',
			requesting: 'Requesting',
			transferring: 'Transferring',
			paused: 'Paused',
			resuming: 'Resuming',
			verifying: 'Verifying',
			complete: 'Complete',
			failed: 'Failed',
			cancelled: 'Cancelled'
		};
		return labels[status] || status;
	}
</script>

<div class="transfer-card" class:failed={transfer.status === 'failed'} class:paused={transfer.status === 'paused'} class:complete={transfer.status === 'complete'}>
	<div class="card-header">
		<span class="card-direction" title={transfer.direction === 'send' ? 'Outgoing' : 'Incoming'}>
			{#if transfer.direction === 'send'}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
			{:else}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
			{/if}
		</span>
		<span class="card-filename" title={transfer.fileName}>{transfer.fileName}</span>
		<span class="card-status {transfer.status}">{statusLabel(transfer.status)}</span>
	</div>

	<div class="card-progress">
		<div class="progress-bar-bg">
			<div class="progress-bar-fill" style="width: {Math.min(100, Math.round(transfer.progress * 100))}%"></div>
		</div>
	</div>

	<div class="card-stats">
		<div class="stat-row">
			<span class="stat-label">Size</span>
			<span class="stat-value">{formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.fileSize)}</span>
		</div>
		<div class="stat-row">
			<span class="stat-label">Chunks</span>
			<span class="stat-value">{transfer.completedChunks} / {transfer.totalChunks}</span>
		</div>
		<div class="stat-row">
			<span class="stat-label">Progress</span>
			<span class="stat-value">{Math.round(transfer.progress * 100)}%</span>
		</div>
		{#if transfer.speedBytesPerSec != null && transfer.speedBytesPerSec > 0}
			<div class="stat-row">
				<span class="stat-label">Speed</span>
				<span class="stat-value">{formatSpeed(transfer.speedBytesPerSec)}</span>
			</div>
		{/if}
		{#if transfer.errorMessage}
			<div class="stat-row error-row">
				<span class="stat-label">Error</span>
				<span class="stat-value error-text">{transfer.errorMessage}</span>
			</div>
		{/if}
	</div>

	<div class="card-actions">
		{#if transfer.status === 'transferring' || transfer.status === 'connecting' || transfer.status === 'requesting' || transfer.status === 'resuming'}
			<button type="button" class="card-action-btn" on:click={() => dispatch('pause')} title="Pause transfer">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
				<span>Pause</span>
			</button>
		{/if}
		{#if transfer.status === 'paused'}
			<button type="button" class="card-action-btn" on:click={() => dispatch('resume')} title="Resume transfer">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
				<span>Resume</span>
			</button>
		{/if}
		{#if !['complete', 'cancelled'].includes(transfer.status)}
			<button type="button" class="card-action-btn danger" on:click={() => dispatch('cancel')} title="Cancel transfer">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
				<span>Cancel</span>
			</button>
		{/if}
		{#if transfer.status === 'failed' || transfer.status === 'cancelled'}
			<button type="button" class="card-action-btn" on:click={() => dispatch('restart')} title="Retry transfer">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
				<span>Retry</span>
			</button>
		{/if}
	</div>
</div>

<style>
	.transfer-card {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.7rem;
		border-radius: 10px;
		background: var(--surface-raised);
		border: 1px solid var(--border-subtle);
		transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.transfer-card:hover {
		transform: translateY(-1px);
		border-color: rgba(var(--accent-rgb, 99, 102, 241), 0.3);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.1));
	}

	@media (prefers-reduced-motion: reduce) {
		.transfer-card { transition: border-color 0.15s ease; }
		.transfer-card:hover { transform: none; }
	}

	.transfer-card.failed {
		border-color: rgba(var(--color-danger-rgb, 239, 68, 68), 0.3);
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.04);
	}

	.transfer-card.paused {
		border-color: rgba(var(--status-away-rgb, 255, 176, 32), 0.3);
		background: rgba(var(--status-away-rgb, 255, 176, 32), 0.04);
	}

	.transfer-card.complete {
		border-color: rgba(var(--status-online-rgb, 34, 197, 94), 0.2);
	}

	.card-header {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.card-direction {
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	.card-filename {
		flex: 1;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-heading);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-status {
		font-size: 0.65rem;
		font-weight: 600;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
		flex-shrink: 0;
		font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, monospace);
		letter-spacing: 0.03em;
	}

	.card-status.transferring, .card-status.resuming, .card-status.connecting {
		background: rgba(var(--accent-rgb), 0.12);
		color: var(--accent-primary-color);
	}

	.card-status.paused {
		background: rgba(var(--status-away-rgb, 255, 176, 32), 0.15);
		color: var(--status-away, #f59e0b);
	}

	.card-status.complete {
		background: rgba(var(--status-online-rgb, 34, 197, 94), 0.12);
		color: var(--status-online, #22c55e);
	}

	.card-status.failed {
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.12);
		color: var(--color-danger, #ef4444);
	}

	.card-status.cancelled {
		background: rgba(var(--text-secondary-rgb, 148, 163, 184), 0.12);
		color: var(--text-secondary);
	}

	.card-progress {
		padding: 0.1rem 0;
	}

	.progress-bar-bg {
		width: 100%;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-base);
		overflow: hidden;
	}

	.progress-bar-fill {
		height: 100%;
		border-radius: 3px;
		background: var(--accent-primary-color);
		transition: width 0.3s ease;
	}

	.transfer-card.failed .progress-bar-fill {
		background: var(--color-danger, #ef4444);
		opacity: 0.5;
	}

	.transfer-card.paused .progress-bar-fill {
		background: var(--status-away, #f59e0b);
	}

	.transfer-card.complete .progress-bar-fill {
		background: var(--status-online, #22c55e);
	}

	.card-stats {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.stat-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.68rem;
	}

	.stat-label {
		color: var(--text-secondary);
		font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, monospace);
		letter-spacing: 0.03em;
	}

	.stat-value {
		color: var(--text-heading);
		font-weight: 500;
	}

	.error-row {
		margin-top: 0.1rem;
	}

	.error-text {
		color: var(--color-danger, #ef4444);
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-actions {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
	}

	.card-action-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.45rem;
		border-radius: 5px;
		border: 1px solid var(--border-subtle);
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.68rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
	}

	.card-action-btn:hover {
		background: rgba(var(--accent-rgb), 0.08);
		color: var(--text-heading);
		border-color: rgba(var(--accent-rgb), 0.3);
	}

	.card-action-btn.danger:hover {
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.1);
		color: var(--color-danger, #ef4444);
		border-color: rgba(var(--color-danger-rgb, 239, 68, 68), 0.3);
	}

	.card-action-btn svg {
		flex-shrink: 0;
	}
</style>
