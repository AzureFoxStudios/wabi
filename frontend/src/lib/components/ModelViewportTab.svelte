<script lang="ts">
	import { onMount } from 'svelte';
	import ModelViewer3D from './plugins/ModelViewer3D.svelte';
	import { clearModelViewport, modelViewportSelection } from '$lib/modelViewportTab';

	let host: HTMLDivElement | null = null;
	let viewerHeight = 420;

	function recalcHeight(): void {
		if (!host) return;
		const next = Math.max(280, host.clientHeight);
		viewerHeight = next;
	}

	onMount(() => {
		const observer = new ResizeObserver(() => recalcHeight());
		if (host) observer.observe(host);
		recalcHeight();
		return () => observer.disconnect();
	});
</script>

<div class="viewport-tab" bind:this={host}>
	{#if $modelViewportSelection}
		<div class="viewport-canvas-wrap">
			<ModelViewer3D src={$modelViewportSelection.src} fileName={$modelViewportSelection.fileName} height={viewerHeight} fullBleed={true} />
		</div>
		<div class="viewport-overlay">
			<span class="viewport-name" title={$modelViewportSelection.fileName}>{$modelViewportSelection.fileName}</span>
			<button class="clear-btn" on:click={clearModelViewport}>Clear</button>
		</div>
	{:else}
		<div class="viewport-empty">No model selected yet.</div>
	{/if}
</div>

<style>
	.viewport-tab {
		height: 100%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg-primary);
		position: relative;
		overflow: hidden;
	}

	.clear-btn {
		border: 1px solid var(--border);
		background: rgba(15, 20, 30, 0.88);
		color: #e6edf5;
		border-radius: 7px;
		padding: 0.3rem 0.55rem;
		cursor: pointer;
	}

	.viewport-canvas-wrap {
		flex: 1;
		min-height: 0;
	}

	.viewport-overlay {
		position: absolute;
		top: 0.55rem;
		left: 0.55rem;
		right: 0.55rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.55rem;
		pointer-events: none;
	}

	.viewport-name {
		max-width: min(65vw, 560px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.78rem;
		color: #e6edf5;
		background: rgba(15, 20, 30, 0.88);
		border: 1px solid rgba(92, 106, 126, 0.7);
		border-radius: 7px;
		padding: 0.28rem 0.5rem;
	}

	.viewport-overlay .clear-btn {
		pointer-events: auto;
	}

	.viewport-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px dashed var(--border);
		border-radius: 8px;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}
</style>
