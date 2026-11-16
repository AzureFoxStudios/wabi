<script lang="ts">
	import { _ } from '$lib/i18n';
  import type { AnimationLoopMode, ThreadMode } from './modelViewerHelpers';
  let {
    autoRotate = false, showGrid = true, showAxes = false, showRig = true, showDebugStats = false,
    animationClipOptions = [], selectedAnimationIndex = $bindable(0), animationPlaying = true,
    animationSpeed = 1, animationLoopMode = $bindable<AnimationLoopMode>('repeat'), threadMode = $bindable<ThreadMode>('auto'),
    onToggleAutoRotate, onResetView, onToggleGrid, onToggleAxes, onToggleRig, onToggleDebugStats,
    onAnimationClipChange, onToggleAnimationPlayback, onAnimationLoopModeChange, onAnimationSpeedChange, onThreadModeChange
  }: {
    autoRotate?: boolean; showGrid?: boolean; showAxes?: boolean; showRig?: boolean; showDebugStats?: boolean;
    animationClipOptions?: Array<{ index: number; name: string; duration: number }>;
    selectedAnimationIndex?: number; animationPlaying?: boolean; animationSpeed?: number;
    animationLoopMode?: AnimationLoopMode; threadMode?: ThreadMode;
    onToggleAutoRotate: () => void; onResetView: () => void; onToggleGrid: () => void; onToggleAxes: () => void;
    onToggleRig: () => void; onToggleDebugStats: () => void; onAnimationClipChange: (event: Event) => void;
    onToggleAnimationPlayback: () => void; onAnimationLoopModeChange: (event: Event) => void;
    onAnimationSpeedChange: (event: Event) => void; onThreadModeChange: (event: Event) => void;
  } = $props();
</script>

<div class="mv-panel-title"><h4>{$_('mv.display')}</h4><span class="mv-muted">{$_('mv.viewer_only')}</span></div>
<section class="mv-panel-section">
  <h5>{$_('mv.scene_guides')}</h5>
  <div class="mv-toggle-list">
    <button type="button" aria-pressed={showGrid} onclick={onToggleGrid}><span>{$_('mv.ground_grid')}</span><span>{showGrid ? $_('audio_settings.on') : $_('audio_settings.off')}</span></button>
    <button type="button" aria-pressed={showAxes} onclick={onToggleAxes}><span>{$_('mv.world_axes')}</span><span>{showAxes ? $_('audio_settings.on') : $_('audio_settings.off')}</span></button>
    <button type="button" aria-pressed={showRig} onclick={onToggleRig}><span>{$_('mv.bones')}</span><span>{showRig ? $_('audio_settings.on') : $_('audio_settings.off')}</span></button>
    <button type="button" aria-pressed={autoRotate} onclick={onToggleAutoRotate}><span>{$_('mv.auto_rotate')}</span><span>{autoRotate ? $_('audio_settings.on') : $_('audio_settings.off')}</span></button>
  </div>
  <button type="button" class="mv-button mv-reset" onclick={onResetView}>{$_('mv.reset_camera')}</button>
</section>
{#if animationClipOptions.length > 0}
  <section class="mv-panel-section">
    <h5>{$_('mv.animation')}</h5>
    <label class="mv-field">{$_('mv.clip')}<select bind:value={selectedAnimationIndex} onchange={onAnimationClipChange}>{#each animationClipOptions as clip}<option value={clip.index}>{clip.name}</option>{/each}</select></label>
    <div class="mv-inline-actions"><button type="button" class="mv-button" aria-pressed={animationPlaying} onclick={onToggleAnimationPlayback}>{animationPlaying ? $_('mv.pause') : $_('mv.play')}</button></div>
    <label class="mv-field">{$_('mv.loop')}<select bind:value={animationLoopMode} onchange={onAnimationLoopModeChange}><option value="repeat">{$_('mv.repeat')}</option><option value="once">{$_('mv.once')}</option><option value="pingpong">{$_('mv.pingpong')}</option></select></label>
    <label class="mv-range-label">{$_('mv.speed')} <span>{animationSpeed.toFixed(1)}×</span><input type="range" min="0.1" max="2.5" step="0.1" value={animationSpeed} oninput={onAnimationSpeedChange} /></label>
    <p class="mv-note">{$_('mv.note_measure')}</p>
  </section>
{:else}
  <section class="mv-panel-section"><h5>{$_('mv.animation')}</h5><p class="mv-note">{$_('mv.no_clips')}</p></section>
{/if}
<section class="mv-panel-section">
  <h5>{$_('mv.diagnostics')}</h5>
  <div class="mv-toggle-list"><button type="button" aria-pressed={showDebugStats} onclick={onToggleDebugStats}><span>{$_('mv.model_stats')}</span><span>{showDebugStats ? $_('audio_settings.on') : $_('audio_settings.off')}</span></button></div>
  <label class="mv-field">{$_('mv.parsing')}<select bind:value={threadMode} onchange={onThreadModeChange}><option value="auto">{$_('audio_settings.automatic')}</option><option value="always">{$_('mv.prefer_worker')}</option><option value="off">{$_('mv.main_thread')}</option></select></label>
  <p class="mv-note">{$_('mv.threads_note')}</p>
</section>
