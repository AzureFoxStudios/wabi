<script lang="ts">
	import { syncProgress } from '$lib/socket';
	import { onDestroy } from 'svelte';

	$: progress = $syncProgress;
	$: barWidth = progress ? (progress.loaded / Math.max(progress.total, 1)) * 100 : 0;

	// Only appear after 300ms — fast loads never show anything
	let visible = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	$: {
		if (progress && !visible) {
			timer = setTimeout(() => { visible = true; }, 300);
		} else if (!progress) {
			visible = false;
			if (timer) { clearTimeout(timer); timer = null; }
		}
	}

	onDestroy(() => { if (timer) clearTimeout(timer); });
</script>

{#if progress && visible}
	<div class="sync-bar-top">
		<div class="sync-fill" style="width: {barWidth}%"></div>
	</div>
	<div class="sync-label">
		<span class="sync-channel">#{progress.current}</span>
		<span class="sync-count">{progress.loaded}/{progress.total}</span>
	</div>
{/if}

<style>
	.sync-bar-top {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		background: rgba(var(--accent-primary-rgb, 99, 102, 241), 0.15);
		z-index: 9999;
	}

	.sync-fill {
		height: 100%;
		background: linear-gradient(90deg, var(--color-info, var(--color-info, #6366f1)), var(--accent-primary, #8b5cf6), var(--accent-primary, var(--accent-primary, #a855f7)));
		transition: width 0.3s ease;
		box-shadow: 0 0 6px var(--color-info, var(--color-info, #6366f1));
	}

	.sync-label {
		position: fixed;
		top: 8px;
		right: 16px;
		font-size: 11px;
		font-family: 'Courier New', monospace;
		color: var(--accent-primary, #8b5cf6);
		background: rgba(15, 15, 26, 0.85);
		padding: 2px 8px;
		border-radius: 4px;
		display: flex;
		gap: 8px;
		z-index: 9999;
	}

	.sync-count {
		color: var(--text-muted, #64748b);
	}
</style>
