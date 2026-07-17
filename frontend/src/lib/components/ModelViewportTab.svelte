<script lang="ts">
	import { onMount } from 'svelte';
	import ModelViewerLauncher from './ModelViewerLauncher.svelte';
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
	let viewerUiHidden = false;

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

	function handleToolbarAction(event: Event): void {
		const target = event.target as HTMLSelectElement;
		const selected = target.value;
		if (!selected) return;

		if (selected === '__load_temp__') {
			openTempPicker();
		} else if (selected === '__clear__') {
			clearModelViewport();
		} else if (selected.startsWith('model:')) {
			openModelViewportHistoryEntry(selected.slice('model:'.length));
		}

		target.value = '';
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
	{#if !viewerUiHidden}
		<div class="viewport-toolbar">
			<select class="model-select toolbar-select" on:change={handleToolbarAction} title="Model actions">
				<option value="">Model viewer actions</option>
				<option value="__load_temp__">Open temp model...</option>
				{#if $modelViewportSelection}
					<option value="__clear__">Clear current model</option>
				{/if}
				{#if $modelViewportHistory.length > 0}
					<optgroup label="Recent models">
						{#each $modelViewportHistory as model}
							<option value={`model:${model.id}`}>
								{model.fileName}{model.source === 'local-temp' ? ' (temp)' : ''}
							</option>
						{/each}
					</optgroup>
				{/if}
			</select>
			<button class="toolbar-close-btn" type="button" aria-label="Hide model controls" on:click={() => (viewerUiHidden = true)}>×</button>
		</div>
	{/if}

	{#if $modelViewportSelection}
		<div class="viewport-canvas-wrap">
			<ModelViewerLauncher bind:hideUi={viewerUiHidden} src={$modelViewportSelection.src} fileName={$modelViewportSelection.fileName} height={viewerHeight} fullBleed={true} lazyLoad={false} />
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
		background: var(--surface-app);
		position: relative;
		overflow: hidden;
	}

	.viewport-canvas-wrap {
		flex: 1;
		min-height: 0;
	}

	.viewport-toolbar {
		position: absolute;
		top: 0.55rem;
		left: 0.55rem;
		right: 0.55rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		z-index: 8;
		pointer-events: none;
	}

	.toolbar-select {
		flex: 1;
		min-width: 0;
	}

	.toolbar-close-btn {
		width: 1.8rem;
		height: 1.8rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgba(92, 106, 126, 0.8);
		background: rgba(15, 20, 30, 0.9);
		color: var(--text-inverse, #e6edf5);
		border-radius: 7px;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		pointer-events: auto;
	}

	.model-select,
	.picker-btn {
		border: 1px solid rgba(92, 106, 126, 0.8);
		background: rgba(15, 20, 30, 0.9);
		color: var(--text-inverse, #e6edf5);
		border-radius: 7px;
		padding: 0.3rem 0.55rem;
		font-size: 0.75rem;
		pointer-events: auto;
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
		border: 1px dashed var(--border-subtle);
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
		.viewport-toolbar {
			top: 0.5rem;
			left: 0.5rem;
			right: 0.5rem;
		}
	}
</style>
