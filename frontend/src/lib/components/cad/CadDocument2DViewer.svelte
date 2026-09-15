<script lang="ts">
  import { onDestroy } from 'svelte';
  import Cad2DViewer from './Cad2DViewer.svelte';
  import { cadReviewAssetKey } from '$lib/cadReview';
  import { inspectCadDocumentViews, type CadDocumentViews } from '$lib/cadDocumentViews';

  let {
    src,
    fileName = 'Drawing.dxf',
    compact = false,
    height = 460,
    channelId = null,
    sourceIdentity = ''
  }: {
    src: string;
    fileName?: string;
    compact?: boolean;
    height?: number;
    channelId?: string | null;
    sourceIdentity?: string;
  } = $props();

  const MAX_DXF_BYTES = 20 * 1024 * 1024;
  let viewSet = $state<CadDocumentViews | null>(null);
  let activeId = $state('');
  let loading = $state(false);
  let error = $state('');
  let previewSrc = $state('');
  let loadAbort: AbortController | null = null;
  let loadSequence = 0;

  const activeView = $derived(viewSet?.views.find((view) => view.id === activeId) ?? viewSet?.views[0] ?? null);
  const hasViewBar = $derived(Boolean(viewSet && (viewSet.views.length > 1 || viewSet.hasSpatialModel)));
  const hasRepresentationNote = $derived(Boolean(activeView?.kind === 'model' && activeView.hasSpatialEntities));
  const contentHeight = $derived(compact
    ? Math.max(180, height - (hasViewBar ? 42 : 0) - (hasRepresentationNote ? 34 : 0))
    : height);
  const reviewIdentity = $derived.by(() => {
    if (!activeView) return sourceIdentity || src;
    const base = sourceIdentity || src;
    const asset = cadReviewAssetKey(base, fileName);
    // Use an opaque custom URL form so cadReviewAssetKey keeps both the source
    // asset token and the selected Model/Layout id when normalizing identity.
    return `cad-view:${asset}:${encodeURIComponent(activeView.id)}`;
  });

  async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_DXF_BYTES) throw new Error("CAD document is larger than Wabi's 20 MB 2D preview limit.");
    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_DXF_BYTES) throw new Error("CAD document is larger than Wabi's 20 MB 2D preview limit.");
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
        if (total > MAX_DXF_BYTES) throw new Error("CAD document is larger than Wabi's 20 MB 2D preview limit.");
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
    const sequence = ++loadSequence;
    loadAbort?.abort();
    const controller = new AbortController();
    loadAbort = controller;
    loading = true;
    error = '';
    viewSet = null;
    activeId = '';

    void (async () => {
      try {
        const response = await fetch(source, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load CAD document (${response.status}).`);
        const text = await readLimited(response, controller.signal);
        const inspected = inspectCadDocumentViews(text);
        if (sequence !== loadSequence || controller.signal.aborted) return;
        viewSet = inspected;
        activeId = inspected.views.find((view) => view.kind === 'model')?.id ?? inspected.views[0]?.id ?? '';
      } catch (reason) {
        if (controller.signal.aborted || sequence !== loadSequence) return;
        error = reason instanceof Error ? reason.message : 'Could not inspect CAD document views.';
      } finally {
        if (sequence === loadSequence && !controller.signal.aborted) loading = false;
      }
    })();

    return () => controller.abort();
  });

  $effect(() => {
    const text = activeView?.text;
    if (!text) {
      previewSrc = '';
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    previewSrc = url;
    return () => URL.revokeObjectURL(url);
  });

  onDestroy(() => loadAbort?.abort());
</script>

<div class="cad-document-shell" class:compact>
  {#if loading}
    <div class="document-state" role="status">Inspecting CAD document views…</div>
  {:else if error}
    <div class="document-state error" role="alert"><strong>CAD document preview unavailable</strong><span>{error}</span></div>
  {:else if viewSet && activeView}
    {#if hasViewBar}
      <div class="document-viewbar" aria-label="CAD document views">
        <div class="view-tabs" role="tablist" aria-label="Model and drawing layouts">
          {#each viewSet.views as view (view.id)}
            <button
              type="button"
              role="tab"
              aria-selected={activeView.id === view.id}
              class:active={activeView.id === view.id}
              onclick={() => (activeId = view.id)}
              title={view.kind === 'model' && view.hasSpatialEntities ? `${view.name}: spatial model content detected` : view.name}
            >
              <span>{view.name}</span>
              {#if view.kind === 'model' && view.hasSpatialEntities}
                <small>{viewSet.modelDimensionality === 'mixed' ? '2D + 3D' : '3D'}</small>
              {:else if view.kind === 'layout'}<small>Sheet</small>{/if}
            </button>
          {/each}
        </div>
        {#if viewSet.hasSpatialModel}
          <span class="spatial-summary" title={viewSet.spatialEntityTypes.join(', ')}>
            Spatial model detected
          </span>
        {/if}
      </div>
    {/if}

    {#if hasRepresentationNote}
      <div class="representation-note" class:spatial-only={!activeView.previewable2d}>
        <div>
          <strong>{viewSet.modelDimensionality === 'mixed' ? 'Model Space contains both 2D and 3D geometry' : '3D Model Space detected'}</strong>
          {#if activeView.previewable2d}
            <span>Wabi is showing the readable 2D projection below; it is not pretending that projection is the complete 3D model.</span>
          {:else}
            <span>This model has spatial entities but no supported 2D projection to display.</span>
          {/if}
        </div>
        <small>{activeView.spatialEntityTypes.join(' · ')}</small>
      </div>
    {/if}

    {#if activeView.previewable2d && previewSrc}
      <Cad2DViewer
        src={previewSrc}
        fileName={viewSet.views.length > 1 ? `${fileName} · ${activeView.name}` : fileName}
        {compact}
        height={contentHeight}
        {channelId}
        sourceIdentity={reviewIdentity}
        allowConvertedSource
      />
    {:else if activeView.hasSpatialEntities}
      <div class="spatial-placeholder" role="status">
        <strong>3D representation needs a solid-model importer</strong>
        <span>Wabi detected real spatial CAD content in this view. For a full solid preview, attach/export STEP, IGES or 3MF alongside the DWG/DXF. Paper Space layouts remain available above.</span>
      </div>
    {:else}
      <div class="document-state"><strong>No readable 2D entities in {activeView.name}</strong><span>The view exists in the CAD document, but its entity types are not supported by Wabi's current 2D renderer.</span></div>
    {/if}
  {/if}
</div>

<style>
  .cad-document-shell { min-width:0;background:var(--surface-app,#10191d);color:var(--text-heading,#e7efef); }
  .document-viewbar { display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--border-subtle,#304047);background:var(--surface-base,#172126);min-width:0; }
  .view-tabs { display:flex;align-items:center;gap:4px;overflow-x:auto;min-width:0;scrollbar-width:thin; }
  .view-tabs button { display:flex;align-items:center;gap:6px;flex:0 0 auto;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--text-muted,#a9b9bc);font:inherit;font-size:10px;min-height:30px;padding:5px 8px;cursor:pointer; }
  .view-tabs button:hover { color:var(--text-heading,#e7efef);background:var(--surface-raised,#223138); }
  .view-tabs button.active { color:var(--text-heading,#e7efef);border-color:var(--accent-primary-color,#78c7b8);background:color-mix(in srgb,var(--accent-primary-color,#78c7b8) 12%,transparent); }
  .view-tabs small { border-radius:999px;padding:2px 5px;background:var(--surface-raised,#24343b);color:var(--text-muted,#a9b9bc);font-size:8px;text-transform:uppercase;letter-spacing:.05em; }
  .spatial-summary { flex:0 0 auto;border:1px solid #b18b4d55;border-radius:999px;background:#b18b4d18;color:#e4c68e;padding:4px 7px;font-size:9px;white-space:nowrap; }
  .representation-note { display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-bottom:1px solid #b18b4d44;background:#b18b4d0d;color:var(--text-heading,#e7efef); }
  .representation-note>div { min-width:0; }.representation-note strong { display:block;font-size:10px; }.representation-note span { display:block;margin-top:3px;color:var(--text-muted,#a9b9bc);font-size:9px;line-height:1.4; }
  .representation-note>small { flex:0 0 auto;max-width:35%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d7ba83;font-size:8px; }
  .representation-note.spatial-only { border-bottom:0; }
  .spatial-placeholder,.document-state { min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:20px;text-align:center;background:radial-gradient(circle at 25% 20%,rgba(98,168,156,.12),transparent 45%),var(--surface-app,#10191d); }
  .spatial-placeholder strong,.document-state strong { font-size:12px; }.spatial-placeholder span,.document-state span { max-width:620px;color:var(--text-muted,#a9b9bc);font-size:10px;line-height:1.5; }
  .document-state.error { color:var(--text-danger,#e5b589); }
  .compact .document-viewbar { padding:5px 6px; }.compact .representation-note { padding:6px 8px; }.compact .representation-note span { display:none; }
  button:focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:2px; }
</style>
