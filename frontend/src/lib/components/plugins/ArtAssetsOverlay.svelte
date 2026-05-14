<script lang="ts">
  import { onMount } from 'svelte';
  import { getSocket } from '$lib/socket';

  interface AssetTransform {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    opacity: number;
    scaleX: number;
    scaleY: number;
    zIndex: number;
  }

  interface OverlayAsset {
    id: string;
    kind: 'image' | 'video' | 'gif' | 'shape' | 'text';
    name: string;
    source?: string;
    text?: string;
    locked: boolean;
    visible: boolean;
    transform: AssetTransform;
  }

  interface ScenePreset {
    id: string;
    name: string;
  }

  interface OverlayRoom {
    channelId: string;
    mode: 'open' | 'presenter';
    presenterUserId?: string;
    assets: OverlayAsset[];
    scenes: ScenePreset[];
    updatedAt: number;
    updatedBy?: string;
  }

  export let channelId: string;
  export let enabled = false;

  let room: OverlayRoom | null = null;
  let selectedAssetId: string | null = null;
  let draggingAssetId: string | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let showSafeZones = false;

  const socket = getSocket();

  $: canEdit = Boolean(socket && room && (room.mode === 'open' || !room.presenterUserId || room.presenterUserId === socket.id));

  function emitAsset(event: string, payload: Record<string, any>): void {
    if (!socket || !channelId) return;
    socket.emit(event, { channelId, ...payload });
  }

  function requestState(): void {
    if (!socket || !channelId) return;
    socket.emit('asset:get-state', { channelId });
  }

  function onAssetState(state: OverlayRoom): void {
    if (!state || state.channelId !== channelId) return;
    room = state;
  }

  function onAssetError(payload: { message?: string }): void {
    if (payload?.message) {
      console.warn('[art-assets]', payload.message);
    }
  }

  function getAssetStyle(asset: OverlayAsset): string {
    const t = asset.transform;
    return [
      `left:${t.x}px`,
      `top:${t.y}px`,
      `width:${t.width}px`,
      `height:${t.height}px`,
      `opacity:${t.opacity}`,
      `z-index:${t.zIndex}`,
      `transform:rotate(${t.rotation}deg) scale(${t.scaleX},${t.scaleY})`,
      `display:${asset.visible ? 'block' : 'none'}`
    ].join(';');
  }

  function startDrag(event: PointerEvent, asset: OverlayAsset): void {
    if (!canEdit || asset.locked) return;

    draggingAssetId = asset.id;
    selectedAssetId = asset.id;
    dragOffsetX = event.clientX - asset.transform.x;
    dragOffsetY = event.clientY - asset.transform.y;

    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', endDrag);
  }

  function handleDragMove(event: PointerEvent): void {
    if (!draggingAssetId || !room) return;
    const idx = room.assets.findIndex((a) => a.id === draggingAssetId);
    if (idx < 0) return;

    const current = room.assets[idx];
    const nextX = Math.max(0, Math.round(event.clientX - dragOffsetX));
    const nextY = Math.max(0, Math.round(event.clientY - dragOffsetY));

    const updated: OverlayAsset = {
      ...current,
      transform: {
        ...current.transform,
        x: nextX,
        y: nextY
      }
    };

    room = {
      ...room,
      assets: [...room.assets.slice(0, idx), updated, ...room.assets.slice(idx + 1)]
    };
  }

  function endDrag(): void {
    if (!draggingAssetId || !room) {
      draggingAssetId = null;
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', endDrag);
      return;
    }

    const asset = room.assets.find((a) => a.id === draggingAssetId);
    if (asset) {
      emitAsset('asset:update', {
        assetId: asset.id,
        transform: {
          x: asset.transform.x,
          y: asset.transform.y
        }
      });
    }

    draggingAssetId = null;
    window.removeEventListener('pointermove', handleDragMove);
    window.removeEventListener('pointerup', endDrag);
  }

  function addImageAsset(): void {
    if (!canEdit) return;
    const source = window.prompt('Asset URL (image/gif/video):');
    if (!source) return;
    const name = window.prompt('Asset name:', 'Overlay Asset') || 'Overlay Asset';

    emitAsset('asset:add', {
      kind: 'image',
      source,
      name,
      transform: {
        x: 120,
        y: 120,
        width: 320,
        height: 180,
        zIndex: (room?.assets.length || 0) + 1
      }
    });
  }

  function saveScene(): void {
    if (!canEdit) return;
    const name = window.prompt('Scene name:', 'Scene');
    if (!name) return;
    emitAsset('asset:scene:save', { name });
  }

  function loadScene(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!value) return;
    emitAsset('asset:scene:load', { sceneId: value });
  }

  function toggleAssetLock(asset: OverlayAsset): void {
    if (!canEdit) return;
    emitAsset('asset:lock', { assetId: asset.id, locked: !asset.locked });
  }

  function toggleAssetVisibility(asset: OverlayAsset): void {
    if (!canEdit) return;
    emitAsset('asset:toggle-visible', { assetId: asset.id, visible: !asset.visible });
  }

  function removeAsset(asset: OverlayAsset): void {
    if (!canEdit) return;
    emitAsset('asset:remove', { assetId: asset.id });
    if (selectedAssetId === asset.id) selectedAssetId = null;
  }

  onMount(() => {
    if (!socket) return;
    socket.on('asset:state', onAssetState);
    socket.on('asset:error', onAssetError);
    requestState();

    return () => {
      socket.off('asset:state', onAssetState);
      socket.off('asset:error', onAssetError);
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', endDrag);
    };
  });

  $: if (enabled && socket) {
    requestState();
  }
