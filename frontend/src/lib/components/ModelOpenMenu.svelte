<script lang="ts">
  import { tick } from 'svelte';
  import { layoutStore } from '$lib/layoutStore';
  import { activeServerUrl } from '$lib/serverUrl';
  import { openModelAssetAt } from '$lib/modelOpenActions';
  import { clampModelMenu, modelFamily, modelWorkspaceLabel, trapModelMenuTab, safeModelSource, type ModelAsset, type ModelDestination } from '$lib/modelAttachmentPolicy';

  let { asset, disabled = false, onError = (_message: string) => {}, onDownload, onStopPreview, showSourceLink = false }:
    { asset: ModelAsset; disabled?: boolean; onError?: (message: string) => void;
      onDownload?: () => void | Promise<void>; onStopPreview?: () => void;
      showSourceLink?: boolean } = $props();
  let dialog = $state<HTMLDialogElement>();
  let trigger = $state<HTMLButtonElement>();
  let left = $state(8);
  let top = $state(8);
  let isOpen = $state(false);
  const mobile = $derived(Boolean($layoutStore.isMobile));
  const sourceUrl = $derived(safeModelSource(asset.src));
  const blocked = $derived(disabled || !sourceUrl);
  const cadAsset = $derived(modelFamily(asset.fileName) === 'cad');

  $effect(() => {
    // A menu must not silently change its target while open (new file/server or a re-hidden spoiler).
    void asset.src; void asset.fileName; void disabled; void $activeServerUrl;
    dialog?.close();
  });
  export async function open(event?: MouseEvent | KeyboardEvent): Promise<void> {
    if (blocked || !dialog) return;
    event?.preventDefault(); event?.stopPropagation();
    const rect = trigger?.getBoundingClientRect();
    const usePointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0);
    const x = usePointer ? event.clientX : rect?.left ?? 8;
    const y = usePointer ? event.clientY : rect?.bottom ?? 8;
    left = 8; top = 8;
    if (!dialog.open) dialog.showModal();
    isOpen = true;
    await tick();
    const size = dialog.getBoundingClientRect();
    ({ left, top } = clampModelMenu(x, y, size.width, size.height, window.innerWidth, window.innerHeight));
    dialog.querySelector<HTMLButtonElement>('button[data-primary]')?.focus();
  }
  function choose(destination: ModelDestination): void {
    if (blocked) { dialog?.close(); return; }
    dialog?.close();
    try { openModelAssetAt(asset, destination); onError(''); }
    catch (error) { onError(error instanceof Error ? error.message : 'The model workspace could not be opened.'); }
  }
  async function runFileAction(action: () => void | Promise<void>): Promise<void> {
    if (blocked) { dialog?.close(); return; }
    dialog?.close();
    try { await action(); onError(''); }
    catch (error) { onError(error instanceof Error ? error.message : 'The file action could not be completed.'); }
  }
  function dismissBackdrop(event: MouseEvent): void {
    if (event.target !== dialog || !dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  }
</script>

<button class="model-location-trigger" type="button" bind:this={trigger} disabled={blocked}
  onclick={(event) => void open(event)} title={cadAsset ? 'CAD actions' : 'Model actions'} aria-label={cadAsset ? 'CAD actions' : 'Model actions'} aria-haspopup="dialog" aria-expanded={isOpen}>
  <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
</button>

<dialog bind:this={dialog} class="model-open-menu" aria-label={cadAsset ? 'CAD workspace actions' : 'Model workspace actions'}
  style:left={`${left}px`} style:top={`${top}px`} onclose={() => { isOpen = false; }} onclick={dismissBackdrop} onkeydown={(event) => dialog && trapModelMenuTab(event, dialog)}>
  <div class="model-menu-heading"><div><small>{cadAsset ? 'CAD ACTIONS' : 'MODEL ACTIONS'}</small><strong title={asset.fileName}>{asset.fileName}</strong></div><button type="button" aria-label={cadAsset ? 'Close CAD actions' : 'Close model actions'} onclick={() => dialog?.close()}>×</button></div>
  <div class="model-menu-actions">
    <button data-primary type="button" disabled={blocked} onclick={() => choose({ kind: 'workspace' })}>{modelWorkspaceLabel(asset.fileName)}<span>Inspect in the main area</span></button>
    {#if !mobile}<button type="button" disabled={blocked} onclick={() => choose({ kind: 'dock' })}>Dock beside chat<span>Keep the conversation visible</span></button>{/if}
  </div>
  {#if onStopPreview || onDownload || (showSourceLink && sourceUrl)}
    <div class="model-menu-file-actions">
      {#if onStopPreview}<button type="button" disabled={blocked} onclick={() => onStopPreview && void runFileAction(onStopPreview)}>Stop preview</button>{/if}
      {#if onDownload}<button type="button" disabled={blocked} onclick={() => onDownload && void runFileAction(onDownload)}>Download original</button>
      {:else if showSourceLink && sourceUrl && !disabled}<a href={sourceUrl} target="_blank" rel="noopener noreferrer" onclick={() => dialog?.close()}>View source file ↗</a>{/if}
    </div>
  {/if}
  {#if mobile}<p class="model-menu-footnote">Side docking is hidden on this screen. The full CAD/model workspace is available.</p>{/if}
</dialog>

<style>
  .model-location-trigger { display:inline-flex;align-items:center;justify-content:center;flex:0 0 34px;width:34px;border:1px solid var(--border-subtle,#35474e);border-radius:7px;background:var(--surface-raised,#24343b);color:var(--text-heading,#e8f1f2);font:inherit;font-size:12px;min-height:34px;padding:6px;cursor:pointer;white-space:nowrap; }
  button:disabled { opacity:.48;cursor:not-allowed; }
  .model-open-menu { position:fixed;margin:0;box-sizing:border-box;width:min(316px,calc(100vw - 16px));max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;border:1px solid var(--border-subtle,#43535a);padding:12px;border-radius:12px;background:var(--surface-base,#17262d);color:var(--text-heading,#e8f1f2);box-shadow:0 16px 55px #0005; }
  .model-open-menu::backdrop { background:transparent; }
  .model-menu-heading { display:flex;gap:12px;justify-content:space-between;align-items:flex-start;margin-bottom:10px; }
  .model-menu-heading>div { min-width:0; }
  .model-menu-heading small { display:block;font-size:9px;letter-spacing:.12em;color:var(--text-muted,#a8bcc4);margin:1px 0 5px; }
  .model-menu-heading strong { display:block;font-size:12px;overflow-wrap:anywhere; }
  .model-menu-heading>button { flex-shrink:0;border:0;background:transparent;color:inherit;min-width:30px;min-height:30px;border-radius:5px;font-size:20px;cursor:pointer; }
  .model-menu-actions { display:grid;gap:5px; }
  .model-menu-actions>button,.model-menu-file-actions>button,.model-menu-file-actions>a { text-align:left;padding:10px;border:1px solid var(--border-subtle,#35474e);border-radius:8px;background:var(--surface-raised,#24343b);color:inherit;font:inherit;font-size:12px;cursor:pointer;text-decoration:none; }
  .model-menu-actions span { display:block;font-size:10px;color:var(--text-muted,#a8bcc4);margin-top:4px; }
  .model-menu-file-actions { display:grid;gap:5px;border-top:1px solid var(--border-subtle,#35474e);padding-top:8px;margin-top:8px; }
  .model-menu-footnote { margin:8px 0;color:var(--text-muted,#a8bcc4);font-size:10px;line-height:1.5; }
  button:focus-visible,a:focus-visible { outline:2px solid var(--accent-primary-color,#8fd5c4);outline-offset:2px; }
  .model-menu-actions>button:hover:not(:disabled) { border-color:var(--accent-primary-color,#8fd5c4); }
</style>
