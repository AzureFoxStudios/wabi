<script lang="ts">
	import { onMount } from 'svelte';
	import ModelViewerLauncher from './ModelViewerLauncher.svelte';
	import {
		clearModelViewport,
		modelViewportHistory,
		modelViewportSelection,
		openModelViewport,
		openModelViewportHistoryEntry,
		openTemporaryModelViewport
	} from '$lib/modelViewportTab';

	let host: HTMLDivElement | null = null;
	let viewerHeight = 420;
	let localFileInput: HTMLInputElement | null = null;
	let viewerUiHidden = false;
	let showUrlRow = false;
	let modelUrl = '';

	const SAMPLE_MODEL_URL =
		'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb';
	const SAMPLE_MODEL_NAME = 'DamagedHelmet (sample).glb';

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

	function fileNameFromUrl(raw: string): string {
		try {
			const last = new URL(raw).pathname.split('/').filter(Boolean).pop();
			if (last) return decodeURIComponent(last);
		} catch {
			// Not an absolute URL — fall through to the plain-path parse below.
		}
		const last = raw.split('?')[0].split('#')[0].split('/').filter(Boolean).pop();
		return last || 'Remote model';
	}

	function loadFromUrl(raw: string, fallbackName?: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		openModelViewport(trimmed, fallbackName || fileNameFromUrl(trimmed));
		modelUrl = '';
		showUrlRow = false;
	}

	function handleExitViewer(): void {
		clearModelViewport();
	}
</script>

