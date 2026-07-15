<script lang="ts">
	import { boardStore, layers, selection, activeLayerId } from '$lib/whiteboard/boardStore';
	import { sortWhiteboardLayers } from '$lib/whiteboard/layers';

	const kindLabels: Record<string, string> = {
		content: 'Content',
		reference: 'Reference',
		background: 'Background'
	};

	$: orderedLayers = sortWhiteboardLayers($layers);
	$: activeLayer = orderedLayers.find((layer) => layer.id === $activeLayerId) || orderedLayers[0] || null;
	$: selectedCount = $selection.size;

	function createLayer(): void {
		const next = boardStore.addLayer({
			name: `Layer ${orderedLayers.length + 1}`,
			kind: 'content',
			visible: true,
			locked: false,
			opacity: 1,
			order: orderedLayers.length
		});
		boardStore.setActiveLayerId(next.id);
	}

	function selectLayer(id: string): void {
		boardStore.setActiveLayerId(id);
	}

	function renameLayer(id: string, value: string): void {
		boardStore.renameLayer(id, value);
	}

	function toggleLayerVisible(id: string, visible: boolean): void {
		boardStore.setLayerVisible(id, visible);
	}

	function toggleLayerLocked(id: string, locked: boolean): void {
		boardStore.setLayerLocked(id, locked);
	}

	function setLayerOpacity(id: string, value: number): void {
		boardStore.setLayerOpacity(id, value);
	}

	function moveLayer(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
		boardStore.reorderLayer(id, dir);
	}

	function deleteLayer(id: string): void {
		boardStore.deleteLayer(id);
	}

	function assignSelection(id: string): void {
		boardStore.assignSelectionToLayer(id);
	}
</script>

