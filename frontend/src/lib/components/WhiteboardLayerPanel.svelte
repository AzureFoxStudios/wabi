<script lang="ts">
	import { boardStore, layers, selection, activeLayerId } from '$lib/whiteboard/boardStore';
	import { sortWhiteboardLayers, WHITEBOARD_BLEND_MODES, blendModeLabel } from '$lib/whiteboard/layers';

	$: stackLayers = [...sortWhiteboardLayers($layers)].reverse();
	$: activeLayer = stackLayers.find((layer) => layer.id === $activeLayerId) || stackLayers[0] || null;
	$: selectedCount = $selection.size;
	let draggedLayerId = '';
	let renamingLayerId = '';
	let renameValue = '';

	function startRename(layer: { id: string; name: string }) {
		renamingLayerId = layer.id;
		renameValue = layer.name;
		queueMicrotask(() => {
			const el = document.getElementById(`layer-name-${layer.id}`) as HTMLInputElement | null;
			el?.select();
		});
	}

	function commitRename(layerId: string) {
		const value = renameValue.trim() || 'Layer';
		boardStore.renameLayer(layerId, value);
		renamingLayerId = '';
	}

	function cancelRename() {
		renamingLayerId = '';
	}

	function createLayer(mode: 'vector' | 'raster' = 'vector'): void {
		if (mode === 'raster') {
			const next = boardStore.addRasterLayer(`Paint ${stackLayers.filter((layer) => layer.mode === 'raster').length + 1}`);
			boardStore.setActiveLayerId(next.id);
			return;
		}
		const next = boardStore.addLayer({
			name: `Layer ${stackLayers.length + 1}`,
			kind: 'content',
			visible: true,
			locked: false,
			opacity: 1,
			order: stackLayers.length
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

	function moveLayerVisually(id: string, visualDir: 'up' | 'down'): void {
		boardStore.reorderLayer(id, visualDir === 'up' ? 'forward' : 'backward');
	}

	function deleteLayer(id: string): void {
		boardStore.deleteLayer(id);
	}

	function assignSelection(id: string): void {
		boardStore.assignSelectionToLayer(id);
	}

	function dropLayer(targetId: string): void {
		if (!draggedLayerId || draggedLayerId === targetId) return;
		const sorted = sortWhiteboardLayers($layers);
		const from = sorted.findIndex((layer) => layer.id === draggedLayerId);
		const to = sorted.findIndex((layer) => layer.id === targetId);
		if (from < 0 || to < 0) return;
		boardStore.moveLayerToIndex(draggedLayerId, to);
		draggedLayerId = '';
	}
</script>

<div class="layer-panel" aria-label="Whiteboard layers">
	<header class="layer-panel-header">
		<div>
			<div class="layer-panel-title">Layers</div>
			<div class="layer-panel-subtitle">{stackLayers.length} · front on top</div>
		</div>
		<div class="layer-add-actions" role="group" aria-label="Add layer">
			<button type="button" class="layer-add-seg" on:click={() => createLayer('vector')}>+ Vector</button>
			<button type="button" class="layer-add-seg raster" on:click={() => createLayer('raster')}>+ Paint</button>
		</div>
	</header>

	<div class="layer-list" role="list">
		{#each stackLayers as layer (layer.id)}
			<div
				class="layer-row"
				class:active={layer.id === $activeLayerId}
				role="listitem"
				draggable="true"
				on:dragstart={() => (draggedLayerId = layer.id)}
				on:dragover|preventDefault
				on:drop|preventDefault={() => dropLayer(layer.id)}
			>
				<button type="button" class="layer-select" on:click={() => selectLayer(layer.id)} aria-label={`Select ${layer.name}`}>
					<span class="layer-row-handle" aria-hidden="true">⠿</span>
					<span class="layer-type-icon" class:raster={layer.mode === 'raster'} aria-hidden="true">
						{#if layer.mode === 'raster'}
							<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h14v12H3z"/><path d="M6 13l2-2 2 2 3-4 3 4"/></svg>
						{:else}
							<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m10 3 7 4-7 4-7-4 7-4Z"/><path d="m3 11 7 4 7-4"/></svg>
						{/if}
					</span>
				</button>
				{#if renamingLayerId === layer.id}
					<input
						id="layer-name-{layer.id}"
						class="layer-name-input"
						value={renameValue}
						on:input={(e) => (renameValue = (e.currentTarget as HTMLInputElement).value)}
						on:blur={() => commitRename(layer.id)}
						on:keydown={(e) => {
							if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
							if (e.key === 'Escape') cancelRename();
						}}
					/>
				{:else}
					<button type="button" class="layer-name-btn" on:dblclick={() => startRename(layer)}>
						{layer.name}
					</button>
				{/if}
				<button type="button" class="layer-icon-btn" class:off={!layer.visible} on:click={() => toggleLayerVisible(layer.id, !layer.visible)} aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} title={layer.visible ? 'Hide' : 'Show'}>
					{#if layer.visible}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 10s2.5-4 7.5-4 7.5 4 7.5 4-2.5 4-7.5 4-7.5-4-7.5-4Z"/><circle cx="10" cy="10" r="1.8"/></svg>{:else}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 4 12 12M8.3 5.2A8.6 8.6 0 0 1 10 5c5 0 7.5 5 7.5 5a12 12 0 0 1-2.1 2.6M5.4 7.1C3.5 8.2 2.5 10 2.5 10s2.5 4 7.5 4c.6 0 1.2-.1 1.7-.2"/></svg>{/if}
				</button>
				<button type="button" class="layer-icon-btn" class:off={!layer.locked} on:click={() => toggleLayerLocked(layer.id, !layer.locked)} aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`} title={layer.locked ? 'Unlock' : 'Lock'}>
					{#if layer.locked}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8" width="12" height="9" rx="1.5"/><path d="M6.5 8V6a3.5 3.5 0 0 1 7 0v2"/></svg>{:else}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="8" width="12" height="9" rx="1.5"/><path d="M6.5 8V6a3.5 3.5 0 0 1 5.2-3.1"/></svg>{/if}
				</button>
			</div>
		{/each}
	</div>

	{#if activeLayer}
		<section class="layer-inspector" aria-label="Selected layer">
			<div class="inspector-topline">
				<span class="inspector-name">{activeLayer.name}</span>
				<span class="inspector-kind">{activeLayer.mode === 'raster' ? 'Paint' : 'Vector'}</span>
			</div>
			<label class="inspector-row">
				<span>Opacity</span>
				<input type="range" min="0" max="1" step="0.01" value={activeLayer.opacity} on:input={(e) => setLayerOpacity(activeLayer.id, Number((e.currentTarget as HTMLInputElement).value))} />
				<span class="tabular">{Math.round(activeLayer.opacity * 100)}</span>
			</label>
			<label class="inspector-row">
				<span>Blend</span>
				<select value={activeLayer.blendMode || 'source-over'} on:change={(e) => setLayerBlendMode(activeLayer.id, (e.currentTarget as HTMLSelectElement).value)}>
					{#each WHITEBOARD_BLEND_MODES as mode}
						<option value={mode}>{blendModeLabel(mode)}</option>
					{/each}
				</select>
			</label>
			<div class="inspector-actions">
				<button type="button" on:click={() => moveLayerVisually(activeLayer.id, 'up')} title="Bring forward">↑</button>
				<button type="button" on:click={() => moveLayerVisually(activeLayer.id, 'down')} title="Send backward">↓</button>
				<button type="button" on:click={() => assignSelection(activeLayer.id)} disabled={selectedCount === 0} title="Move selection here">Move sel</button>
				<button type="button" class="danger" on:click={() => deleteLayer(activeLayer.id)} disabled={stackLayers.length <= 1} title="Delete layer">Delete</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.layer-panel {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		min-height: 0;
		padding: 0.7rem;
		color: var(--text-heading, #f4f4fb);
	}

	.layer-panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.layer-panel-title {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.layer-panel-subtitle {
		margin-top: 0.15rem;
		font-size: 0.68rem;
		color: color-mix(in srgb, var(--text-heading, #fff) 62%, transparent);
	}

	.layer-add-actions {
		display: inline-flex;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--text-heading, #fff) 14%, transparent);
	}

	.layer-add-seg {
		border: 0;
		border-radius: 0;
		background: color-mix(in srgb, var(--surface-raised, #302b63) 70%, transparent);
		color: inherit;
		font-size: 0.7rem;
		padding: 0.28rem 0.5rem;
		cursor: pointer;
		transition: box-shadow 0.12s, color 0.12s, background 0.12s;
	}

	.layer-add-seg + .layer-add-seg {
		border-left: 1px solid color-mix(in srgb, var(--text-heading, #fff) 14%, transparent);
	}

	.layer-add-seg:hover {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary, #6366f1) 60%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 14%, transparent);
		color: var(--accent-primary, #6366f1);
	}

	.layer-add-seg.raster {
		color: var(--color-info, #7dd3fc);
	}

	.layer-add-seg.raster:hover {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-info, #7dd3fc) 60%, transparent);
		background: color-mix(in srgb, var(--color-info, #7dd3fc) 14%, transparent);
		color: var(--color-info, #7dd3fc);
	}

	@media (prefers-reduced-motion: reduce) {
		.layer-add-seg {
			transition: none;
		}
	}

	.inspector-actions button {
		border: 1px solid color-mix(in srgb, var(--text-heading, #fff) 14%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-raised, #302b63) 70%, transparent);
		color: inherit;
		font-size: 0.7rem;
		padding: 0.28rem 0.5rem;
		cursor: pointer;
	}

	.layer-list {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
		min-height: 0;
		overflow: auto;
	}

	.layer-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) 1.7rem 1.7rem;
		align-items: center;
		gap: 0.2rem;
		min-height: 2.1rem;
		padding: 0.15rem 0.25rem;
		border-radius: 8px;
		border: 1px solid transparent;
	}

	.layer-row.active {
		background: color-mix(in srgb, var(--accent-primary, #818cf8) 16%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary, #818cf8) 34%, transparent);
	}

	.layer-select {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: grab;
	}

	.layer-row-handle {
		opacity: 0.45;
	}

	.layer-type-icon {
		display: inline-flex;
		width: 1.15rem;
		height: 1.15rem;
		align-items: center;
		justify-content: center;
		color: color-mix(in srgb, var(--text-heading, #fff) 82%, transparent);
	}

	.layer-type-icon.raster {
		color: var(--color-info, #7dd3fc);
	}

	.layer-type-icon svg,
	.layer-icon-btn svg {
		width: 0.9rem;
		height: 0.9rem;
	}

	.layer-name-input {
		min-width: 0;
		width: 100%;
		border: 0;
		background: transparent;
		color: inherit;
		font-size: 0.78rem;
		padding: 0.2rem 0.15rem;
	}

	.layer-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.7rem;
		height: 1.7rem;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: color-mix(in srgb, var(--text-heading, #fff) 88%, transparent);
		cursor: pointer;
	}

	.layer-icon-btn.off {
		opacity: 0.35;
	}

	.layer-inspector {
		display: grid;
		gap: 0.45rem;
		padding-top: 0.55rem;
		border-top: 1px solid color-mix(in srgb, var(--text-heading, #fff) 10%, transparent);
	}

	.inspector-topline,
	.inspector-row,
	.inspector-actions {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.inspector-name {
		font-size: 0.78rem;
		font-weight: 600;
	}

	.inspector-kind {
		font-size: 0.62rem;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--text-heading, #fff) 58%, transparent);
	}

	.inspector-row span:first-child {
		width: 3.4rem;
		font-size: 0.68rem;
		color: color-mix(in srgb, var(--text-heading, #fff) 68%, transparent);
	}

	.inspector-row input,
	.inspector-row select {
		flex: 1;
		min-width: 0;
	}

	.inspector-row input[type='range'] {
		-webkit-appearance: none;
		appearance: none;
		height: 4px;
		border: 0;
		padding: 0;
		border-radius: var(--radius-sm, 4px);
		background: color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		outline: none;
		cursor: pointer;
	}

	.inspector-row input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--accent-primary, #6366f1);
		cursor: pointer;
		transition: transform 0.12s;
	}

	.inspector-row input[type='range']::-webkit-slider-thumb:hover {
		transform: scale(1.25);
	}

	.inspector-row input[type='range']::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: none;
		border-radius: 50%;
		background: var(--accent-primary, #6366f1);
		cursor: pointer;
		transition: transform 0.12s;
	}

	.inspector-row input[type='range']::-moz-range-thumb:hover {
		transform: scale(1.25);
	}

	.inspector-row input[type='range']:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.inspector-row input[type='range']::-webkit-slider-thumb,
		.inspector-row input[type='range']::-moz-range-thumb {
			transition: none;
		}
	}

	.tabular {
		width: 1.8rem;
		font-variant-numeric: tabular-nums;
		font-size: 0.68rem;
		text-align: right;
	}

	.inspector-actions .danger {
		margin-left: auto;
		color: #fda4af;
	}

	.inspector-actions button:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
