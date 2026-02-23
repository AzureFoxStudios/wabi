<script lang="ts">
	import { onMount } from 'svelte';
	import ModelViewer3D from './plugins/ModelViewer3D.svelte';
	import {
		clearModelViewport,
		modelViewportHistory,
		modelViewportSelection,
		openModelViewportHistoryEntry,
		openTemporaryModelViewport
	} from '$lib/modelViewportTab';

	let host: HTMLDivElement | null = null;
	let viewerHeight = 420;
	let localFileInput: HTMLInputElement | null = null;

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

	function handlePickRecent(event: Event): void {
		const target = event.target as HTMLSelectElement;
		const entryId = target.value || '';
		if (!entryId) return;
		openModelViewportHistoryEntry(entryId);
	}

	function openTempPicker(): void {
		localFileInput?.click();
	}

	function handleLocalModelSelect(event: Event): void {
		const target = event.target as HTMLInputElement;
		const selected = target.files?.[0];
		if (!selected) return;
		openTemporaryModelViewport(selected);
		target.value = '';
	}
</script>

<div class="viewport-tab" bind:this={host}>
	{#if $modelViewportSelection}
		<div class="viewport-canvas-wrap">
			<ModelViewer3D src={$modelViewportSelection.src} fileName={$modelViewportSelection.fileName} height={viewerHeight} fullBleed={true} lazyLoad={false} />
		</div>
		<div class="viewport-model-picker">
			<select class="model-select" value={$modelViewportSelection.id} on:change={handlePickRecent} title="Recent models">
				{#each $modelViewportHistory as model}
					<option value={model.id}>
						{model.fileName}{model.source === 'local-temp' ? ' (temp)' : ''}
					</option>
				{/each}
			</select>
			<button class="picker-btn" on:click={openTempPicker}>Open Temp Model</button>
			<button class="picker-btn" on:click={clearModelViewport}>Clear</button>
		</div>
	{:else}
		<div class="viewport-empty">
			<div class="empty-actions">
				<p>No model selected yet.</p>
				<div class="empty-action-row">
					<button class="picker-btn" on:click={openTempPicker}>Open Temp Model</button>
					{#if $modelViewportHistory.length > 0}
						<select class="model-select" on:change={handlePickRecent}>
							<option value="">Recent models</option>
							{#each $modelViewportHistory as model}
								<option value={model.id}>
									{model.fileName}{model.source === 'local-temp' ? ' (temp)' : ''}
								</option>
							{/each}
						</select>
					{/if}
				</div>
			</div>
		</div>
	{/if}
	<input
		bind:this={localFileInput}
		class="hidden-input"
		type="file"
		accept=".glb,.gltf,.obj,.stl"
		on:change={handleLocalModelSelect}
	/>
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

	.viewport-canvas-wrap {
		flex: 1;
		min-height: 0;
	}

	.viewport-model-picker {
		position: absolute;
		top: 3rem;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		z-index: 5;
	}

	.model-select,
	.picker-btn {
		border: 1px solid rgba(92, 106, 126, 0.8);
		background: rgba(15, 20, 30, 0.9);
		color: #e6edf5;
		border-radius: 7px;
		padding: 0.3rem 0.55rem;
		font-size: 0.75rem;
	}

	.model-select {
		min-width: min(45vw, 360px);
		max-width: min(58vw, 460px);
	}

	.picker-btn {
		cursor: pointer;
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

	.empty-actions {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		align-items: center;
	}

	.empty-actions p {
		margin: 0;
	}

	.empty-action-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.hidden-input {
		display: none;
	}

	@media (max-width: 768px) {
		.viewport-model-picker {
			top: auto;
			bottom: 2.5rem;
			left: 0.55rem;
			right: 0.55rem;
			transform: none;
			justify-content: flex-start;
			flex-wrap: wrap;
		}

		.model-select {
			min-width: 0;
			max-width: none;
			flex: 1;
		}
	}
</style>