<div class="layer-panel" aria-label="Whiteboard layers">
	<div class="layer-panel-header">
		<div>
			<div class="layer-panel-title">Layers</div>
			<div class="layer-panel-subtitle">{orderedLayers.length} layers{#if selectedCount > 0} | {selectedCount} selected{/if}</div>
		</div>
		<button type="button" class="layer-add-btn" on:click={createLayer}>New</button>
	</div>

	{#if activeLayer}
		<div class="active-layer-card">
			<div class="active-layer-topline">
				<span class="active-layer-chip">{kindLabels[activeLayer.kind] || 'Layer'}</span>
				<label class="active-layer-switch">
					<input type="checkbox" checked={activeLayer.visible} on:change={(e) => toggleLayerVisible(activeLayer.id, (e.currentTarget as HTMLInputElement).checked)} />
					Show
				</label>
				<label class="active-layer-switch">
					<input type="checkbox" checked={activeLayer.locked} on:change={(e) => toggleLayerLocked(activeLayer.id, (e.currentTarget as HTMLInputElement).checked)} />
					Lock
				</label>
			</div>
			<div class="opacity-row">
				<label for="active-layer-opacity">Opacity</label>
				<input
					id="active-layer-opacity"
					type="range"
					min="0"
					max="1"
					step="0.01"
					value={activeLayer.opacity}
					on:input={(e) => setLayerOpacity(activeLayer.id, Number((e.currentTarget as HTMLInputElement).value))}
				/>
				<span>{Math.round(activeLayer.opacity * 100)}%</span>
			</div>
		</div>
	{/if}

	<div class="layer-list">
		{#each orderedLayers as layer (layer.id)}
			<div class="layer-row" class:active={layer.id === $activeLayerId}>
				<div class="layer-row-main" role="button" tabindex="0" on:click={() => selectLayer(layer.id)} on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectLayer(layer.id)}>
					<span class="layer-row-handle" aria-hidden="true">⋮⋮</span>
					<input
						class="layer-name-input"
						value={layer.name}
						aria-label={`Rename ${layer.name}`}
						on:input={(e) => renameLayer(layer.id, (e.currentTarget as HTMLInputElement).value)}
					/>
				</div>
				<div class="layer-row-meta">
					<span class="layer-kind">{kindLabels[layer.kind] || layer.kind}</span>
					<label class="mini-toggle">
						<input type="checkbox" checked={layer.visible} on:change={(e) => toggleLayerVisible(layer.id, (e.currentTarget as HTMLInputElement).checked)} />
						Visible
					</label>
					<label class="mini-toggle">
						<input type="checkbox" checked={layer.locked} on:change={(e) => toggleLayerLocked(layer.id, (e.currentTarget as HTMLInputElement).checked)} />
						Locked
					</label>
				</div>
				<div class="layer-row-actions">
					<button type="button" on:click={() => moveLayer(layer.id, 'backward')} title="Move backward">↑</button>
					<button type="button" on:click={() => moveLayer(layer.id, 'forward')} title="Move forward">↓</button>
					<button type="button" on:click={() => moveLayer(layer.id, 'back')} title="Send to back">⇤</button>
					<button type="button" on:click={() => moveLayer(layer.id, 'front')} title="Bring to front">⇥</button>
					<button type="button" class="assign-btn" on:click={() => assignSelection(layer.id)} disabled={selectedCount === 0} title="Move selection to this layer">Assign</button>
					<button type="button" class="delete-btn" on:click={() => deleteLayer(layer.id)} disabled={orderedLayers.length <= 1} title="Delete layer">✕</button>
				</div>
				<div class="layer-row-opacity">
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						value={layer.opacity}
						on:input={(e) => setLayerOpacity(layer.id, Number((e.currentTarget as HTMLInputElement).value))}
					/>
					<span>{Math.round(layer.opacity * 100)}%</span>
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.layer-panel {
		display: grid;
		gap: 0.65rem;
		padding: 0.85rem;
		border-radius: 18px;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 18%, transparent);
		background: color-mix(in srgb, var(--surface-app, #1a1a2e) 82%, transparent);
		color: var(--text-inverse, #e2e8f0);
		backdrop-filter: blur(12px);
		box-shadow: 0 18px 42px rgba(var(--surface-app-rgb, 15, 23, 42), 0.18);
	}

	.layer-panel-header,
	.active-layer-topline,
	.opacity-row,
	.layer-row,
	.layer-row-meta,
	.layer-row-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.layer-panel-header {
		justify-content: space-between;
	}

	.layer-panel-title {
		font-size: 0.82rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.layer-panel-subtitle {
		font-size: 0.7rem;
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 70%, transparent);
	}

	.layer-add-btn,
	.layer-row-actions button {
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 20%, transparent);
		border-radius: 10px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 92%, transparent);
		color: var(--text-inverse, #f8fafc);
		font-size: 0.74rem;
		padding: 0.32rem 0.55rem;
		cursor: pointer;
	}

	.layer-add-btn:hover,
	.layer-row-actions button:hover {
		background: color-mix(in srgb, var(--surface-raised, #302b63) 96%, transparent);
	}

	.active-layer-card,
	.layer-row {
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		border-radius: 14px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 72%, transparent);
	}

	.active-layer-card {
		display: grid;
		gap: 0.5rem;
		padding: 0.7rem;
	}

	.active-layer-chip,
	.layer-kind {
		display: inline-flex;
		align-items: center;
		padding: 0.18rem 0.45rem;
		border-radius: 999px;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		background: color-mix(in srgb, var(--color-info, #00bfff) 18%, transparent);
		color: var(--color-info, #00bfff);
	}

	.active-layer-switch,
	.mini-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.72rem;
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 86%, transparent);
	}

	.opacity-row,
	.layer-row-opacity {
		justify-content: space-between;
		font-size: 0.74rem;
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 84%, transparent);
	}

	.opacity-row input,
	.layer-row-opacity input {
		flex: 1;
		min-width: 0;
	}

	.layer-list {
		display: grid;
		gap: 0.55rem;
		max-height: 34vh;
		overflow: auto;
		padding-right: 0.15rem;
	}

	.layer-row {
		display: grid;
		gap: 0.4rem;
		padding: 0.65rem;
	}

	.layer-row.active {
		border-color: color-mix(in srgb, var(--color-info, #00bfff) 44%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-info, #00bfff) 18%, transparent);
	}

	.layer-row-main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.layer-row-handle {
		color: color-mix(in srgb, var(--text-muted, #9999ff) 72%, transparent);
	}

	.layer-name-input {
		flex: 1;
		min-width: 0;
		padding: 0.3rem 0.45rem;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 16%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-app, #1a1a2e) 66%, transparent);
		color: var(--text-inverse, #f8fafc);
		font-size: 0.78rem;
	}

	.layer-row-meta {
		flex-wrap: wrap;
		font-size: 0.7rem;
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 80%, transparent);
	}

	.layer-row-actions {
		flex-wrap: wrap;
	}

	.assign-btn:disabled,
	.delete-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
