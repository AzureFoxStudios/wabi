<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import { get } from 'svelte/store';
  import { currentChannel } from '$lib/channelStore';
  import { isDesktopTauri } from '$lib/tauri-platform';
  import { openNativeModelViewer } from '$lib/tauri-model-viewer';
  import { hasAddonCapability } from '$lib/addonInventory';
  import { loadAddon } from '$lib/addons/loader';
  import CadDocument2DViewer from '$lib/components/cad/CadDocument2DViewer.svelte';
  import DwgCadViewer from '$lib/components/cad/DwgCadViewer.svelte';
  import OcctCadViewer from '$lib/components/plugins/OcctCadViewer.svelte';
  import ThreeMFViewer from '$lib/components/plugins/ThreeMFViewer.svelte';
  import ModelOpenMenu from '$lib/components/ModelOpenMenu.svelte';
  import { openModelAssetAt } from '$lib/modelOpenActions';
  import {
    missingModelSupport,
    modelExtension,
    modelFamily,
    modelPreviewKind,
    modelWorkspaceLabel,
    safeModelSource,
    type ModelAsset
  } from '$lib/modelAttachmentPolicy';

  let {
    src, fileName = '3D model', height = 320, fullBleed = false, lazyLoad = true, hideUi = $bindable(false)
  }: {
    src: string; fileName?: string; height?: number; fullBleed?: boolean; lazyLoad?: boolean; hideUi?: boolean;
  } = $props();

  const isTauriBuild = __WABI_IS_TAURI__;
  const desktop = isDesktopTauri();
  // Capture the channel that owned this launcher. A CAD review must not jump
  // boards merely because the user later changes the active chat channel.
  const reviewChannelId = get(currentChannel) || null;
  let ThreeViewer = $state.raw<Component<any> | null>(null);
  let resolvingThree = $state(true);
  let launchError = $state('');
  let launching = $state(false);
  let nativeError = $state('');
  let previewAttempt = $state(0);
  let cadPreviewActive = $state(false);
  let openMenu = $state<any>();

  // "Hide preview" collapses the viewer to just the file, and the choice is remembered per file on this device.
  const hiddenKey = (source: string) => `wabi:model-preview-hidden:${source}`;
  let previewHidden = $state(false);
  $effect(() => {
    const source = src;
    try { previewHidden = localStorage.getItem(hiddenKey(source)) === '1'; } catch { previewHidden = false; }
  });
  function setPreviewHidden(next: boolean): void {
    previewHidden = next;
    try { if (next) localStorage.setItem(hiddenKey(src), '1'); else localStorage.removeItem(hiddenKey(src)); } catch { /* remembered for this session only */ }
  }

  const selectionKey = $derived(`${src}\u0000${fileName}`);
  const previewKind = $derived(modelPreviewKind(fileName));
  const supportMessage = $derived(missingModelSupport(fileName));
  const safeSrc = $derived(safeModelSource(src));
  const family = $derived(modelFamily(fileName));
  const ext = $derived(modelExtension(fileName));
  const asset = $derived<ModelAsset>({ src, fileName, source: 'chat' });

  $effect(() => {
    // The same dock can display a new asset without remounting this launcher.
    void selectionKey;
    nativeError = '';
    launching = false;
    cadPreviewActive = !lazyLoad;
  });

  onMount(() => {
    let gone = false;
    async function resolve(): Promise<void> {
      // CAD formats use dedicated adapters and unsupported CAD/MMD stays as an
      // honest compatibility card; none of those paths need ModelViewer3D here.
      if (previewKind !== 'mesh-3d') {
        resolvingThree = false;
        return;
      }
      try {
        if (isTauriBuild) {
          // Preserve the native-first desktop boundary. Never remote-import a server URL.
          if (await hasAddonCapability('model-viewer')) {
            const instance = await loadAddon('model-viewer');
            const module = instance?.frontendModule;
            if (!gone && module?.default) ThreeViewer = module.default as Component<any>;
          }
        } else {
          const module = await import('$lib/components/plugins/ModelViewer3D.svelte');
          if (!gone) ThreeViewer = module.default as Component<any>;
        }
      } catch {
        if (!gone) launchError = 'The in-page viewer could not be loaded. Close and reopen this preview to retry.';
      } finally {
        if (!gone) resolvingThree = false;
      }
    }
    void resolve();
    return () => { gone = true; };
  });

  async function launchNative(): Promise<void> {
    if (launching || previewKind !== 'mesh-3d') return;
    const key = selectionKey;
    launching = true;
    nativeError = '';
    try {
      const opened = await openNativeModelViewer(src, fileName);
      if (key === selectionKey && !opened) nativeError = 'The desktop viewer could not open this file. Check that this desktop build supports the format.';
    } catch {
      if (key === selectionKey) nativeError = 'The desktop viewer did not open. The original file is unchanged.';
    } finally {
      if (key === selectionKey) launching = false;
    }
  }

  function openWorkspace(): void {
    if (!safeSrc) return;
    try { openModelAssetAt(asset, { kind: 'workspace' }); }
    catch (error) { launchError = error instanceof Error ? error.message : 'The workspace could not be opened.'; }
  }

  function handleContextMenu(event: MouseEvent): void {
    if (fullBleed || !safeSrc) return;
    const target = event.target as HTMLElement | null;
    // Right-drag on the actual 3D canvas must remain camera pan, not file actions.
    if (target?.closest('canvas')) return;
    void openMenu?.open(event);
  }