</script>

{#if enabled}
  <div class="asset-overlay">
    <div class="overlay-toolbar">
      <button type="button" on:click={addImageAsset} disabled={!canEdit}>Add Asset</button>
      <button type="button" on:click={saveScene} disabled={!canEdit}>Save Scene</button>
      <button type="button" on:click={() => (showSafeZones = !showSafeZones)}>
        {showSafeZones ? 'Hide Safe Zones' : 'Show Safe Zones'}
      </button>
      <select on:change={loadScene} disabled={!room || room.scenes.length === 0 || !canEdit}>
        <option value="">Load Scene</option>
        {#if room}
          {#each room.scenes as scene}
            <option value={scene.id}>{scene.name}</option>
          {/each}
        {/if}
      </select>
    </div>

    {#if room}
      <div class="asset-layer">
        {#if showSafeZones}
          <div class="safe-zone safe-zone-action"></div>
          <div class="safe-zone safe-zone-title"></div>
        {/if}
        {#each room.assets as asset (asset.id)}
          <div
            class="asset-item"
            class:selected={selectedAssetId === asset.id}
            style={getAssetStyle(asset)}
            role="button"
            tabindex="0"
            aria-label={`Select asset ${asset.name}`}
            on:pointerdown={(event) => startDrag(event, asset)}
            on:click={() => (selectedAssetId = asset.id)}
            on:keydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectedAssetId = asset.id;
              }
            }}
          >
            {#if asset.kind === 'text'}
              <div class="asset-text">{asset.text || asset.name}</div>
            {:else if asset.source}
              <img src={asset.source} alt={asset.name} draggable="false" />
            {:else}
              <div class="asset-placeholder">{asset.name}</div>
            {/if}

            {#if selectedAssetId === asset.id}
              <div class="asset-actions">
                <button type="button" on:click|stopPropagation={() => toggleAssetLock(asset)}>{asset.locked ? 'Unlock' : 'Lock'}</button>
                <button type="button" on:click|stopPropagation={() => toggleAssetVisibility(asset)}>{asset.visible ? 'Hide' : 'Show'}</button>
                <button type="button" on:click|stopPropagation={() => removeAsset(asset)}>Remove</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .asset-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }

  .overlay-toolbar {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    display: flex;
    gap: 0.4rem;
    pointer-events: auto;
    background: rgba(5, 8, 18, 0.8);
    border: 1px solid rgba(148, 163, 184, 0.3);
    border-radius: 8px;
    padding: 0.35rem;
  }

  .overlay-toolbar button,
  .overlay-toolbar select {
    font-size: 0.72rem;
    padding: 0.3rem 0.45rem;
    border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.35);
    background: rgba(15, 23, 42, 0.9);
    color: #e2e8f0;
  }

  .asset-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .asset-item {
    position: absolute;
    pointer-events: auto;
    border: 1px dashed transparent;
    user-select: none;
    cursor: move;
  }

  .safe-zone {
    position: absolute;
    pointer-events: none;
    border: 1px dashed rgba(248, 250, 252, 0.6);
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.5) inset;
  }

  .safe-zone-action {
    inset: 5%;
  }

  .safe-zone-title {
    inset: 10%;
    border-color: rgba(56, 189, 248, 0.7);
  }

  .asset-item.selected {
    border-color: rgba(56, 189, 248, 0.9);
  }

  .asset-item img,
  .asset-text,
  .asset-placeholder {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: grid;
    place-items: center;
    color: #f8fafc;
    background: rgba(15, 23, 42, 0.15);
  }

  .asset-actions {
    position: absolute;
    top: -1.9rem;
    left: 0;
    display: flex;
    gap: 0.3rem;
    background: rgba(2, 6, 23, 0.88);
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 6px;
    padding: 0.2rem;
  }

  .asset-actions button {
    font-size: 0.68rem;
    padding: 0.2rem 0.35rem;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(15, 23, 42, 0.9);
    color: #e2e8f0;
  }
</style>
