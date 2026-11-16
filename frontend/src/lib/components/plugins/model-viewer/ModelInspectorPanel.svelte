<script lang="ts">
	import { _ } from '$lib/i18n';
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

<div class="mv-panel-title"><h4>{$_('model_inspect.heading')}</h4><span class="mv-muted">{$_('model_inspect.mesh_tools')}</span></div>
<p class="mv-panel-summary">{$_('model_inspect.summary', { values: { meshes: snapshot.meshes.length.toLocaleString('en-US'), triangles: triangleCount.toLocaleString('en-US') } })}</p>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>{$_('model_inspect.dimensions')}</h5><button type="button" class="mv-text-button" onclick={() => runtime.refresh()}>{$_('model_inspect.refresh_pose')}</button></div>
  <p class="mv-muted mv-truncate" title={selected?.name || $_('model_inspect.whole')}>{selected?.name || $_('model_inspect.whole')} · {$_('model_inspect.bounding_box')}</p>
  <div class="mv-dimensions">
    {#each ['x', 'y', 'z'] as axis}
      <div><span>{axis.toUpperCase()}</span><strong>{length(snapshot.dimensions?.[axis as 'x' | 'y' | 'z'] ?? null)}</strong></div>
    {/each}
  </div>
  <div class="mv-field-grid">
    <label>{$_('model_inspect.source_units')}<select value={sourceUnit} onchange={changeSource}><option value="model">{$_('model_inspect.unspecified')}</option>{#each units as unit}<option value={unit}>{unit}</option>{/each}</select></label>
    <label>{$_('model_inspect.display_units')}<select bind:value={displayUnit} disabled={sourceUnit === 'model'}>{#if sourceUnit === 'model'}<option value="model">{$_('model_inspect.model_units')}</option>{:else}{#each units as unit}<option value={unit}>{unit}</option>{/each}{/if}</select></label>
  </div>
  <p class="mv-note">{$_('model_inspect.units_note', { values: { note: sourceUnit === 'model' ? $_('model_inspect.scale_unspecified') : $_('model_inspect.scale_assumption') } })}</p>
</section>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>{$_('model_inspect.measure')}</h5><span class="mv-small-badge">{$_('model_inspect.approximate')}</span></div>
  <div class="mv-inline-actions">
    <button type="button" class="mv-button" aria-pressed={snapshot.measuring} onclick={() => runtime.setMeasuring(!snapshot.measuring)}>{snapshot.measuring ? $_('model_inspect.stop_measuring') : $_('model_inspect.pick_two')}</button>
    <button type="button" class="mv-button" disabled={snapshot.measurePoints === 0} onclick={() => runtime.clearMeasurement()}>{$_('model_inspect.clear')}</button>
  </div>
  <output class="mv-distance" aria-live="polite">{snapshot.distance === null ? snapshot.measuring ? snapshot.measurePoints ? $_('model_inspect.pick_second') : $_('model_inspect.pick_first') : $_('model_inspect.no_measurement') : length(snapshot.distance)}</output>
  <p class="mv-note">{$_('model_inspect.measure_note')}</p>
</section>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>{$_('model_inspect.section_plane')}</h5><span class="mv-small-badge">{$_('model_inspect.view_only')}</span></div>
  <label class="mv-field">{$_('model_inspect.axis')}<select value={snapshot.sectionAxis} onchange={(e) => section(e.currentTarget.value as SectionAxis)}><option value="off">{$_('model_inspect.off')}</option><option value="x">X {$_('model_inspect.axis')}</option><option value="y">Y {$_('model_inspect.axis')}</option><option value="z">Z {$_('model_inspect.axis')}</option></select></label>
  {#if snapshot.sectionAxis !== 'off'}
    <label class="mv-range-label">{$_('model_inspect.position')} <span>{Math.round(snapshot.sectionPercent)}%</span><input type="range" min="0" max="100" step="1" value={snapshot.sectionPercent} oninput={(e) => section(snapshot.sectionAxis, Number(e.currentTarget.value))} /></label>
    <button type="button" class="mv-button" aria-pressed={snapshot.sectionFlipped} onclick={() => section(snapshot.sectionAxis, snapshot.sectionPercent, !snapshot.sectionFlipped)}>{$_('model_inspect.flip')}</button>
  {/if}
  <p class="mv-note">{$_('model_inspect.section_note')}</p>
</section>
<section class="mv-panel-section">
  <div class="mv-section-heading"><h5>{$_('model_inspect.parts')}</h5><button type="button" class="mv-text-button" onclick={() => runtime.restoreVisibility()}>{$_('model_inspect.restore_visibility')}</button></div>
  <input class="mv-search" type="search" placeholder={$_('model_inspect.find_mesh')} aria-label={$_('model_inspect.find_mesh_label')} bind:value={query} />
  <div class="mv-inline-actions">
    <button type="button" class="mv-button" disabled={snapshot.selectedId === null} onclick={() => runtime.isolate()}>{$_('model_inspect.isolate')}</button>
    <button type="button" class="mv-button" disabled={snapshot.selectedId === null} onclick={() => runtime.select(null)}>{$_('model_inspect.deselect')}</button>
  </div>
  <ul class="mv-mesh-list" aria-label={$_('model_inspect.meshes_list')}>
    {#each displayed as mesh (mesh.id)}
      <li class:mv-mesh-selected={snapshot.selectedId === mesh.id}>
        <button class="mv-mesh-name" type="button" aria-pressed={snapshot.selectedId === mesh.id} title={mesh.name} onclick={() => runtime.select(mesh.id)}>{mesh.name}</button>
        <button class="mv-mesh-visibility" type="button" aria-label={`${mesh.visible ? $_('model_inspect.hide') : $_('model_inspect.show')} ${mesh.name}`} aria-pressed={mesh.visible} onclick={() => runtime.toggleVisibility(mesh.id)}>{mesh.visible ? $_('model_inspect.visible') : $_('model_inspect.hidden')}</button>
      </li>
    {/each}
  </ul>
  {#if !matching.length}<p class="mv-note">{$_('model_inspect.no_match')}</p>{/if}
  {#if matching.length > displayed.length}<p class="mv-note">{$_('model_inspect.showing_of', { values: { shown: displayed.length, total: matching.length } })}</p>{/if}
  <p class="mv-note">{$_('model_inspect.imported_note')}</p>
</section>
<section class="mv-panel-section">
  <h5>{$_('model_inspect.standard_views')}</h5>
  <div class="mv-view-grid" role="group" aria-label={$_('model_inspect.views_label')}>
    {#each [['iso', $_('model_inspect.view_iso')], ['front', $_('model_inspect.view_front')], ['back', $_('model_inspect.view_back')], ['left', $_('model_inspect.view_left')], ['right', $_('model_inspect.view_right')], ['top', $_('model_inspect.view_top')], ['bottom', $_('model_inspect.view_bottom')]] as [view, label]}
      <button type="button" class="mv-button" onclick={() => runtime.setView(view as ModelView)}>{label}</button>
    {/each}
  </div>
  <button type="button" class="mv-button mv-reset" onclick={() => runtime.reset()}>{$_('model_inspect.reset')}</button>
  <p class="mv-note">{$_('model_inspect.views_note')}</p>
</section>
