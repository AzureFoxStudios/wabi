<script lang="ts">
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

<div class="mv-panel-title"><h4>Display</h4><span class="mv-muted">Viewer only</span></div>
<section class="mv-panel-section">
  <h5>Scene guides</h5>
  <div class="mv-toggle-list">
    <button type="button" aria-pressed={showGrid} onclick={onToggleGrid}><span>Ground grid</span><span>{showGrid ? 'On' : 'Off'}</span></button>
    <button type="button" aria-pressed={showAxes} onclick={onToggleAxes}><span>World axes</span><span>{showAxes ? 'On' : 'Off'}</span></button>
    <button type="button" aria-pressed={showRig} onclick={onToggleRig}><span>Bones / controllers</span><span>{showRig ? 'On' : 'Off'}</span></button>
    <button type="button" aria-pressed={autoRotate} onclick={onToggleAutoRotate}><span>Auto-rotate</span><span>{autoRotate ? 'On' : 'Off'}</span></button>
  </div>
  <button type="button" class="mv-button mv-reset" onclick={onResetView}>Reset camera</button>
</section>
{#if animationClipOptions.length > 0}
  <section class="mv-panel-section">
    <h5>Animation</h5>
    <label class="mv-field">Clip<select bind:value={selectedAnimationIndex} onchange={onAnimationClipChange}>{#each animationClipOptions as clip}<option value={clip.index}>{clip.name}</option>{/each}</select></label>
    <div class="mv-inline-actions"><button type="button" class="mv-button" aria-pressed={animationPlaying} onclick={onToggleAnimationPlayback}>{animationPlaying ? 'Pause animation' : 'Play animation'}</button></div>
    <label class="mv-field">Loop<select bind:value={animationLoopMode} onchange={onAnimationLoopModeChange}><option value="repeat">Repeat</option><option value="once">Once</option><option value="pingpong">Ping-pong</option></select></label>
    <label class="mv-range-label">Speed <span>{animationSpeed.toFixed(1)}×</span><input type="range" min="0.1" max="2.5" step="0.1" value={animationSpeed} oninput={onAnimationSpeedChange} /></label>
    <p class="mv-note">Measuring or selecting a mesh pauses playback so the inspected pose stays still.</p>
  </section>
{:else}
  <section class="mv-panel-section"><h5>Animation</h5><p class="mv-note">No animation clips were found in this model.</p></section>
{/if}
<section class="mv-panel-section">
  <h5>Diagnostics</h5>
  <div class="mv-toggle-list"><button type="button" aria-pressed={showDebugStats} onclick={onToggleDebugStats}><span>Model statistics</span><span>{showDebugStats ? 'On' : 'Off'}</span></button></div>
  <label class="mv-field">Parsing preference<select bind:value={threadMode} onchange={onThreadModeChange}><option value="auto">Automatic</option><option value="always">Prefer worker</option><option value="off">Main thread</option></select></label>
  <p class="mv-note">Applies on the next load. Formats without worker support fall back to the main thread.</p>
</section>
