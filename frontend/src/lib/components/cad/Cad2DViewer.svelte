<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    boundsForCadEntities,
    cadArcPoints,
    cadDashArray,
    cadScreenToDrawingPoint,
    cadStrokeWidth,
    cadViewportScale,
    formatCadNumber,
    nearestCadSnap,
    parseAsciiDxf,
    type Cad2DDrawing,
    type Cad2DEntity,
    type CadBounds,
    type CadPoint
  } from '$lib/cad2d';
  import {
    CAD_REVIEW_COLORS,
    CAD_REVIEW_WIDTHS,
    cadReviewAssetKey,
    createCadReviewShape,
    createCadReviewStroke,
    createCadReviewText,
    simplifyCadReviewPoints,
    type CadReviewElement,
    type CadReviewTool
  } from '$lib/cadReview';
  import { createCadReviewSession, type CadReviewSession, type CadReviewSyncState } from '$lib/cadReviewSync';
  import { hitTestElement } from '$lib/whiteboard/coords';
  import type { Point } from '$lib/whiteboard/elementTypes';

  let { src, fileName = 'Drawing.dxf', compact = false, height = 460, channelId = null }:
    { src: string; fileName?: string; compact?: boolean; height?: number; channelId?: string | null } = $props();

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

  let reviewMode = $state(false);
  let reviewTool = $state<CadReviewTool>('pen');
  let reviewColor = $state<string>(CAD_REVIEW_COLORS[1]);
  let reviewWidth = $state<number>(CAD_REVIEW_WIDTHS[1]);
  let reviewElements = $state<CadReviewElement[]>([]);
  let reviewDraft = $state<CadReviewElement | null>(null);
  let reviewStart = $state<Point | null>(null);
  let reviewPoints = $state<Point[]>([]);
  let reviewPointerId = $state<number | null>(null);
  let reviewSession: CadReviewSession | null = null;
  let reviewSync = $state<CadReviewSyncState>({ elements: [], status: 'local', boardId: null, error: null });
  let reviewUndo = $state<Array<{ kind: 'create'; elements: CadReviewElement[] } | { kind: 'delete'; elements: CadReviewElement[] }>>([]);
  let reviewRedo = $state<Array<{ kind: 'create'; elements: CadReviewElement[] } | { kind: 'delete'; elements: CadReviewElement[] }>>([]);
  let textPoint = $state<Point | null>(null);
  let textValue = $state('');
  const reviewMarkerId = $derived(`cad-review-arrow-${cadReviewAssetKey(src, fileName)}`);

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
    soloLayer = null;
    clearMeasure();
    resetView();
  }
  function showAllLayers(): void { hiddenLayers = new Set(); soloLayer = null; clearMeasure(); resetView(); }
  let soloLayer = $state<string | null>(null);
  function toggleSolo(layer: string): void {
    if (!drawing) return;
    if (soloLayer === layer) {
      soloLayer = null;
      hiddenLayers = new Set();
    } else {
      soloLayer = layer;
      hiddenLayers = new Set(drawing.layers.filter((name) => name !== layer));
    }
    clearMeasure();
    resetView();
  }
  const layerCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const entity of drawing?.entities ?? []) counts.set(entity.layer, (counts.get(entity.layer) ?? 0) + 1);
    return counts;
  });
  function cadEntityStyle(entity: Cad2DEntity): string | undefined {
    const parts: string[] = [];
    if (entity.color) parts.push(`stroke:${entity.color}`);
    const dash = cadDashArray(entity.linetype);
    if (dash) parts.push(`stroke-dasharray:${dash}`);
    if (entity.weight !== 0) parts.push(`stroke-width:${cadStrokeWidth(entity.weight)}`);
    return parts.length > 0 ? parts.join(';') : undefined;
  }
  function cadFillStyle(entity: Cad2DEntity): string | undefined {
    return entity.color ? `fill:${entity.color}` : undefined;
  }
  let collapsedSections = $state<Set<string>>(new Set());
  function toggleSection(section: string): void {
    const next = new Set(collapsedSections);
    if (next.has(section)) next.delete(section); else next.add(section);
    collapsedSections = next;
  }

  function pointFromEvent(event: PointerEvent | MouseEvent): CadPoint | null {
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return cadScreenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, viewBox);
  }

  function beginPan(event: PointerEvent): void {
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY, panX, panY };
    svg?.setPointerCapture?.(event.pointerId);
  }

  function nextReviewZ(): number {
    return reviewElements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1;
  }

  function reviewStyle() { return { strokeColor: reviewColor, strokeWidth: reviewWidth }; }

  function commitReviewElement(element: CadReviewElement): void {
    reviewSession?.add(element);
    reviewUndo = [...reviewUndo.slice(-49), { kind: 'create', elements: [element] }];
    reviewRedo = [];
  }

  function eraseReviewAt(point: Point): void {
    const tolerance = Math.max(viewBox.width, viewBox.height) / 90;
    const target = [...reviewElements].sort((a, b) => b.zIndex - a.zIndex).find((element) => hitTestElement(element, point.x, point.y, tolerance));
    if (!target) return;
    reviewSession?.remove([target.id]);
    reviewUndo = [...reviewUndo.slice(-49), { kind: 'delete', elements: [target] }];
    reviewRedo = [];
  }

  function chooseReviewTool(tool: CadReviewTool): void {
    reviewTool = tool;
    reviewDraft = null;
    reviewStart = null;
    reviewPoints = [];
    reviewPointerId = null;
    if (tool !== 'text') { textPoint = null; textValue = ''; }
  }

  function setReviewMode(enabled: boolean): void {
    reviewMode = enabled;
    if (enabled) {
      measureMode = false;
      clearMeasure();
    }
    if (!enabled) {
      chooseReviewTool('pen');
      textPoint = null;
      textValue = '';
    }
  }

  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (reviewMode) {
      const point = pointFromEvent(event);
      if (!point) return;
      if (reviewTool === 'pan') { beginPan(event); return; }
      event.preventDefault();
      if (reviewTool === 'eraser') { eraseReviewAt(point); return; }
      if (reviewTool === 'text') { textPoint = point; textValue = ''; return; }
      reviewPointerId = event.pointerId;
      svg?.setPointerCapture?.(event.pointerId);
      reviewStart = point;
      if (reviewTool === 'pen') {
        reviewPoints = [{ x: point.x, y: point.y, pressure: event.pressure || 0.5 }];
        reviewDraft = createCadReviewStroke(reviewPoints, reviewStyle(), nextReviewZ());
      } else if (reviewTool === 'arrow' || reviewTool === 'rect' || reviewTool === 'ellipse') {
        reviewDraft = createCadReviewShape(reviewTool, point, point, reviewStyle(), nextReviewZ());
      }
      return;
    }
    if (measureMode) return;
    beginPan(event);
  }

  function pointerMove(event: PointerEvent): void {
    const point = pointFromEvent(event);
    cursorPoint = point;
    if (reviewMode && reviewPointerId === event.pointerId && reviewStart && point) {
      if (reviewTool === 'pen') {
        const last = reviewPoints[reviewPoints.length - 1];
        const minDistance = Math.max(viewBox.width, viewBox.height) / 900;
        if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= minDistance) {
          reviewPoints = [...reviewPoints, { x: point.x, y: point.y, pressure: event.pressure || 0.5 }];
          reviewDraft = createCadReviewStroke(reviewPoints, reviewStyle(), nextReviewZ());
        }
      } else if (reviewTool === 'arrow' || reviewTool === 'rect' || reviewTool === 'ellipse') {
        let end = point;
        if (event.shiftKey) {
          const dx = point.x - reviewStart.x;
          const dy = point.y - reviewStart.y;
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          end = { x: reviewStart.x + size * Math.sign(dx || 1), y: reviewStart.y + size * Math.sign(dy || 1) };
        }
        reviewDraft = createCadReviewShape(reviewTool, reviewStart, end, reviewStyle(), nextReviewZ());
      }
      return;
    }
    if (!dragging || !dragStart || !svg) return;
    const rect = svg.getBoundingClientRect();
    const scale = cadViewportScale(rect.width, rect.height, viewBox);
    if (scale == null) return;
    panX = dragStart.panX - (event.clientX - dragStart.x) / scale;
    panY = dragStart.panY - (event.clientY - dragStart.y) / scale;
  }

  function pointerUp(event: PointerEvent): void {
    if (reviewMode && reviewPointerId === event.pointerId) {
      if (reviewDraft) {
        if (reviewDraft.type === 'stroke') {
          const minDistance = Math.max(viewBox.width, viewBox.height) / 900;
          const points = simplifyCadReviewPoints(reviewPoints, minDistance);
          if (points.length > 0) commitReviewElement(createCadReviewStroke(points, reviewStyle(), reviewDraft.zIndex));
        } else {
          const minSize = Math.max(viewBox.width, viewBox.height) / 300;
          if (Math.abs(reviewDraft.width) >= minSize || Math.abs(reviewDraft.height) >= minSize) commitReviewElement(reviewDraft);
        }
      }
      reviewDraft = null;
      reviewStart = null;
      reviewPoints = [];
      reviewPointerId = null;
    }
    dragging = false;
    dragStart = null;
    if (svg?.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  }

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
    if (!measureMode || !drawing || reviewMode) return;
    const raw = pointFromEvent(event);
    if (!raw) return;
    const tolerance = Math.max(viewBox.width, viewBox.height) / 45;
    const point = nearestCadSnap(visibleEntities, raw, tolerance) || raw;
    if (!measureA || measureB) { measureA = point; measureB = null; }
    else measureB = point;
  }

  function commitReviewText(): void {
    if (!textPoint || !textValue.trim()) { textPoint = null; textValue = ''; return; }
    const fontSize = Math.max(viewBox.width, viewBox.height) / 42;
    commitReviewElement(createCadReviewText(textPoint, textValue, fontSize, reviewStyle(), nextReviewZ()));
    textPoint = null;
    textValue = '';
  }

  function undoReview(): void {
    const action = reviewUndo[reviewUndo.length - 1];
    if (!action) return;
    reviewUndo = reviewUndo.slice(0, -1);
    if (action.kind === 'create') reviewSession?.remove(action.elements.map((element) => element.id));
    else for (const element of action.elements) reviewSession?.add(element);
    reviewRedo = [...reviewRedo, action];
  }

  function redoReview(): void {
    const action = reviewRedo[reviewRedo.length - 1];
    if (!action) return;
    reviewRedo = reviewRedo.slice(0, -1);
    if (action.kind === 'create') for (const element of action.elements) reviewSession?.add(element);
    else reviewSession?.remove(action.elements.map((element) => element.id));
    reviewUndo = [...reviewUndo, action];
  }

  function reviewStatusLabel(): string {
    if (reviewSync.status === 'shared') return 'Shared review';
    if (reviewSync.status === 'connecting') return 'Connecting review…';
    if (reviewSync.status === 'offline') return 'Review offline';
    if (reviewSync.status === 'error') return 'Review sync error';
    return 'Local review';
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
    drawing = null; error = ''; loading = true; hiddenLayers = new Set(); soloLayer = null; clearMeasure(); resetView();
    void (async () => {
      try {
        if (!/\.dxf(?:$|[?#])/i.test(name) && !/\.dxf(?:$|[?#])/i.test(source)) throw new Error('The built-in 2D CAD reader currently supports ASCII DXF only.');
        const response = await fetch(source, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load DXF (${response.status}).`);
        const text = await readLimited(response, controller.signal);
        const parsed = parseAsciiDxf(text);
        if (sequence !== loadSequence || controller.signal.aborted) return;
        drawing = parsed;
        soloLayer = null;
        hiddenLayers = new Set(Object.entries(parsed.layerStyles).filter(([, style]) => style.off).map(([name]) => name));
      } catch (reason) {
        if (controller.signal.aborted || sequence !== loadSequence) return;
        error = reason instanceof Error ? reason.message : 'Could not read this DXF file.';
      } finally {
        if (sequence === loadSequence && !controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });

  $effect(() => {
    if (compact) return;
    const session = createCadReviewSession({ channelId, src, fileName });
    reviewSession = session;
    const unsubscribe = session.subscribe((state) => {
      reviewSync = state;
      reviewElements = state.elements;
    });
    return () => {
      unsubscribe();
      session.destroy();
      if (reviewSession === session) reviewSession = null;
    };
  });

  onDestroy(() => loadAbort?.abort());
</script>

<div class:compact class="cad2d-shell" style={`--cad-height:${Math.max(compact ? 180 : 260, height)}px`}>
  <div class="cad2d-toolbar" aria-label="2D CAD drawing tools">
    <div class="cad2d-title"><strong>{fileName}</strong><span>{drawing ? `${drawing.entities.length.toLocaleString()} entities · ${drawing.layers.length} layers` : '2D CAD'}</span></div>
    <div class="cad2d-actions">
      <button type="button" onclick={resetView}>Fit</button>
      <button type="button" class:active={measureMode} aria-pressed={measureMode} onclick={() => { measureMode = !measureMode; setReviewMode(false); clearMeasure(); }}>{measureMode ? 'Measuring' : 'Measure'}</button>
      {#if !compact}<button type="button" class:active={reviewMode} aria-pressed={reviewMode} onclick={() => setReviewMode(!reviewMode)}>{reviewMode ? 'Reviewing' : 'Review'}</button>{/if}
      {#if !compact && hiddenLayers.size > 0}<button type="button" onclick={showAllLayers}>Show all layers</button>{/if}
    </div>
  </div>

  {#if reviewMode && !compact}
    <div class="cad-review-toolbar" aria-label="CAD review markup tools">
      <div class="cad-review-tools">
        {#each [['pan','Hand'],['pen','Pen'],['arrow','Arrow'],['rect','Box'],['ellipse','Circle'],['text','Text'],['eraser','Erase']] as item}
          <button type="button" class:active={reviewTool === item[0]} aria-pressed={reviewTool === item[0]} onclick={() => chooseReviewTool(item[0] as CadReviewTool)}>{item[1]}</button>
        {/each}
      </div>
      <div class="cad-review-palette" aria-label="Markup color">
        {#each CAD_REVIEW_COLORS as color}
          <button type="button" class:active={reviewColor === color} aria-label={`Markup color ${color}`} style={`--review-swatch:${color}`} onclick={() => (reviewColor = color)}></button>
        {/each}
      </div>
      <select aria-label="Markup width" bind:value={reviewWidth}>
        {#each CAD_REVIEW_WIDTHS as width}<option value={width}>{width}px</option>{/each}
      </select>
      <button type="button" disabled={reviewUndo.length === 0} onclick={undoReview}>Undo</button>
      <button type="button" disabled={reviewRedo.length === 0} onclick={redoReview}>Redo</button>
      <span class:sync-error={reviewSync.status === 'error'} class="cad-review-status" title={reviewSync.error || undefined}>{reviewStatusLabel()} · {reviewElements.length} marks</span>
    </div>
  {/if}

  <div class="cad2d-main">
    <div class="cad2d-canvas-wrap">
      {#if loading}<div class="cad2d-state">Reading DXF…</div>
      {:else if error}<div class="cad2d-state cad2d-error"><strong>2D preview unavailable</strong><span>{error}</span></div>
      {:else if drawing}
        <svg bind:this={svg} class:measure-mode={measureMode} class:review-mode={reviewMode} class:review-pan={reviewMode && reviewTool === 'pan'} viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          role="img" aria-label={`2D CAD drawing ${fileName}`}
          onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}
          onwheel={wheel} onclick={measureClick}>
          <defs>
            <marker id={reviewMarkerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="strokeWidth">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} class="cad-bg" />
          {#each visibleEntities as entity, index (`${entity.layer}-${entity.type}-${index}`)}
            {#if entity.type === 'LINE'}
              <line x1={entity.a.x} y1={-entity.a.y} x2={entity.b.x} y2={-entity.b.y} class="cad-entity" style={cadEntityStyle(entity)} />
            {:else if entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE'}
              <polyline points={`${entity.points.map((point) => `${point.x},${-point.y}`).join(' ')}${entity.closed ? ` ${entity.points[0].x},${-entity.points[0].y}` : ''}`} class="cad-entity" style={cadEntityStyle(entity)} />
            {:else if entity.type === 'CIRCLE'}
              <circle cx={entity.center.x} cy={-entity.center.y} r={entity.radius} class="cad-entity" style={cadEntityStyle(entity)} />
            {:else if entity.type === 'ARC'}
              {@const arc = cadArcPoints(entity)}
              <polyline points={arc.map((point) => `${point.x},${-point.y}`).join(' ')} class="cad-entity" style={cadEntityStyle(entity)} />
            {:else if entity.type === 'TEXT' || entity.type === 'MTEXT'}
              <text x={entity.point.x} y={-entity.point.y} font-size={entity.height} transform={`rotate(${-entity.rotationDeg} ${entity.point.x} ${-entity.point.y})`} class="cad-text" style={cadFillStyle(entity)}>{entity.text}</text>
            {:else if entity.type === 'POINT'}
              <circle cx={entity.point.x} cy={-entity.point.y} r={Math.max(viewBox.width, viewBox.height) / 500} class="cad-point" style={cadFillStyle(entity)} />
            {/if}
          {/each}

          {#each [...reviewElements, ...(reviewDraft ? [reviewDraft] : [])] as mark (mark.id)}
            {#if mark.type === 'stroke'}
              <polyline points={mark.points.map((point) => `${point.x},${-point.y}`).join(' ')} class="review-mark" stroke={mark.strokeColor} stroke-width={mark.strokeWidth} opacity={mark.opacity} />
            {:else if mark.type === 'arrow'}
              <line x1={mark.x} y1={-mark.y} x2={mark.x + mark.width} y2={-(mark.y + mark.height)} class="review-mark" stroke={mark.strokeColor} stroke-width={mark.strokeWidth} opacity={mark.opacity} marker-end={`url(#${reviewMarkerId})`} />
            {:else if mark.type === 'rect'}
              <rect x={mark.x} y={-(mark.y + mark.height)} width={mark.width} height={mark.height} class="review-mark" stroke={mark.strokeColor} stroke-width={mark.strokeWidth} opacity={mark.opacity} />
            {:else if mark.type === 'ellipse'}
              <ellipse cx={mark.x + mark.width / 2} cy={-(mark.y + mark.height / 2)} rx={mark.width / 2} ry={mark.height / 2} class="review-mark" stroke={mark.strokeColor} stroke-width={mark.strokeWidth} opacity={mark.opacity} />
            {:else if mark.type === 'text'}
              <text x={mark.x} y={-mark.y} font-size={mark.fontSize} class="review-text" fill={mark.fillColor || mark.strokeColor} opacity={mark.opacity}>{mark.text}</text>
            {/if}
          {/each}

          {#if measureA}<circle cx={measureA.x} cy={-measureA.y} r={Math.max(viewBox.width, viewBox.height) / 260} class="measure-point" />{/if}
          {#if measureA && measureB}
            <line x1={measureA.x} y1={-measureA.y} x2={measureB.x} y2={-measureB.y} class="measure-line" />
            <circle cx={measureB.x} cy={-measureB.y} r={Math.max(viewBox.width, viewBox.height) / 260} class="measure-point" />
          {/if}
        </svg>
        {#if textPoint}
          <form class="cad-review-text-entry" onsubmit={(event) => { event.preventDefault(); commitReviewText(); }}>
            <label for="cad-review-text">Review note</label>
            <input id="cad-review-text" bind:value={textValue} maxlength="2000" placeholder="Type a short callout…" autofocus />
            <div><button type="submit" disabled={!textValue.trim()}>Place</button><button type="button" onclick={() => { textPoint = null; textValue = ''; }}>Cancel</button></div>
          </form>
        {/if}
        <div class="cad2d-readout">
          <span>{drawing.unit === 'unknown' ? 'Units not declared' : `Units: ${drawing.unit}`}</span>
          {#if cursorPoint && !compact}<span>X {formatCadNumber(cursorPoint.x)} · Y {formatCadNumber(cursorPoint.y)}</span>{/if}
          {#if measurement != null}<strong>{formatCadNumber(measurement)} {drawing.unit === 'unknown' ? 'drawing units' : drawing.unit}</strong>{/if}
        </div>
      {/if}
    </div>

    {#if drawing && !compact}
      <aside class="cad2d-inspector" aria-label="2D CAD drawing inspector">
        <section><button type="button" class="cad2d-section-toggle" aria-expanded={!collapsedSections.has('drawing')} onclick={() => toggleSection('drawing')}><h3>Drawing</h3><span aria-hidden="true">{collapsedSections.has('drawing') ? '▸' : '▾'}</span></button>{#if !collapsedSections.has('drawing')}<dl><div><dt>Width</dt><dd>{formatCadNumber(drawing.bounds.maxX - drawing.bounds.minX)}</dd></div><div><dt>Height</dt><dd>{formatCadNumber(drawing.bounds.maxY - drawing.bounds.minY)}</dd></div><div><dt>Units</dt><dd>{drawing.unit === 'unknown' ? 'Not declared' : drawing.unit}</dd></div></dl>{/if}</section>
        <section><div class="cad2d-section-head"><button type="button" class="cad2d-section-toggle" aria-expanded={!collapsedSections.has('layers')} onclick={() => toggleSection('layers')}><h3>Layers</h3><span aria-hidden="true">{collapsedSections.has('layers') ? '▸' : '▾'}</span></button>{#if hiddenLayers.size > 0}<button type="button" onclick={showAllLayers}>All on</button>{/if}</div>{#if !collapsedSections.has('layers')}<div class="cad2d-layers">{#each drawing.layers as layer}<div class="cad2d-layer-row" class:hidden={hiddenLayers.has(layer)} class:soloed={soloLayer === layer}><button type="button" class="cad2d-layer-eye" aria-label={hiddenLayers.has(layer) ? `Show layer ${layer}` : `Hide layer ${layer}`} aria-pressed={!hiddenLayers.has(layer)} onclick={() => toggleLayer(layer)}><span aria-hidden="true">{hiddenLayers.has(layer) ? '🚫' : '👁'}</span></button><span class="cad2d-layer-chip" style={drawing.layerStyles[layer]?.color ? `background:${drawing.layerStyles[layer].color}` : undefined} aria-hidden="true"></span><span class="cad2d-layer-name" title={layer}>{layer}</span><span class="cad2d-layer-count">{layerCounts.get(layer) ?? 0}</span><button type="button" class="cad2d-layer-solo" aria-label={soloLayer === layer ? `Unisolate layer ${layer}` : `Isolate layer ${layer}`} aria-pressed={soloLayer === layer} title={soloLayer === layer ? 'Show all layers' : 'Isolate this layer'} onclick={() => toggleSolo(layer)}>S</button></div>{/each}</div>{/if}</section>
        <section><button type="button" class="cad2d-section-toggle" aria-expanded={!collapsedSections.has('review')} onclick={() => toggleSection('review')}><h3>Review</h3><span aria-hidden="true">{collapsedSections.has('review') ? '▸' : '▾'}</span></button>{#if !collapsedSections.has('review')}<p>Markup is stored separately from the CAD file and anchored in drawing coordinates. {channelId ? 'Channel members viewing this attachment share the same review.' : 'This file has a local review draft on this device.'}</p>{#if reviewSync.error}<p class="review-error">{reviewSync.error}</p>{/if}{/if}</section>
        <section><button type="button" class="cad2d-section-toggle" aria-expanded={!collapsedSections.has('coverage')} onclick={() => toggleSection('coverage')}><h3>Reader coverage</h3><span aria-hidden="true">{collapsedSections.has('coverage') ? '▸' : '▾'}</span></button>{#if !collapsedSections.has('coverage')}<p>Built-in DXF preview: LINE, POLYLINE/LWPOLYLINE, CIRCLE, ARC, POINT, TEXT, MTEXT and DIMENSION.</p>{#if ignoredCount > 0}<p>{ignoredCount.toLocaleString()} unsupported entities were skipped. The original file is unchanged.</p>{/if}{/if}</section>
      </aside>
    {/if}
  </div>
</div>

<style>
  .cad2d-shell { min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;background:var(--surface-app,#10191d);color:var(--text-heading,#e7efef); }
  .cad2d-shell:not(.compact) { flex:1; }
  .cad2d-shell.compact { height:var(--cad-height);min-height:180px; }
  .cad2d-toolbar { display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border-subtle,#34454b);background:var(--surface-base,#172126); }
  .cad2d-title { min-width:0;display:flex;flex-direction:column;gap:2px; }
  .cad2d-title strong { font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .cad2d-title span { font-size:9px;color:var(--text-muted,#a9b9bc); }
  .cad2d-actions { display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end; }
  .cad2d-actions button,.cad2d-section-head button,.cad-review-toolbar button,.cad-review-toolbar select,.cad-review-text-entry button,.cad-review-text-entry input { border:1px solid var(--border-subtle,#43535a);border-radius:6px;background:var(--surface-raised,#26343a);color:inherit;font:inherit;font-size:10px;padding:5px 8px; }
  .cad2d-actions button,.cad-review-toolbar button,.cad-review-text-entry button { cursor:pointer; }
  .cad2d-actions button.active,.cad-review-toolbar button.active { border-color:var(--accent-primary-color,#8fd5c4);background:color-mix(in srgb,var(--accent-primary-color,#8fd5c4) 18%,var(--surface-raised,#26343a)); }
  .cad-review-toolbar { display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--border-subtle,#34454b);background:color-mix(in srgb,var(--surface-base,#172126) 90%,var(--accent-primary-color,#8fd5c4)); }
  .cad-review-tools,.cad-review-palette { display:flex;align-items:center;gap:4px; }
  .cad-review-palette button { width:20px;height:20px;padding:0;border-radius:999px;background:var(--review-swatch);border:2px solid transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2); }
  .cad-review-palette button.active { border-color:#fff;background:var(--review-swatch); }
  .cad-review-toolbar button:disabled { opacity:.38;cursor:default; }
  .cad-review-status { margin-left:auto;font-size:9px;color:var(--text-muted,#a9b9bc); }.cad-review-status.sync-error { color:var(--text-danger,#e5b589); }
  .cad2d-main { flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,240px); }
  .compact .cad2d-main { display:block; }
  .cad2d-canvas-wrap { position:relative;min-height:0;overflow:hidden;background:#0b1317; }
  .cad2d-canvas-wrap svg { width:100%;height:100%;display:block;touch-action:none;cursor:grab; }
  .cad2d-canvas-wrap svg:active { cursor:grabbing; }
  .cad2d-canvas-wrap svg.measure-mode,.cad2d-canvas-wrap svg.review-mode { cursor:crosshair; }
  .cad2d-canvas-wrap svg.review-pan { cursor:grab; }.cad2d-canvas-wrap svg.review-pan:active { cursor:grabbing; }
  .cad-bg { fill:#0b1317; }
  .cad-entity { fill:none;stroke:#d8e6e3;stroke-width:1.15;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round; }
  .cad-point { fill:#d8e6e3;stroke:none;vector-effect:non-scaling-stroke; }
  .cad-text { fill:#c9dbd7;stroke:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none; }
  .review-mark { fill:none;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round;pointer-events:none; }
  .review-text { stroke:none;font-family:var(--font-sans,ui-sans-serif,sans-serif);font-weight:650;paint-order:stroke;stroke:#0b1317;stroke-width:.08em;pointer-events:none; }
  .measure-line { stroke:#89dfc8;stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-dasharray:5 4; }
  .measure-point { fill:#89dfc8;stroke:#0b1317;stroke-width:1;vector-effect:non-scaling-stroke; }
  .cad-review-text-entry { position:absolute;right:12px;top:12px;z-index:5;display:grid;gap:7px;width:min(320px,calc(100% - 24px));padding:10px;border:1px solid var(--border-subtle,#43535a);border-radius:9px;background:rgba(16,25,29,.96);box-shadow:0 12px 30px rgba(0,0,0,.3); }
  .cad-review-text-entry label { font-size:10px;color:var(--text-muted,#a9b9bc); }.cad-review-text-entry input { width:100%;box-sizing:border-box;background:var(--surface-app,#10191d); }.cad-review-text-entry div { display:flex;gap:6px;justify-content:flex-end; }
  .cad2d-state { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:18px;text-align:center;color:var(--text-muted,#a9b9bc);font-size:12px; }
  .cad2d-error strong { color:var(--text-heading,#e7efef); }
  .cad2d-readout { position:absolute;left:8px;bottom:8px;display:flex;gap:8px;flex-wrap:wrap;max-width:calc(100% - 16px);padding:5px 7px;border:1px solid rgba(120,150,150,.25);border-radius:6px;background:rgba(9,18,22,.82);font-size:9px;color:#b9cdca;pointer-events:none; }
  .cad2d-readout strong { color:#9be5d2;font-weight:600; }
  .cad2d-inspector { min-width:0;overflow:auto;border-left:1px solid var(--border-subtle,#34454b);background:var(--surface-base,#172126);padding:10px; }
  .cad2d-inspector section + section { border-top:1px solid var(--border-subtle,#34454b);margin-top:12px;padding-top:12px; }
  .cad2d-inspector h3 { margin:0 0 8px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted,#a9b9bc); }
  .cad2d-inspector p { margin:6px 0 0;font-size:10px;line-height:1.5;color:var(--text-muted,#a9b9bc); }.cad2d-inspector p.review-error { color:var(--text-danger,#e5b589); }
  .cad2d-inspector dl { display:grid;gap:5px;margin:0; }
  .cad2d-inspector dl div { display:flex;justify-content:space-between;gap:8px;font-size:10px; }
  .cad2d-inspector dt { color:var(--text-muted,#a9b9bc); }.cad2d-inspector dd { margin:0; }
  .cad2d-section-head { display:flex;align-items:center;justify-content:space-between;gap:8px; }
  .cad2d-section-toggle { all:unset;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;cursor:pointer;border-radius:4px; }
  .cad2d-section-toggle h3 { margin:0; }.cad2d-section-toggle span { font-size:9px;color:var(--text-muted,#a9b9bc); }
  .cad2d-section-head .cad2d-section-toggle { width:auto;flex:1;min-width:0; }
  .cad2d-layers { display:grid;gap:5px;max-height:220px;overflow:auto; }
  .cad2d-layer-row { display:flex;align-items:center;gap:7px;font-size:10px;min-width:0;padding:2px 4px;border-radius:5px; }.cad2d-layer-row:hover { background:rgba(120,150,150,.08); }
  .cad2d-layer-row.hidden .cad2d-layer-name { opacity:.45;text-decoration:line-through; }.cad2d-layer-row.soloed { background:rgba(143,213,196,.12); }
  .cad2d-layer-eye { all:unset;cursor:pointer;font-size:11px;line-height:1;border-radius:4px; }.cad2d-layer-eye:focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
  .cad2d-layer-chip { width:10px;height:10px;border-radius:3px;background:var(--text-muted,#a9b9bc);flex:none;border:1px solid rgba(255,255,255,.25); }
  .cad2d-layer-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0; }.cad2d-layer-count { color:var(--text-muted,#a9b9bc);font-size:9px;font-variant-numeric:tabular-nums; }
  .cad2d-layer-solo { all:unset;cursor:pointer;font-size:9px;font-weight:700;color:var(--text-muted,#a9b9bc);border:1px solid var(--border-subtle,#43535a);border-radius:4px;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;flex:none; }.cad2d-layer-solo:hover { color:inherit;border-color:var(--accent-primary-color,#8fd5c4); }.cad2d-layer-row.soloed .cad2d-layer-solo { color:#0b1317;background:var(--accent-primary-color,#8fd5c4);border-color:transparent; }
  .cad2d-layers span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  :is(button,input,select):focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
  @media (max-width:700px) { .cad2d-shell:not(.compact) .cad2d-main { grid-template-columns:1fr;grid-template-rows:minmax(260px,1fr) minmax(120px,auto);overflow:auto; }.cad2d-inspector { border-left:0;border-top:1px solid var(--border-subtle,#34454b);max-height:230px; }.cad2d-toolbar { align-items:flex-start;flex-direction:column; }.cad2d-actions { justify-content:flex-start; }.cad-review-status { width:100%;margin-left:0; } }
</style>
