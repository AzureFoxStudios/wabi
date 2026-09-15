<script lang="ts">
  import { formatLength, isModelUnit, type InspectorSnapshot, type ModelUnit, type ModelView, type SectionAxis } from '../modelInspector';
  import type { ModelInspectorRuntime } from '../modelInspectorRuntime';
  let { snapshot, runtime, fileName, sourceUnit = $bindable<ModelUnit>('model'), displayUnit = $bindable<ModelUnit>('model') }: { snapshot: InspectorSnapshot; runtime: ModelInspectorRuntime; fileName: string; sourceUnit?: ModelUnit; displayUnit?: ModelUnit } = $props();
  let query = $state('');
  const units: ModelUnit[] = ['mm', 'cm', 'm', 'in'];
  const matching = $derived(snapshot.meshes.filter((mesh) => mesh.name.toLowerCase().includes(query.trim().toLowerCase())));
  const displayed = $derived(matching.slice(0, 100));
  const triangleCount = $derived(snapshot.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0));
  const selected = $derived(snapshot.meshes.find((mesh) => mesh.id === snapshot.selectedId));
  const length = (value: number | null) => formatLength(value, sourceUnit, displayUnit);
  function changeSource(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!isModelUnit(value)) return;
    sourceUnit = value;
    if (value === 'model' || displayUnit === 'model') displayUnit = value;
  }
  function section(axis = snapshot.sectionAxis, percent = snapshot.sectionPercent, flipped = snapshot.sectionFlipped): void {
    runtime.setSection(axis, percent, flipped);
  }
</script>

<div class="mv-panel-title"><h4>Inspect model</h4><span class="mv-muted">Mesh tools</span></div>
<p class="mv-panel-summary">{snapshot.meshes.length.toLocaleString('en-US')} meshes · ~{triangleCount.toLocaleString('en-US')} triangles</p>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>Dimensions</h5><button type="button" class="mv-text-button" onclick={() => runtime.refresh()}>Refresh pose</button></div>
  <p class="mv-muted mv-truncate" title={selected?.name || 'Whole model'}>{selected?.name || 'Whole model'} · bounding box</p>
  <div class="mv-dimensions">
    {#each ['x', 'y', 'z'] as axis}
      <div><span>{axis.toUpperCase()}</span><strong>{length(snapshot.dimensions?.[axis as 'x' | 'y' | 'z'] ?? null)}</strong></div>
    {/each}
  </div>
  <div class="mv-field-grid">
    <label>Source units<select value={sourceUnit} onchange={changeSource}><option value="model">Unspecified</option>{#each units as unit}<option value={unit}>{unit}</option>{/each}</select></label>
    <label>Display units<select bind:value={displayUnit} disabled={sourceUnit === 'model'}>{#if sourceUnit === 'model'}<option value="model">Model units</option>{:else}{#each units as unit}<option value={unit}>{unit}</option>{/each}{/if}</select></label>
  </div>
  <p class="mv-note">{sourceUnit === 'model' ? 'Source scale is unspecified. Set it only when you know the file’s units.' : 'Source units are your assumption; changing this field does not rescale the model.'} Dimensions and measurements describe the display mesh, not CAD tolerances.</p>
</section>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>Measure</h5><span class="mv-small-badge">Approximate</span></div>
  <div class="mv-inline-actions">
    <button type="button" class="mv-button" aria-pressed={snapshot.measuring} onclick={() => runtime.setMeasuring(!snapshot.measuring)}>{snapshot.measuring ? 'Stop measuring' : 'Pick two points'}</button>
    <button type="button" class="mv-button" disabled={snapshot.measurePoints === 0} onclick={() => runtime.clearMeasurement()}>Clear</button>
  </div>
  <output class="mv-distance" aria-live="polite">{snapshot.distance === null ? snapshot.measuring ? snapshot.measurePoints ? 'Pick the second surface point' : 'Pick the first surface point' : 'No measurement' : length(snapshot.distance)}</output>
  <p class="mv-note">Surface picks are mesh approximations. Inspection pauses animation; picks stay on that pose. A third pick starts a new measurement.</p>
</section>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>Section plane</h5><span class="mv-small-badge">View only</span></div>
  <label class="mv-field">Axis<select value={snapshot.sectionAxis} onchange={(e) => section(e.currentTarget.value as SectionAxis)}><option value="off">Off</option><option value="x">X axis</option><option value="y">Y axis</option><option value="z">Z axis</option></select></label>
  {#if snapshot.sectionAxis !== 'off'}
    <label class="mv-range-label">Position <span>{Math.round(snapshot.sectionPercent)}%</span><input type="range" min="0" max="100" step="1" value={snapshot.sectionPercent} oninput={(e) => section(snapshot.sectionAxis, Number(e.currentTarget.value))} /></label>
    <button type="button" class="mv-button" aria-pressed={snapshot.sectionFlipped} onclick={() => section(snapshot.sectionAxis, snapshot.sectionPercent, !snapshot.sectionFlipped)}>Flip cut side</button>
  {/if}
  <p class="mv-note">Clips the preview without editing geometry. Cut faces are open, not filled or capped.</p>
</section>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>Parts</h5><button type="button" class="mv-text-button" onclick={() => runtime.restoreVisibility()}>Restore visibility</button></div>
  <input class="mv-search" type="search" placeholder="Find a mesh…" aria-label="Find a mesh" bind:value={query} />
  <div class="mv-inline-actions">
    <button type="button" class="mv-button" disabled={snapshot.selectedId === null} onclick={() => runtime.isolate()}>Isolate selected</button>
    <button type="button" class="mv-button" disabled={snapshot.selectedId === null} onclick={() => runtime.select(null)}>Deselect</button>
  </div>
  <ul class="mv-mesh-list" aria-label="Model meshes">
    {#each displayed as mesh (mesh.id)}
      <li class:mv-mesh-selected={snapshot.selectedId === mesh.id}>
        <button class="mv-mesh-name" type="button" aria-pressed={snapshot.selectedId === mesh.id} title={mesh.name} onclick={() => runtime.select(mesh.id)}>{mesh.name}</button>
        <button class="mv-mesh-visibility" type="button" aria-label={`${mesh.visible ? 'Hide' : 'Show'} ${mesh.name}`} aria-pressed={mesh.visible} onclick={() => runtime.toggleVisibility(mesh.id)}>{mesh.visible ? 'Visible' : 'Hidden'}</button>
      </li>
    {/each}
  </ul>
  {#if !matching.length}<p class="mv-note">No mesh matches this search.</p>{/if}
  {#if matching.length > displayed.length}<p class="mv-note">Showing {displayed.length} of {matching.length}. Narrow the search to find another mesh.</p>{/if}
  <p class="mv-note">These are imported meshes, not a parametric CAD feature tree.</p>
</section>
<section class="mv-panel-section">
  <h5>Standard views</h5>
  <div class="mv-view-grid" role="group" aria-label="Additional camera views">
    {#each [['iso', 'Iso'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']] as [view, label]}
      <button type="button" class="mv-button" onclick={() => runtime.setView(view as ModelView)}>{label}</button>
    {/each}
  </div>
  <button type="button" class="mv-button mv-reset" onclick={() => runtime.reset()}>Reset inspection</button>
  <p class="mv-note">Standard views use the existing perspective camera. Inspection is session-only; nothing is written to the source file.</p>
</section>
