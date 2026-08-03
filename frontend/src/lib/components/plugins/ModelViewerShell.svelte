<script lang="ts">
	type ViewMode = 'textured' | 'normal' | 'wireframe-lines';

	export let viewMode: ViewMode;
	export let hideUi: boolean;
	export let loadingViewer: boolean;
	export let hasStarted: boolean;
	export let fileName: string;
	export let error: string | null;
	export let fullBleed: boolean;
	export let host: HTMLDivElement | null = null;
	export let onStartViewer: () => void;
	export let onViewModeChange: (mode: ViewMode) => void;
	export let onToggleHideUi: () => void;
	export let onToggleFullscreen: (() => void) | null = null;
	export let isFullscreen = false;
</script>

<div class="model-viewer" class:full-bleed={fullBleed} bind:this={host}>
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
				{#if onToggleFullscreen}
					<button type="button" class="view-btn" class:active={isFullscreen} on:click={onToggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
						{#if isFullscreen}
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8V5h2M5 5l7 7M19 8V5h-2M19 5l-7 7M5 16v3h2M5 19l7-7m7 7v-3h-2m0 0l-7 7"></path></svg>
						{:else}
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3c-1.5 0-2.9.6-4 1.6S3 7 3 8.5V14c0 2.8 2.2 5 5 5h3v-2H8c-2.2 0-4-1.8-4-4V8.5c0-1.9 1.6-3.5 3.5-3.5H11V6H8zM16 11h7v1h-3v7h-1v-3h-2v3H12v-7H9v-1h3V8h1v3h3z"></path></svg>
						{/if}
					</button>
				{/if}
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
