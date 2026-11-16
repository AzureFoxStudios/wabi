<script lang="ts">
	import { _ } from '$lib/i18n';
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
  const viewOptions: Array<[ViewMode, string]> = [['textured', $_('model_viewer.shaded')], ['normal', $_('model_viewer.normals')], ['wireframe-lines', $_('model_viewer.wireframe')]];
</script>

<div class="model-viewer mv-shell" class:full-bleed={fullBleed} class:mv-focus={hideUi}
  style:--mv-height={`${Math.max(180, height)}px`} bind:this={host}>
  {#if !hideUi}
    <header class="mv-heading">
      <div class="mv-file-heading">
        <span class="mv-file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z M4 7.5l8 4.5 8-4.5 M12 12v9 M8 5.3l8 4.5" /></svg>
        </span>
        <div><p class="mv-eyebrow">{$_('model_viewer.model_workspace_eyebrow')}</p><h3 title={fileName}>{fileName}</h3></div>
      </div>
      <span class="mv-badge">{$_('model_viewer.read_only')}</span>
    </header>
    {#if hasStarted && !error}
      <div class="mv-toolbar">
        <div class="mv-segment" role="group" aria-label={$_('model_viewer.appearance_label')}>
          {#each viewOptions as [mode, label]}
            <button type="button" aria-pressed={viewMode === mode} disabled={!ready}
              onclick={() => onViewModeChange(mode)}>{label}</button>
          {/each}
        </div>
        <div class="mv-tool-group" role="group" aria-label={$_('model_viewer.view_controls')}>
          <button type="button" class="mv-button" disabled={!ready} onclick={onFitView} title={$_('model_viewer.frame_title')}>{$_('model_viewer.fit_view')}</button>
          <button type="button" class="mv-button" disabled={!ready} aria-expanded={inspectorOpen} onclick={onToggleInspector}>{$_('model_viewer.inspect')}</button>
          <button type="button" class="mv-button" disabled={!ready} aria-expanded={settingsOpen} onclick={onToggleSettings}>{$_('model_viewer.display')}</button>
          <button type="button" class="mv-button" onclick={onToggleHideUi}>{$_('model_viewer.focus')}</button>
          {#if onToggleFullscreen}
            <button type="button" class="mv-icon-button" onclick={onToggleFullscreen}
              aria-label={isFullscreen ? $_('model_viewer.exit_fullscreen') : $_('model_viewer.enter_fullscreen')} title={isFullscreen ? $_('model_viewer.exit_fullscreen') : $_('model_viewer.fullscreen')}>
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
          <h4>{$_('model_viewer.preview_unavailable')}</h4><p>{error}</p>
          <p class="mv-muted">{$_('model_viewer.unchanged')}</p>
          {#if onRetry}<button type="button" class="mv-button mv-primary" onclick={onRetry}>{$_('model_viewer.try_again')}</button>{/if}
        </div>
      {:else if !hasStarted}
        <div class="mv-state-card">
          <p class="mv-eyebrow">3D preview</p><h4>{$_('model_viewer.closer_look')}</h4>
          <p>{$_('model_viewer.inspect_desc')}</p>
          <button type="button" class="mv-button mv-primary" onclick={onStartViewer}>{$_('model_viewer.load_preview')}</button>
          <span class="mv-muted">GLB · glTF · OBJ · STL</span>
        </div>
      {:else if loadingViewer}
        <div class="mv-state-card" role="status">
          <span class="mv-spinner" aria-hidden="true"></span><h4>{$_('model_viewer.opening')}</h4>
          <p>{$_('model_viewer.preparing')}</p>
          {#if onStopPreview}<button type="button" class="mv-button" onclick={onStopPreview}>{$_('model_viewer.stop_preview')}</button>{/if}
        </div>
      {/if}
      {#if hideUi}
        <button type="button" class="mv-button mv-focus-return" onclick={onToggleHideUi}>{$_('model_viewer.show_controls')}</button>
      {/if}
      {#if ready && !hideUi}
        <div class="mv-view-presets" role="group" aria-label={$_('model_viewer.camera_views')}>
          <button type="button" class="mv-button" onclick={() => onViewPreset('iso')} title={$_('model_viewer.iso_title')}>{$_('model_viewer.iso')}</button>
          <button type="button" class="mv-button" onclick={() => onViewPreset('front')} title={$_('model_viewer.front_title')}>{$_('model_viewer.front')}</button>
          <button type="button" class="mv-button" onclick={() => onViewPreset('right')} title={$_('model_viewer.right_title')}>{$_('model_viewer.right')}</button>
          <button type="button" class="mv-button" onclick={() => onViewPreset('top')} title={$_('model_viewer.top_title')}>{$_('model_viewer.top')}</button>
        </div>
      {/if}
      {#if measurementLabel && ready && !hideUi}<div class="mv-measure-overlay" role="status">{measurementLabel}</div>{/if}
    </div>
    {#if !hideUi && ready && inspectorOpen && inspectorContent}
      <aside class="mv-inspector" aria-label={$_('model_viewer.mesh_inspector')}>{@render inspectorContent()}</aside>
    {:else if !hideUi && ready && settingsOpen && settingsMenu}
      <aside class="mv-inspector" aria-label={$_('model_viewer.display_settings')}>{@render settingsMenu()}</aside>
    {/if}
  </div>
  {#if !hideUi}
    <footer class="mv-footer">
      <span class="mv-status"><span class="mv-status-dot" class:mv-status-ready={ready}></span>{error ? $_('model_viewer.not_loaded') : loadingViewer ? $_('model_viewer.loading') : ready ? $_('model_viewer.mesh_preview') : $_('model_viewer.ready_open')}</span>
      <span class="mv-navigation-hint">{$_('model_viewer.nav_hint')}</span>
      <span>{$_('model_viewer.source_unchanged')}</span>
    </footer>
    {#if fullscreenError}<p class="mv-feedback" role="status">{fullscreenError}</p>{/if}
    {#if notes}{@render notes()}{/if}
  {/if}
</div>