<div class="viewport-tab" bind:this={host}>
	{#if $modelViewportSelection && !viewerUiHidden}
		<div class="viewport-toolbar toolbar-loaded">
			<span class="loaded-file" title={$modelViewportSelection.fileName}>
				<span aria-hidden="true">📦</span>
				<span class="loaded-file-name">{$modelViewportSelection.fileName}</span>
			</span>
			<div class="toolbar-actions">
				{#if $modelViewportHistory.length > 0}
					<select
						class="model-select toolbar-select"
						aria-label="Recent models"
						on:change={handlePickRecent}
					>
						<option value="">Recent models</option>
						{#each $modelViewportHistory as model}
							<option value={model.id}>
								{model.fileName}{model.source === 'local-temp' ? ' (temp)' : ''}
							</option>
						{/each}
					</select>
				{/if}
				<button
					class="toolbar-pill"
					type="button"
					title="Unload the current model"
					on:click={() => clearModelViewport()}
				>
					<span aria-hidden="true">🗑</span> Clear model
				</button>
				<button
					class="toolbar-pill toolbar-close-btn"
					type="button"
					aria-label="Hide model controls"
					title="Hide the viewer controls (use Show UI in the viewer to bring them back)"
					on:click={() => (viewerUiHidden = true)}
				>
					<span aria-hidden="true">👁</span> Hide controls
				</button>
				<button
					class="toolbar-pill pill-exit"
					type="button"
					title="Close the viewer and go back"
					on:click={handleExitViewer}
				>
					<span aria-hidden="true">✕</span> Close viewer
				</button>
			</div>
		</div>
	{/if}

	{#if $modelViewportSelection}
		<div class="viewport-canvas-wrap">
			<ModelViewerLauncher bind:hideUi={viewerUiHidden} src={$modelViewportSelection.src} fileName={$modelViewportSelection.fileName} height={viewerHeight} fullBleed={true} lazyLoad={false} />
		</div>
	{:else}
		<div class="viewport-empty">
			<div class="empty-card">
				<div class="empty-icon" aria-hidden="true">📦</div>
				<p class="empty-title">No model selected yet</p>
				<p class="empty-hint">Load a GLB/GLTF/OBJ/STL to preview it here. Models stay on this device.</p>
				<div class="empty-action-list">
					<button class="empty-action primary" type="button" on:click={openTempPicker}>
						<span class="action-icon" aria-hidden="true">📂</span>
						<span class="action-text">
							<strong>Open model from your computer</strong>
							<small>GLB, GLTF, OBJ or STL — stays on this device</small>
						</span>
					</button>
					<button
						class="empty-action"
						type="button"
						aria-expanded={showUrlRow}
						on:click={() => (showUrlRow = !showUrlRow)}
					>
						<span class="action-icon" aria-hidden="true">🔗</span>
						<span class="action-text">
							<strong>Load from URL / sample</strong>
							<small>Paste a direct model link, or try the bundled sample</small>
						</span>
						<span class="action-chevron" aria-hidden="true">{showUrlRow ? '▾' : '▸'}</span>
					</button>
					{#if showUrlRow}
						<div class="url-row">
							<input
								class="url-input"
								type="url"
								placeholder="https://example.com/model.glb"
								aria-label="Model URL"
								bind:value={modelUrl}
								on:keydown={(event) => event.key === 'Enter' && loadFromUrl(modelUrl)}
							/>
							<button
								class="toolbar-pill pill-load"
								type="button"
								disabled={!modelUrl.trim()}
								on:click={() => loadFromUrl(modelUrl)}
							>
								Load URL
							</button>
							<button
								class="toolbar-pill"
								type="button"
								on:click={() => loadFromUrl(SAMPLE_MODEL_URL, SAMPLE_MODEL_NAME)}
							>
								Try sample
							</button>
						</div>
					{/if}
					{#if $modelViewportHistory.length > 0}
						<div class="recent-block">
							<p class="recent-title">Recent models</p>
							<ul class="recent-list">
								{#each $modelViewportHistory as model}
									<li>
										<button
											class="recent-item"
											type="button"
											title={model.src}
											on:click={() => openModelViewportHistoryEntry(model.id)}
										>
											<span aria-hidden="true">{model.source === 'local-temp' ? '🗂' : '🔗'}</span>
											<span class="recent-name">{model.fileName}</span>
											{#if model.source === 'local-temp'}
												<span class="recent-badge">temp</span>
											{/if}
										</button>
									</li>
								{/each}
							</ul>
						</div>
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
		display: flex;
		flex-direction: column;
		position: relative;
	}

	/* The three.js canvas (rendered by plugins/ModelViewer3D via ModelViewerShell)
	   must fill the wrap with no letterboxing. The renderer sizes its backing
	   store from the host box, so the canvas element itself needs full size too. */
	.viewport-canvas-wrap :global(.model-viewer.full-bleed) {
		flex: 1;
		min-height: 0;
		height: auto;
		display: flex;
		flex-direction: column;
	}

	.viewport-canvas-wrap :global(canvas) {
		width: 100% !important;
		height: 100% !important;
		flex: 1;
		min-height: 0;
		display: block;
	}

	/* In-flow header bar (NOT an overlay): it sits above the canvas so it can
	   never cover the three.js overlay controls (view buttons top-left,
	   settings top-right, "Drag to rotate…" hint bottom-left). */
	.viewport-toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		background: var(--surface-base);
		border-bottom: 1px solid var(--border-subtle);
		z-index: 8;
		flex-wrap: wrap;
	}

	.loaded-file {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-heading);
		background: var(--surface-raised);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0.28rem 0.7rem;
		max-width: min(52vw, 320px);
	}

	.loaded-file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: auto;
		flex-wrap: wrap;
	}

	.toolbar-select {
		min-width: 0;
	}

	.toolbar-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--border-subtle);
		background: var(--surface-raised);
		color: var(--text-heading);
		border-radius: 999px;
		padding: 0.32rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease;
	}

	.toolbar-pill:hover {
		background: var(--surface-hover);
		border-color: var(--border-focus);
	}

	.toolbar-pill:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.toolbar-pill:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.toolbar-pill:disabled:hover {
		background: var(--surface-raised);
		border-color: var(--border-subtle);
	}

	.pill-exit {
		background: var(--accent-danger-soft);
		border-color: var(--border-subtle);
		color: var(--text-heading);
	}

	.pill-exit:hover {
		background: var(--accent-danger-soft);
		border-color: var(--text-danger);
	}

	.pill-load {
		background: var(--accent-primary-color);
		border-color: transparent;
		color: #fff;
	}

	.pill-load:hover {
		background: var(--accent-secondary-color);
		border-color: transparent;
	}

	.pill-load:disabled:hover {
		background: var(--accent-primary-color);
		border-color: transparent;
	}

	.model-select {
		border: 1px solid var(--border-subtle);
		background: var(--surface-raised);
		color: var(--text-heading);
		border-radius: 999px;
		padding: 0.32rem 0.6rem;
		font-size: 0.75rem;
		max-width: min(46vw, 240px);
		cursor: pointer;
	}

	.model-select:hover {
		background: var(--surface-hover);
		border-color: var(--border-focus);
	}

	.viewport-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px dashed var(--border-subtle);
		border-radius: var(--radius-md);
		color: var(--text-secondary);
		font-size: var(--font-size-sm);
		padding: 1rem;
		overflow-y: auto;
	}

	.empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		text-align: center;
		max-width: 34rem;
		width: min(100%, 30rem);
		background: var(--surface-raised);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		padding: 1.75rem 1.5rem;
	}

	.empty-icon {
		font-size: 2rem;
		line-height: 1;
	}

	.empty-card p {
		margin: 0;
	}

	.empty-title {
		font-size: 1.05rem;
		font-weight: 700;
		color: var(--text-heading);
	}

	.empty-hint {
		font-size: var(--font-size-sm);
		color: var(--text-muted);
		line-height: 1.45;
	}

	.empty-action-list {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		width: 100%;
		margin-top: 0.6rem;
	}

	.empty-action {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		text-align: left;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
		border-radius: var(--radius-md);
		padding: 0.7rem 0.85rem;
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease;
	}

	.empty-action:hover {
		background: var(--surface-hover);
		border-color: var(--border-focus);
	}

	.empty-action:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.empty-action.primary {
		background: var(--accent-primary-color);
		border-color: transparent;
		color: #fff;
	}

	.empty-action.primary:hover {
		background: var(--accent-secondary-color);
		border-color: transparent;
	}

	.empty-action.primary .action-text small {
		color: inherit;
		opacity: 0.85;
	}

	.action-icon {
		font-size: 1.35rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.action-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.action-text strong {
		font-size: 0.85rem;
		font-weight: 700;
	}

	.action-text small {
		font-size: 0.72rem;
		color: var(--text-muted);
		line-height: 1.4;
	}

	.action-chevron {
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.url-row {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.url-input {
		flex: 1;
		min-width: 12rem;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
		border-radius: 999px;
		padding: 0.32rem 0.75rem;
		font-size: 0.78rem;
	}

	.url-input::placeholder {
		color: var(--text-placeholder);
	}

	.url-input:focus {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.recent-block {
		border-top: 1px solid var(--border-subtle);
		padding-top: 0.6rem;
		text-align: left;
	}

	.recent-title {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 0 0 0.4rem;
	}

	.recent-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		max-height: 9rem;
		overflow-y: auto;
	}

	.recent-item {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		width: 100%;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
		border-radius: 7px;
		padding: 0.35rem 0.6rem;
		font-size: 0.78rem;
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease;
	}

	.recent-item:hover {
		background: var(--surface-hover);
		border-color: var(--border-focus);
	}

	.recent-item:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.recent-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}

	.recent-badge {
		flex-shrink: 0;
		font-size: 0.65rem;
		font-weight: 700;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0.05rem 0.45rem;
	}

	.hidden-input {
		display: none;
	}

	@media (max-width: 768px) {
		.toolbar-actions {
			margin-left: 0;
		}

		.loaded-file {
			max-width: 100%;
		}

		.empty-card {
			padding: 1.25rem 1rem;
		}
	}
</style>
