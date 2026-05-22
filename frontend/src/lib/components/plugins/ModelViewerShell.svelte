<script lang="ts">
	type ViewMode = 'textured' | 'normal' | 'wireframe-lines';

	export let viewMode: ViewMode;
	export let hideUi: boolean;
	export let loadingViewer: boolean;
	export let hasStarted: boolean;
	export let fileName: string;
	export let error: string | null;
	export let fullBleed: boolean;
	export let onStartViewer: () => void;
	export let onViewModeChange: (mode: ViewMode) => void;
	export let onToggleHideUi: () => void;
</script>

<div class="model-viewer" class:full-bleed={fullBleed}>
	{#if error}
		<div class="model-error">{error}</div>
	{:else}
		<slot name="canvas" />
		{#if !hasStarted}
			<button
				type="button"
				class="activation-overlay"
				on:click={onStartViewer}
			>
				<span class="activation-title">Click to load 3D preview</span>
				<span class="activation-subtitle">{fileName}</span>
			</button>
		{/if}
		{#if loadingViewer}
			<div class="loading-overlay">Loading 3D preview...</div>
		{/if}

		{#if hasStarted && !hideUi}
			<div class="overlay-controls overlay-left" role="group" on:click|stopPropagation on:keydown|stopPropagation>
				<button type="button" class="view-btn" class:active={viewMode === 'textured'} on:click={() => onViewModeChange('textured')}>Textured</button>
				<button type="button" class="view-btn" class:active={viewMode === 'normal'} on:click={() => onViewModeChange('normal')}>Normal</button>
				<button type="button" class="view-btn" class:active={viewMode === 'wireframe-lines'} on:click={() => onViewModeChange('wireframe-lines')}>Wireframe Lines</button>
			</div>

			<div class="overlay-controls overlay-right" role="group" on:click|stopPropagation on:keydown|stopPropagation>
				<button type="button" class="settings-fab" on:click={onToggleHideUi}>Hide UI</button>
				<slot name="settings-menu" />
			</div>
		{/if}
		{#if hasStarted && hideUi}
			<div class="overlay-controls overlay-right minimal-toggle" role="group" on:click|stopPropagation on:keydown|stopPropagation>
				<button type="button" class="settings-fab" on:click={onToggleHideUi}>Show UI</button>
			</div>
		{/if}

		{#if !hideUi}
			<div class="viewer-hint">Drag to rotate, wheel to zoom, right-drag to pan</div>
		{/if}
		<slot name="notes" />
	{/if}
</div>
