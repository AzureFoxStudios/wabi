<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    boundsForCadEntities,
    cadArcPoints,
    cadScreenToDrawingPoint,
    cadViewportScale,
    formatCadNumber,
    nearestCadSnap,
    parseAsciiDxf,
    type Cad2DDrawing,
    type CadBounds,
    type CadPoint
  } from '$lib/cad2d';

  let { src, fileName = 'Drawing.dxf', compact = false, height = 460 }:
    { src: string; fileName?: string; compact?: boolean; height?: number } = $props();

  const MAX_DXF_BYTES = 20 * 1024 * 1024;
  let drawing = $state<Cad2DDrawing | null>(null);
  let loading = $state(false);
  let error = $state('');
  let hiddenLayers = $state<Set<string>>(new Set());
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let dragStart = $state<{ x: number; y: number; panX: number; panY: number } | null>(null);
  let measureMode = $state(false);
  let measureA = $state<CadPoint | null>(null);
  let measureB = $state<CadPoint | null>(null);
  let cursorPoint = $state<CadPoint | null>(null);
  let svg = $state<SVGSVGElement>();
  let loadAbort: AbortController | null = null;
  let loadSequence = 0;

  const visibleEntities = $derived(drawing ? drawing.entities.filter((entity) => !hiddenLayers.has(entity.layer)) : []);
  const visibleBounds = $derived(drawing ? boundsForCadEntities(visibleEntities.length ? visibleEntities : drawing.entities) : null);
  const measurement = $derived(measureA && measureB ? Math.hypot(measureB.x - measureA.x, measureB.y - measureA.y) : null);
  const ignoredCount = $derived(drawing ? Object.values(drawing.ignoredEntityTypes).reduce((sum, count) => sum + count, 0) : 0);

  function padded(bounds: CadBounds): CadBounds {
    const width = Math.max(bounds.maxX - bounds.minX, 1e-9);
    const heightValue = Math.max(bounds.maxY - bounds.minY, 1e-9);
    const pad = Math.max(width, heightValue) * 0.06;
    return { minX: bounds.minX - pad, minY: bounds.minY - pad, maxX: bounds.maxX + pad, maxY: bounds.maxY + pad };
  }

  const viewBox = $derived.by(() => {
    const source = visibleBounds || { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    const fit = padded(source);
    const baseW = Math.max(fit.maxX - fit.minX, 1e-6);
    const baseH = Math.max(fit.maxY - fit.minY, 1e-6);
    const width = baseW / Math.max(zoom, 0.05);
    const h = baseH / Math.max(zoom, 0.05);
    const centerX = (fit.minX + fit.maxX) / 2 + panX;
    const centerScreenY = -((fit.minY + fit.maxY) / 2) + panY;
    return { x: centerX - width / 2, y: centerScreenY - h / 2, width, height: h };
  });

  function resetView(): void { zoom = 1; panX = 0; panY = 0; }
  function clearMeasure(): void { measureA = null; measureB = null; }
  function toggleLayer(layer: string): void {
    const next = new Set(hiddenLayers);
    if (next.has(layer)) next.delete(layer); else next.add(layer);
    hiddenLayers = next;
    clearMeasure();
    resetView();
  }
  function showAllLayers(): void { hiddenLayers = new Set(); clearMeasure(); resetView(); }

  function pointFromEvent(event: PointerEvent | MouseEvent): CadPoint | null {
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return cadScreenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, viewBox);
  }
  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (measureMode) return;
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY, panX, panY };
    svg?.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event: PointerEvent): void {
    const point = pointFromEvent(event);
    cursorPoint = point;
    if (!dragging || !dragStart || !svg) return;
    const rect = svg.getBoundingClientRect();
    const scale = cadViewportScale(rect.width, rect.height, viewBox);
    if (scale == null) return;
    panX = dragStart.panX - (event.clientX - dragStart.x) / scale;
    panY = dragStart.panY - (event.clientY - dragStart.y) / scale;
  }
  function pointerUp(): void { dragging = false; dragStart = null; }
  function wheel(event: WheelEvent): void {
    event.preventDefault();
    const before = pointFromEvent(event);
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextZoom = Math.max(0.08, Math.min(80, zoom * factor));
    if (!before || nextZoom === zoom) { zoom = nextZoom; return; }
    const oldZoom = zoom;
    zoom = nextZoom;
    const after = pointFromEvent(event);
    if (after) {
      // Keep the model point under the cursor approximately stationary.
      panX += before.x - after.x;
      panY += -(before.y - after.y);
    }
    if (!Number.isFinite(panX) || !Number.isFinite(panY)) { zoom = oldZoom; resetView(); }
  }
  function measureClick(event: MouseEvent): void {
    if (!measureMode || !drawing) return;
    const raw = pointFromEvent(event);
    if (!raw) return;
    const tolerance = Math.max(viewBox.width, viewBox.height) / 45;
    const point = nearestCadSnap(visibleEntities, raw, tolerance) || raw;
    if (!measureA || measureB) { measureA = point; measureB = null; }
    else measureB = point;
  }

  async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_DXF_BYTES) throw new Error('DXF is larger than the built-in 20 MB preview limit.');
    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_DXF_BYTES) throw new Error('DXF is larger than the built-in 20 MB preview limit.');
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DXF_BYTES) throw new Error('DXF is larger than the built-in 20 MB preview limit.');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock();
    }
  }

  $effect(() => {
    const source = src;
    const name = fileName;
    const sequence = ++loadSequence;
    loadAbort?.abort();
    const controller = new AbortController();
    loadAbort = controller;
    drawing = null; error = ''; loading = true; hiddenLayers = new Set(); clearMeasure(); resetView();
    void (async () => {
      try {
        if (!/\.dxf(?:$|[?#])/i.test(name) && !/\.dxf(?:$|[?#])/i.test(source)) throw new Error('The built-in 2D CAD reader currently supports ASCII DXF only.');
        const response = await fetch(source, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load DXF (${response.status}).`);
        const text = await readLimited(response, controller.signal);
        const parsed = parseAsciiDxf(text);
        if (sequence !== loadSequence || controller.signal.aborted) return;
        drawing = parsed;
      } catch (reason) {
        if (controller.signal.aborted || sequence !== loadSequence) return;
        error = reason instanceof Error ? reason.message : 'Could not read this DXF file.';
      } finally {
        if (sequence === loadSequence && !controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });

  onDestroy(() => loadAbort?.abort());
</script>

<div class:compact class="cad2d-shell" style={`--cad-height:${Math.max(compact ? 180 : 260, height)}px`}>
  <div class="cad2d-toolbar" aria-label="2D CAD drawing tools">
    <div class="cad2d-title"><strong>{fileName}</strong><span>{drawing ? `${drawing.entities.length.toLocaleString()} entities · ${drawing.layers.length} layers` : '2D CAD'}</span></div>
    <div class="cad2d-actions">
      <button type="button" onclick={resetView}>Fit</button>
      <button type="button" class:active={measureMode} aria-pressed={measureMode} onclick={() => { measureMode = !measureMode; clearMeasure(); }}>{measureMode ? 'Measuring' : 'Measure'}</button>
      {#if !compact && hiddenLayers.size > 0}<button type="button" onclick={showAllLayers}>Show all layers</button>{/if}
    </div>
  </div>

  <div class="cad2d-main">
    <div class="cad2d-canvas-wrap">
      {#if loading}<div class="cad2d-state">Reading DXF…</div>
      {:else if error}<div class="cad2d-state cad2d-error"><strong>2D preview unavailable</strong><span>{error}</span></div>
      {:else if drawing}
        <svg bind:this={svg} class:measure-mode={measureMode} viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          role="img" aria-label={`2D CAD drawing ${fileName}`}
          onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp} onpointerleave={pointerUp}
          onwheel={wheel} onclick={measureClick}>
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} class="cad-bg" />
          {#each visibleEntities as entity, index (`${entity.layer}-${entity.type}-${index}`)}
            {#if entity.type === 'LINE'}
              <line x1={entity.a.x} y1={-entity.a.y} x2={entity.b.x} y2={-entity.b.y} class="cad-entity" />
            {:else if entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE'}
              <polyline points={`${entity.points.map((point) => `${point.x},${-point.y}`).join(' ')}${entity.closed ? ` ${entity.points[0].x},${-entity.points[0].y}` : ''}`} class="cad-entity" />
            {:else if entity.type === 'CIRCLE'}
              <circle cx={entity.center.x} cy={-entity.center.y} r={entity.radius} class="cad-entity" />
            {:else if entity.type === 'ARC'}
              {@const arc = cadArcPoints(entity)}
              <polyline points={arc.map((point) => `${point.x},${-point.y}`).join(' ')} class="cad-entity" />
            {:else if entity.type === 'TEXT' || entity.type === 'MTEXT'}
              <text x={entity.point.x} y={-entity.point.y} font-size={entity.height} transform={`rotate(${-entity.rotationDeg} ${entity.point.x} ${-entity.point.y})`} class="cad-text">{entity.text}</text>
            {:else if entity.type === 'POINT'}
              <circle cx={entity.point.x} cy={-entity.point.y} r={Math.max(viewBox.width, viewBox.height) / 500} class="cad-point" />
            {/if}
          {/each}
          {#if measureA}<circle cx={measureA.x} cy={-measureA.y} r={Math.max(viewBox.width, viewBox.height) / 260} class="measure-point" />{/if}
          {#if measureA && measureB}
            <line x1={measureA.x} y1={-measureA.y} x2={measureB.x} y2={-measureB.y} class="measure-line" />
            <circle cx={measureB.x} cy={-measureB.y} r={Math.max(viewBox.width, viewBox.height) / 260} class="measure-point" />
          {/if}
        </svg>
        <div class="cad2d-readout">
          <span>{drawing.unit === 'unknown' ? 'Units not declared' : `Units: ${drawing.unit}`}</span>
          {#if cursorPoint && !compact}<span>X {formatCadNumber(cursorPoint.x)} · Y {formatCadNumber(cursorPoint.y)}</span>{/if}
          {#if measurement != null}<strong>{formatCadNumber(measurement)} {drawing.unit === 'unknown' ? 'drawing units' : drawing.unit}</strong>{/if}
        </div>
      {/if}
    </div>

    {#if drawing && !compact}
      <aside class="cad2d-inspector" aria-label="2D CAD drawing inspector">
        <section><h3>Drawing</h3><dl><div><dt>Width</dt><dd>{formatCadNumber(drawing.bounds.maxX - drawing.bounds.minX)}</dd></div><div><dt>Height</dt><dd>{formatCadNumber(drawing.bounds.maxY - drawing.bounds.minY)}</dd></div><div><dt>Units</dt><dd>{drawing.unit === 'unknown' ? 'Not declared' : drawing.unit}</dd></div></dl></section>
        <section><div class="cad2d-section-head"><h3>Layers</h3>{#if hiddenLayers.size > 0}<button type="button" onclick={showAllLayers}>All on</button>{/if}</div><div class="cad2d-layers">{#each drawing.layers as layer}<label><input type="checkbox" checked={!hiddenLayers.has(layer)} onchange={() => toggleLayer(layer)} /><span>{layer}</span></label>{/each}</div></section>
        <section><h3>Reader coverage</h3><p>Built-in DXF preview: LINE, POLYLINE/LWPOLYLINE, CIRCLE, ARC, POINT, TEXT and MTEXT.</p>{#if ignoredCount > 0}<p>{ignoredCount.toLocaleString()} unsupported entities were skipped. The original file is unchanged.</p>{/if}</section>
      </aside>
    {/if}
  </div>
</div>

<style>
  .cad2d-shell { min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;background:var(--surface-app,#10191d);color:var(--text-heading,#e7efef); }
  .cad2d-shell.compact { height:var(--cad-height);min-height:180px; }
  .cad2d-toolbar { display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border-subtle,#34454b);background:var(--surface-base,#172126); }
  .cad2d-title { min-width:0;display:flex;flex-direction:column;gap:2px; }
  .cad2d-title strong { font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .cad2d-title span { font-size:9px;color:var(--text-muted,#a9b9bc); }
  .cad2d-actions { display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end; }
  .cad2d-actions button,.cad2d-section-head button { border:1px solid var(--border-subtle,#43535a);border-radius:6px;background:var(--surface-raised,#26343a);color:inherit;font:inherit;font-size:10px;padding:5px 8px;cursor:pointer; }
  .cad2d-actions button.active { border-color:var(--accent-primary-color,#8fd5c4);background:color-mix(in srgb,var(--accent-primary-color,#8fd5c4) 18%,var(--surface-raised,#26343a)); }
  .cad2d-main { flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,240px); }
  .compact .cad2d-main { display:block; }
  .cad2d-canvas-wrap { position:relative;min-height:0;overflow:hidden;background:#0b1317; }
  .cad2d-canvas-wrap svg { width:100%;height:100%;display:block;touch-action:none;cursor:grab; }
  .cad2d-canvas-wrap svg:active { cursor:grabbing; }
  .cad2d-canvas-wrap svg.measure-mode { cursor:crosshair; }
  .cad-bg { fill:#0b1317; }
  .cad-entity { fill:none;stroke:#d8e6e3;stroke-width:1.15;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round; }
  .cad-point { fill:#d8e6e3;stroke:none;vector-effect:non-scaling-stroke; }
  .cad-text { fill:#c9dbd7;stroke:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none; }
  .measure-line { stroke:#89dfc8;stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-dasharray:5 4; }
  .measure-point { fill:#89dfc8;stroke:#0b1317;stroke-width:1;vector-effect:non-scaling-stroke; }
  .cad2d-state { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:18px;text-align:center;color:var(--text-muted,#a9b9bc);font-size:12px; }
  .cad2d-error strong { color:var(--text-heading,#e7efef); }
  .cad2d-readout { position:absolute;left:8px;bottom:8px;display:flex;gap:8px;flex-wrap:wrap;max-width:calc(100% - 16px);padding:5px 7px;border:1px solid rgba(120,150,150,.25);border-radius:6px;background:rgba(9,18,22,.82);font-size:9px;color:#b9cdca;pointer-events:none; }
  .cad2d-readout strong { color:#9be5d2;font-weight:600; }
  .cad2d-inspector { min-width:0;overflow:auto;border-left:1px solid var(--border-subtle,#34454b);background:var(--surface-base,#172126);padding:10px; }
  .cad2d-inspector section + section { border-top:1px solid var(--border-subtle,#34454b);margin-top:12px;padding-top:12px; }
  .cad2d-inspector h3 { margin:0 0 8px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted,#a9b9bc); }
  .cad2d-inspector p { margin:6px 0 0;font-size:10px;line-height:1.5;color:var(--text-muted,#a9b9bc); }
  .cad2d-inspector dl { display:grid;gap:5px;margin:0; }
  .cad2d-inspector dl div { display:flex;justify-content:space-between;gap:8px;font-size:10px; }
  .cad2d-inspector dt { color:var(--text-muted,#a9b9bc); }.cad2d-inspector dd { margin:0; }
  .cad2d-section-head { display:flex;align-items:center;justify-content:space-between;gap:8px; }
  .cad2d-layers { display:grid;gap:5px;max-height:220px;overflow:auto; }
  .cad2d-layers label { display:flex;align-items:center;gap:7px;font-size:10px;min-width:0; }.cad2d-layers span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  :is(button,input):focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
  @media (max-width:700px) { .cad2d-shell:not(.compact) .cad2d-main { grid-template-columns:1fr;grid-template-rows:minmax(260px,1fr) minmax(120px,auto);overflow:auto; }.cad2d-inspector { border-left:0;border-top:1px solid var(--border-subtle,#34454b);max-height:230px; }.cad2d-toolbar { align-items:flex-start;flex-direction:column; }.cad2d-actions { justify-content:flex-start; } }
</style>
