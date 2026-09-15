<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ModelView } from './modelInspector';
  type ViewMode = 'textured' | 'normal' | 'wireframe-lines';
  let {
    viewMode, hideUi, loadingViewer, hasStarted, fileName, error, fullBleed, height = 320,
    host = $bindable<HTMLDivElement>(), isFullscreen = false, inspectorOpen = false, settingsOpen = false,
    ready = false, fullscreenError = '', measurementLabel = '',
    onStartViewer, onViewModeChange, onToggleHideUi, onToggleFullscreen, onToggleInspector,
    onToggleSettings, onFitView, onViewPreset, onRetry, onStopPreview,
    canvasContent, settingsMenu, inspectorContent, notes
  }: {
    viewMode: ViewMode; hideUi: boolean; loadingViewer: boolean; hasStarted: boolean;
    fileName: string; error: string | null; fullBleed: boolean; height?: number; host?: HTMLDivElement;
    isFullscreen?: boolean; inspectorOpen?: boolean; settingsOpen?: boolean; ready?: boolean;
    fullscreenError?: string; measurementLabel?: string;
    onStartViewer: () => void; onViewModeChange: (mode: ViewMode) => void;
    onToggleHideUi: () => void; onToggleFullscreen?: () => void; onToggleInspector: () => void;
    onToggleSettings: () => void; onFitView: () => void; onViewPreset: (view: ModelView) => void;
    onRetry?: () => void; onStopPreview?: () => void;
    canvasContent: Snippet; settingsMenu?: Snippet; inspectorContent?: Snippet; notes?: Snippet;
  } = $props();
  const viewOptions: Array<[ViewMode, string]> = [['textured', 'Shaded'], ['normal', 'Normals'], ['wireframe-lines', 'Wireframe']];
</script>

<div class="model-viewer mv-shell" class:full-bleed={fullBleed} class:mv-focus={hideUi}
  style:--mv-height={`${Math.max(180, height)}px`} bind:this={host}>
  {#if !hideUi}
    <header class="mv-heading">
      <div class="mv-file-heading">
        <span class="mv-file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z M4 7.5l8 4.5 8-4.5 M12 12v9 M8 5.3l8 4.5" /></svg>
        </span>
        <div><p class="mv-eyebrow">Model workspace</p><h3 title={fileName}>{fileName}</h3></div>
      </div>
      <span class="mv-badge">Read-only</span>
    </header>
    {#if hasStarted && !error}
      <div class="mv-toolbar">
        <div class="mv-segment" role="group" aria-label="Model appearance">
          {#each viewOptions as [mode, label]}
            <button type="button" aria-pressed={viewMode === mode} disabled={!ready}
              onclick={() => onViewModeChange(mode)}>{label}</button>
          {/each}
        </div>
        <div class="mv-tool-group" role="group" aria-label="View controls">
          <button type="button" class="mv-button" disabled={!ready} onclick={onFitView} title="Frame selection or model (F)">Fit view</button>
          <button type="button" class="mv-button" disabled={!ready} aria-expanded={inspectorOpen} onclick={onToggleInspector}>Inspect</button>
          <button type="button" class="mv-button" disabled={!ready} aria-expanded={settingsOpen} onclick={onToggleSettings}>Display</button>
          <button type="button" class="mv-button" onclick={onToggleHideUi}>Focus</button>
          {#if onToggleFullscreen}
            <button type="button" class="mv-icon-button" onclick={onToggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                {#if isFullscreen}<path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" />
                {:else}<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />{/if}
              </svg>
            </button>
          {/if}
        </div>
      </div>
    {/if}
  {/if}

  <div class="mv-body" class:mv-with-panel={!hideUi && ready && (inspectorOpen || settingsOpen)}>
    <div class="mv-stage" aria-busy={loadingViewer}>
      {@render canvasContent()}
      {#if error}
        <div class="mv-state-card mv-state-error" role="alert">
          <span class="mv-state-symbol" aria-hidden="true">!</span>
          <h4>Preview unavailable</h4><p>{error}</p>
          <p class="mv-muted">The original file has not been changed.</p>
          {#if onRetry}<button type="button" class="mv-button mv-primary" onclick={onRetry}>Try again</button>{/if}
        </div>
      {:else if !hasStarted}
        <div class="mv-state-card">
          <p class="mv-eyebrow">3D preview</p><h4>Take a closer look.</h4>
          <p>Inspect geometry, isolate parts, and check mesh dimensions without changing the file.</p>
          <button type="button" class="mv-button mv-primary" onclick={onStartViewer}>Load preview</button>
          <span class="mv-muted">GLB · glTF · OBJ · STL</span>
        </div>
      {:else if loadingViewer}
        <div class="mv-state-card" role="status">
          <span class="mv-spinner" aria-hidden="true"></span><h4>Opening model…</h4>
          <p>Preparing geometry and materials.</p>
          {#if onStopPreview}<button type="button" class="mv-button" onclick={onStopPreview}>Stop preview</button>{/if}
        </div>
      {/if}
      {#if hideUi}
        <button type="button" class="mv-button mv-focus-return" onclick={onToggleHideUi}>Show controls</button>
      {/if}
      {#if ready && !hideUi}
        <div class="mv-view-presets" role="group" aria-label="Standard camera views">
          <button type="button" class="mv-button" onclick={() => onViewPreset('iso')} title="Perspective isometric view (0)">Iso</button>
          <button type="button" class="mv-button" onclick={() => onViewPreset('front')} title="Front view (1)">Front</button>
          <button type="button" class="mv-button" onclick={() => onViewPreset('right')} title="Right view (3)">Right</button>
          <button type="button" class="mv-button" onclick={() => onViewPreset('top')} title="Top view (7)">Top</button>
        </div>
      {/if}
      {#if measurementLabel && ready && !hideUi}<div class="mv-measure-overlay" role="status">{measurementLabel}</div>{/if}
    </div>
    {#if !hideUi && ready && inspectorOpen && inspectorContent}
      <aside class="mv-inspector" aria-label="Mesh inspector">{@render inspectorContent()}</aside>
    {:else if !hideUi && ready && settingsOpen && settingsMenu}
      <aside class="mv-inspector" aria-label="Display settings">{@render settingsMenu()}</aside>
    {/if}
  </div>
  {#if !hideUi}
    <footer class="mv-footer">
      <span class="mv-status"><span class="mv-status-dot" class:mv-status-ready={ready}></span>{error ? 'Not loaded' : loadingViewer ? 'Loading' : ready ? 'Mesh preview' : 'Ready to open'}</span>
      <span class="mv-navigation-hint">Drag to orbit · Scroll / pinch to zoom · Right-drag to pan</span>
      <span>Source unchanged</span>
    </footer>
    {#if fullscreenError}<p class="mv-feedback" role="status">{fullscreenError}</p>{/if}
    {#if notes}{@render notes()}{/if}
  {/if}
</div>
