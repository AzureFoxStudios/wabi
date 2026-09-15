/** Adapts model navigation to Wabi's existing tab queue and side-panel runtime. */
import { get, writable } from 'svelte/store';
import { layoutStore } from '$lib/layoutStore';
import { mobileTabQueue } from '$lib/mobileTabQueue';
import { currentChannel } from '$lib/channelStore';
import { MODEL_VIEWPORT_ADDON_ID, openModelViewport, openModelViewportSurface } from '$lib/modelViewportTab';
import { routeModelAsset, type ModelAsset, type ModelDestination } from '$lib/modelAttachmentPolicy';

export const MODEL_WORKSPACE_PANEL_ID = 'model-viewport';
/** Volatile, local-only: only one chat preview owns the renderer at once. */
export const activeModelInlinePreview = writable<string | null>(null);
let previewSequence = 0;
export function allocateModelPreviewId(): string { return `model-inline-${++previewSequence}`; }
export function stopModelInlinePreview(id?: string): void {
  if (id === undefined || get(activeModelInlinePreview) === id) activeModelInlinePreview.set(null);
}

function ensureModelDockOpen(): void {
  const pinned = get(layoutStore.pinnedPanelId);
  const mode = get(layoutStore.rightPanelMode);
  if (mode === 'pinned' && pinned === MODEL_WORKSPACE_PANEL_ID) {
    // openRightPanel() delegates to a toggle: do not call it for an already-pinned model.
    layoutStore.setDisplayedPanel(MODEL_WORKSPACE_PANEL_ID);
  } else {
    layoutStore.openRightPanel(MODEL_WORKSPACE_PANEL_ID);
  }
  // Do not leave a second copy of the same workspace rendering in the center.
  if (get(mobileTabQueue.activeTabId) === mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_ADDON_ID)) {
    const channelId = get(currentChannel);
    if (channelId) mobileTabQueue.setActiveChannel(channelId);
    else mobileTabQueue.closeAddonTab(MODEL_VIEWPORT_ADDON_ID);
  }
}
function showModelWorkspace(): void {
  if (get(layoutStore.pinnedPanelId) === MODEL_WORKSPACE_PANEL_ID) layoutStore.closeRightPanel();
  else if (get(layoutStore.activeRightTab) === MODEL_WORKSPACE_PANEL_ID) layoutStore.dismissPeek();
  layoutStore.closeCenterDm();
  layoutStore.setCenterPanelView('chat');
  openModelViewportSurface();
}
export function openModelAssetAt(asset: ModelAsset, destination: ModelDestination): void {
  routeModelAsset(asset, destination, {
    isMobile: () => get(layoutStore).isMobile,
    select: (next) => openModelViewport(next.src, next.fileName, { activate: false, source: next.source || 'chat' }),
    showWorkspace: showModelWorkspace,
    showDock: ensureModelDockOpen,
    stopInline: () => stopModelInlinePreview()
  });
}