</script>

<div class="model-launcher" class:full-bleed={fullBleed} oncontextmenu={handleContextMenu}>
  {#if !fullBleed && safeSrc}
    <!-- Left-aligned on purpose: the message's hover actions float at the top right and used to cover these. -->
    <div class="model-file-toolbar">
      <span class="model-file-name" title={fileName}><b>{ext.toUpperCase() || 'MODEL'}</b>{fileName}</span>
      <span class="model-file-actions">
        <button class="model-workspace-open" type="button" onclick={openWorkspace}>{modelWorkspaceLabel(fileName)}</button>
        <button class="model-workspace-open" type="button" aria-pressed={!previewHidden} onclick={() => setPreviewHidden(!previewHidden)}>{previewHidden ? 'Show preview' : 'Hide preview'}</button>
        <ModelOpenMenu bind:this={openMenu} {asset} showSourceLink />
      </span>
    </div>
  {/if}

  {#if !safeSrc}
    <div class="model-support-card" role="alert"><strong>Preview unavailable</strong><p>This attachment does not have a safe model source.</p></div>
  {:else if previewHidden && !fullBleed}
    <!-- preview closed: the toolbar above is the whole attachment -->
  {:else if supportMessage}
    <div class="model-support-card">
      <span class="model-support-label">{family === 'cad' ? 'CAD IMPORTER REQUIRED' : family === 'mmd' ? 'MMD ADD-ON REQUIRED' : 'MODEL SUPPORT REQUIRED'}</span>
      <strong title={fileName}>{fileName}</strong>
      <p>{supportMessage}</p>
    </div>
  {:else if previewKind === 'cad-2d'}
    {#if ext === 'dwg'}
      <DwgCadViewer {src} {fileName} {height} {fullBleed} {lazyLoad} channelId={reviewChannelId} />
    {:else if cadPreviewActive}
      <CadDocument2DViewer {src} {fileName} {height} compact={!fullBleed} channelId={reviewChannelId} />
    {:else}
      <button class="cad-preview-activation" type="button" onclick={() => (cadPreviewActive = true)}>
        <span>Activate CAD document preview</span>
        <small>{fileName} · Wabi separates Model Space and Paper Space layouts when present</small>
      </button>
    {/if}
  {:else if previewKind === 'cad-3d'}
    {#if ext === '3mf'}
      <ThreeMFViewer {src} {fileName} {height} {fullBleed} {lazyLoad} bind:hideUi />
    {:else}
      <OcctCadViewer {src} {fileName} {height} {fullBleed} {lazyLoad} bind:hideUi />
    {/if}
  {:else}
    {#if desktop}
      <div class="model-native-card">
        <div class="model-native-copy"><span class="model-native-label">Desktop 3D viewer</span><strong title={fileName}>{fileName}</strong><p>Opens in the native viewer. Available inspection tools depend on your desktop build.</p></div>
        <button class="model-native-open" type="button" onclick={launchNative} disabled={launching}>{launching ? 'Opening…' : 'Open native viewer'}</button>
        {#if nativeError}<p class="model-launch-error" role="alert">{nativeError}</p>{/if}
      </div>
    {/if}

    {#if !resolvingThree && ThreeViewer}
      {#key `${selectionKey}\u0000${previewAttempt}`}
        <ThreeViewer {src} {fileName} {height} {fullBleed} {lazyLoad} bind:hideUi onRetry={() => { previewAttempt += 1; }} />
      {/key}
    {:else if !desktop && resolvingThree}
      <div class="model-launch-status" role="status">Opening model viewer…</div>
    {:else if !desktop && launchError}
      <div class="model-launch-status model-launch-error" role="alert">{launchError}</div>
    {/if}
  {/if}
</div>

<style>
  .model-launcher { position:relative;min-width:0; }
  .model-launcher.full-bleed { flex:1;min-height:0;display:flex;flex-direction:column; }
  .model-launcher.full-bleed > :global(*) { flex:1;min-height:0; }
  .model-file-toolbar { display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:6px 14px;padding:6px 0; }
  .model-file-name { display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;font:500 12px/1.3 var(--w-mono,monospace);color:var(--w-text,var(--text-heading,#e8f1f2));overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .model-file-name b { padding:1px 6px;border:var(--w-bw,1px) solid var(--w-line-strong,#35474e);border-radius:calc(5px * var(--w-rs,1));font:600 10.5px/1.5 var(--w-mono,monospace);letter-spacing:.06em;color:var(--w-mute,#a9b9bc); }
  .model-file-actions { display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px; }
  /* leave the corner free for the message's hover actions */
  @media (hover:hover) { .model-file-toolbar { padding-right:176px; } }
  .model-workspace-open { border:var(--w-bw,1px) solid var(--w-line-strong,#35474e);border-radius:calc(9px * var(--w-rs,1));background:transparent;color:var(--w-text,#e8f1f2);font:600 12px/1.2 var(--w-sans,inherit);min-height:32px;padding:5px 12px;cursor:pointer; }
  .model-workspace-open:hover { background:var(--w-raise,#24343b);border-color:var(--w-accent,#8fd5c4); }
  /* The legacy chat renderer adds a sibling "Open 3D Tab" button. This launcher now owns the primary workspace action. */
  :global(.model-container:has(> .model-launcher) > .open-viewport-btn),
  :global(.gallery-file-item.model-item:has(.model-launcher) > .open-viewport-btn),
  :global(.embedded-model-container:has(> .model-launcher) > .open-viewport-btn) { display:none !important; }
  .model-native-card,.model-support-card { display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px;margin:10px;border:1px solid var(--border-subtle,#34454b);border-radius:12px;background:var(--surface-base,#172126);color:var(--text-heading,#e7efef);min-width:0; }
  .model-native-copy,.model-support-card { flex:1 1 200px;min-width:0; }
  .model-native-label,.model-support-label { display:block;margin-bottom:6px;color:var(--text-muted,#a9b9bc);font-size:10px;letter-spacing:.08em;text-transform:uppercase; }
  .model-native-copy strong,.model-support-card strong { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px; }
  .model-native-copy p,.model-support-card p { margin:8px 0 0;color:var(--text-muted,#a9b9bc);line-height:1.55;font-size:12px; }
  .model-native-open { border:1px solid var(--border-subtle,#34454b);background:var(--surface-raised,#263a3f);color:var(--text-heading,#e7efef);border-radius:8px;padding:10px 14px;min-height:40px;font:inherit;font-size:12px;cursor:pointer; }
  .model-native-open:focus-visible,.cad-preview-activation:focus-visible,.model-workspace-open:focus-visible { outline:2px solid var(--accent-primary-color,#78c7b8);outline-offset:3px; }
  .model-native-open:disabled { opacity:.6;cursor:progress; }
  .model-launch-error { width:100%;color:var(--text-danger,#e5b589);font-size:12px;line-height:1.5;margin:0; }
  .model-launch-status { padding:20px;color:var(--text-muted,#a9b9bc);font-size:12px; }
  .model-support-card { display:block; }
  .cad-preview-activation { width:100%;min-height:180px;border:1px solid var(--border-subtle,#34454b);border-radius:10px;background:radial-gradient(circle at 20% 20%,rgba(98,168,156,.15),transparent 45%),var(--surface-app,#10191d);color:var(--text-heading,#e7efef);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;cursor:pointer;padding:18px; }
  .cad-preview-activation span { font-size:13px;font-weight:650; }.cad-preview-activation small { color:var(--text-muted,#a9b9bc);font-size:10px;text-align:center; }
</style>
