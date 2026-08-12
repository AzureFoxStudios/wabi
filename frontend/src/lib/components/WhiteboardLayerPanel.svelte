<script lang="ts">
	import { boardStore, layers, selection, activeLayerId } from '$lib/whiteboard/boardStore';
	import { sortWhiteboardLayers, WHITEBOARD_BLEND_MODES, blendModeLabel } from '$lib/whiteboard/layers';

	const kindLabels: Record<string, string> = {
		content: 'Content',
		reference: 'Reference',
		background: 'Background'
	};

	$: orderedLayers = sortWhiteboardLayers($layers);
	$: activeLayer = orderedLayers.find((layer) => layer.id === $activeLayerId) || orderedLayers[0] || null;
	$: selectedCount = $selection.size;

	function createLayer(mode: 'vector' | 'raster' = 'vector'): void {
		if (mode === 'raster') {
			const next = boardStore.addRasterLayer(`Paint ${orderedLayers.filter((layer) => layer.mode === 'raster').length + 1}`);
			boardStore.setActiveLayerId(next.id);
			return;
		}
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

	function setLayerBlendMode(id: string, mode: string): void {
		boardStore.updateLayer(id, { blendMode: mode });
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
		<div class="layer-add-actions">
			<button type="button" class="layer-add-btn" on:click={() => createLayer('vector')}>Vector</button>
			<button type="button" class="layer-add-btn raster" on:click={() => createLayer('raster')}>Raster</button>
		</div>
	</div>

	{#if activeLayer}
		<div class="active-layer-card">
			<div class="active-layer-topline">
				<span class="active-layer-chip">{activeLayer.mode === 'raster' ? 'Raster paint' : kindLabels[activeLayer.kind] || 'Vector'}</span>
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
			<div class="blend-row">
				<label for="active-layer-blend">Blend</label>
				<select
					id="active-layer-blend"
					value={activeLayer.blendMode || 'source-over'}
					on:change={(e) => setLayerBlendMode(activeLayer.id, (e.currentTarget as HTMLSelectElement).value)}
				>
					{#each WHITEBOARD_BLEND_MODES as mode}
						<option value={mode}>{blendModeLabel(mode)}</option>
					{/each}
				</select>
			</div>
		</div>
	{/if}

	<div class="layer-list">
		{#each orderedLayers as layer (layer.id)}
			<div class="layer-row" class:active={layer.id === $activeLayerId}>
				<div class="layer-row-main" role="button" tabindex="0" on:click={() => selectLayer(layer.id)} on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectLayer(layer.id)}>
					<span class="layer-row-handle" aria-hidden="true">⠿</span>
					<span class="layer-type-icon" class:raster={layer.mode === 'raster'} aria-hidden="true">
						{#if layer.mode === 'raster'}
							<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h14v12H3z"/><path d="M6 13l2-2 2 2 3-4 3 4"/></svg>
						{:else}
							<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m10 3 7 4-7 4-7-4 7-4Z"/><path d="m3 11 7 4 7-4"/></svg>
						{/if}
					</span>
					<input
						class="layer-name-input"
						value={layer.name}
						aria-label={`Rename ${layer.name}`}
						on:input={(e) => renameLayer(layer.id, (e.currentTarget as HTMLInputElement).value)}
					/>
				</div>
				<div class="layer-row-meta">
					<span class="layer-kind">{layer.mode === 'raster' ? 'Raster' : kindLabels[layer.kind] || 'Vector'}</span>
					<button type="button" class="layer-visibility" class:off={!layer.visible} on:click|stopPropagation={() => toggleLayerVisible(layer.id, !layer.visible)} aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} title={layer.visible ? 'Hide layer' : 'Show layer'}>
						{#if layer.visible}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 10s2.5-4 7.5-4 7.5 4 7.5 4-2.5 4-7.5 4-7.5-4-7.5-4Z"/><circle cx="10" cy="10" r="1.8"/></svg>{:else}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 4 12 12M8.3 5.2A8.6 8.6 0 0 1 10 5c5 0 7.5 5 7.5 5a12 12 0 0 1-2.1 2.6M5.4 7.1C3.5 8.2 2.5 10 2.5 10s2.5 4 7.5 4c.6 0 1.2-.1 1.7-.2"/></svg>{/if}
					</button>
					<button type="button" class="layer-lock" class:off={!layer.locked} on:click|stopPropagation={() => toggleLayerLocked(layer.id, !layer.locked)} aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`} title={layer.locked ? 'Unlock layer' : 'Lock layer'}>
						{#if layer.locked}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8" width="12" height="9" rx="1.5"/><path d="M6.5 8V6a3.5 3.5 0 0 1 7 0v2"/></svg>{:else}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8" width="12" height="9" rx="1.5"/><path d="M6.5 8V6a3.5 3.5 0 0 1 5.2-3.1"/></svg>{/if}
					</button>
				</div>
				<div class="layer-row-actions">
					<button type="button" on:click={() => moveLayer(layer.id, 'backward')} aria-label="Move layer down" title="Move down"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 4v12M5.5 11.5 10 16l4.5-4.5"/></svg></button>
					<button type="button" on:click={() => moveLayer(layer.id, 'forward')} aria-label="Move layer up" title="Move up"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 16V4M5.5 8.5 10 4l4.5 4.5"/></svg></button>
					<button type="button" class="assign-btn" on:click={() => assignSelection(layer.id)} disabled={selectedCount === 0} aria-label="Move selection here" title="Move selection here"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10h12M11 6l4 4-4 4"/></svg></button>
					<button type="button" class="delete-btn" on:click={() => deleteLayer(layer.id)} disabled={orderedLayers.length <= 1} aria-label="Delete layer" title="Delete layer"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5h12M8 5V3h4v2M6 5l.7 12h6.6L14 5M8.5 8v6M11.5 8v6"/></svg></button>
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
				<div class="layer-row-blend">
					<select
						class="layer-blend-select"
						value={layer.blendMode || 'source-over'}
						aria-label={`Blend mode for ${layer.name}`}
						on:change={(e) => setLayerBlendMode(layer.id, (e.currentTarget as HTMLSelectElement).value)}
					>
						{#each WHITEBOARD_BLEND_MODES as mode}
							<option value={mode}>{blendModeLabel(mode)}</option>
						{/each}
					</select>
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.layer-panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.7rem;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 18%, transparent);
		background: color-mix(in srgb, var(--surface-app, #1a1a2e) 82%, transparent);
		color: var(--text-inverse, #e2e8f0);
		box-shadow: 0 8px 24px rgba(var(--surface-app-rgb, 15, 23, 42), 0.18);
	}

	.layer-panel-header,
	.active-layer-topline,
	.opacity-row,
	.blend-row,
	.layer-row,
	.layer-row-meta,
	.layer-row-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.layer-panel-header {
		justify-content: space-between;
		padding-bottom: 0.55rem;
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
	}

	.layer-add-actions {
		display: inline-flex;
		gap: 0.35rem;
	}

	.layer-add-btn.raster {
		border-color: color-mix(in srgb, var(--color-info, #00bfff) 42%, transparent);
		color: var(--color-info, #00bfff);
	}

	.layer-panel-title {
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.layer-panel-subtitle {
		font-size: 0.66rem;
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

	.blend-row {
		justify-content: space-between;
		font-size: 0.74rem;
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 84%, transparent);
	}

	.blend-row select,
	.layer-blend-select {
		flex: 1;
		min-width: 0;
		padding: 0.28rem 0.45rem;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 20%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-app, #1a1a2e) 66%, transparent);
		color: var(--text-inverse, #f8fafc);
		font-size: 0.72rem;
		cursor: pointer;
	}

	.layer-row-blend {
		display: flex;
		align-items: center;
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
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.35rem 0.5rem;
		padding: 0.5rem;
		border-radius: 9px;
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
		font-size: 1rem;
		line-height: 1;
	}

	.layer-type-icon {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 5px;
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 80%, transparent);
	}

	.layer-type-icon.raster {
		background: color-mix(in srgb, var(--color-info, #00bfff) 18%, transparent);
		color: var(--color-info, #00bfff);
	}

	.layer-type-icon svg {
		width: 0.85rem;
		height: 0.85rem;
	}

	.layer-visibility,
	.layer-lock {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.55rem;
		height: 1.55rem;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-secondary, #b3b3ff);
		cursor: pointer;
	}

	.layer-visibility:hover,
	.layer-lock:hover {
		background: color-mix(in srgb, var(--text-inverse, #fff) 10%, transparent);
		color: var(--text-heading, #fff);
	}

	.layer-visibility.off,
	.layer-lock.off {
		opacity: 0.38;
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
		justify-content: flex-end;
		flex-wrap: nowrap;
		font-size: 0.7rem;
		color: color-mix(in srgb, var(--text-inverse, #e2e8f0) 80%, transparent);
	}

	.layer-row-actions {
		grid-column: 1 / -1;
		justify-content: flex-end;
		flex-wrap: nowrap;
		padding-top: 0.2rem;
		border-top: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 10%, transparent);
	}

	.layer-row-actions button {
		width: 1.7rem;
		height: 1.7rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.layer-row-actions svg,
	.layer-visibility svg,
	.layer-lock svg {
		width: 0.9rem;
		height: 0.9rem;
	}

	.layer-row-opacity,
	.layer-row-blend {
		display: none;
	}

	.assign-btn:disabled,
	.delete-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
