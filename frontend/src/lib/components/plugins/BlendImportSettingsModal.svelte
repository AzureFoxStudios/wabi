<script context="module" lang="ts">
  export type BlendImportPreset = 'fast-preview' | 'balanced' | 'high-fidelity';
  export type BlendIncludeScope = 'visible-only' | 'selected-only' | 'full-scene';
  export type BlendAxisPreset = 'blender-default' | 'y-up';
  export type BlendOutputFormat = 'glb';

  export interface BlendImportSettingsPayload {
    sourcePath: string;
    fileName: string;
    preset: BlendImportPreset;
    applyModifiers: boolean;
    dracoCompression: boolean;
    embedTextures: boolean;
    includeScope: BlendIncludeScope;
    axisPreset: BlendAxisPreset;
    scale: number;
    outputFormat: BlendOutputFormat;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let isOpen = false;
  export let sourcePath = '';
  export let fileName = '';
  export let isSubmitting = false;

  let preset: BlendImportPreset = 'balanced';
  let applyModifiers = true;
  let dracoCompression = false;
  let embedTextures = true;
  let includeScope: BlendIncludeScope = 'visible-only';
  let axisPreset: BlendAxisPreset = 'blender-default';
  let scale = 1;
  let outputFormat: BlendOutputFormat = 'glb';

  const dispatch = createEventDispatcher<{
    close: void;
    submit: BlendImportSettingsPayload;
  }>();

  function applyPreset(next: BlendImportPreset): void {
    preset = next;
    if (next === 'fast-preview') {
      applyModifiers = true;
      dracoCompression = true;
      embedTextures = false;
      includeScope = 'visible-only';
      axisPreset = 'blender-default';
      scale = 1;
      return;
    }
    if (next === 'balanced') {
      applyModifiers = true;
      dracoCompression = false;
      embedTextures = true;
      includeScope = 'visible-only';
      axisPreset = 'blender-default';
      scale = 1;
      return;
    }
    applyModifiers = true;
    dracoCompression = false;
    embedTextures = true;
    includeScope = 'full-scene';
    axisPreset = 'blender-default';
    scale = 1;
  }

  function closeModal(): void {
    if (isSubmitting) return;
    dispatch('close');
  }

  function submit(): void {
    const payload: BlendImportSettingsPayload = {
      sourcePath,
      fileName,
      preset,
      applyModifiers,
      dracoCompression,
      embedTextures,
      includeScope,
      axisPreset,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      outputFormat
    };
    dispatch('submit', payload);
  }
</script>

{#if isOpen}
  <div class="overlay" on:click={closeModal} role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="blend-import-title" on:click|stopPropagation>
      <div class="header">
        <h3 id="blend-import-title">Blend Import Settings</h3>
        <button class="close-btn" on:click={closeModal} disabled={isSubmitting} aria-label="Close">x</button>
      </div>

      <p class="file-label">{fileName || 'blend file'}</p>

      <label class="field">
        <span>Preset</span>
        <select bind:value={preset} on:change={(e) => applyPreset((e.target as HTMLSelectElement).value as BlendImportPreset)}>
          <option value="fast-preview">Fast Preview</option>
          <option value="balanced">Balanced</option>
          <option value="high-fidelity">High Fidelity</option>
        </select>
      </label>

      <div class="checks">
        <label><input type="checkbox" bind:checked={applyModifiers} /> Apply Modifiers</label>
        <label><input type="checkbox" bind:checked={dracoCompression} /> Draco Compression</label>
        <label><input type="checkbox" bind:checked={embedTextures} /> Embed Textures</label>
      </div>

      <div class="grid">
        <label class="field">
          <span>Include</span>
          <select bind:value={includeScope}>
            <option value="visible-only">Visible Only</option>
            <option value="selected-only">Selected Only</option>
            <option value="full-scene">Full Scene</option>
          </select>
        </label>
        <label class="field">
          <span>Axis</span>
          <select bind:value={axisPreset}>
            <option value="blender-default">Blender Default</option>
            <option value="y-up">Y Up</option>
          </select>
        </label>
      </div>

      <div class="grid">
        <label class="field">
          <span>Scale</span>
          <input type="number" min="0.001" step="0.001" bind:value={scale} />
        </label>
        <label class="field">
          <span>Output</span>
          <select bind:value={outputFormat}>
            <option value="glb">GLB</option>
          </select>
        </label>
      </div>

      <div class="actions">
        <button class="secondary" on:click={closeModal} disabled={isSubmitting}>Cancel</button>
        <button class="primary" on:click={submit} disabled={isSubmitting}>
          {isSubmitting ? 'Queueing...' : 'Queue Conversion'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1300;
    padding: 1rem;
  }

  .modal {
    width: min(520px, 100%);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.9rem;
    color: var(--text-primary);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .header h3 {
    margin: 0;
    font-size: 1rem;
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 1rem;
    cursor: pointer;
  }

  .file-label {
    margin: 0 0 0.6rem;
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.6rem;
    font-size: 0.82rem;
  }

  .field select,
  .field input {
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.42rem 0.5rem;
    font-size: 0.85rem;
  }

  .checks {
    display: grid;
    gap: 0.35rem;
    margin-bottom: 0.6rem;
    font-size: 0.83rem;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .actions {
    margin-top: 0.7rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .actions button {
    border: none;
    border-radius: 6px;
    padding: 0.45rem 0.7rem;
    cursor: pointer;
  }

  .secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .primary {
    background: var(--accent);
    color: #fff;
  }
</style>
