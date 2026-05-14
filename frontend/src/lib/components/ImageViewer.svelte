<script lang="ts">
  export let src = '';
  export let alt = 'Image';
  export let onClose: () => void = () => {};

  let zoom = 1;

  function zoomIn() {
    zoom = Math.min(3, zoom + 0.25);
  }

  function zoomOut() {
    zoom = Math.max(0.25, zoom - 0.25);
  }

  function resetZoom() {
    zoom = 1;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!src) return;
    if (event.key === 'Escape') onClose();
  }

  function handleOverlayKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClose();
    }
  }

  $: if (src) {
    resetZoom();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<style>
  .viewer-overlay{ position: fixed; inset:0; background: radial-gradient(circle at 20% 12%, rgba(var(--accent-rgb), .2), transparent 34%), rgba(2,6,23,.86); display:flex; align-items:center; justify-content:center; z-index: var(--z-lightbox, 12000); padding:1rem; backdrop-filter: blur(14px) saturate(1.08); }
  .viewer-panel{ background:rgba(15,23,42,.92); border:1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.24); padding:12px; border-radius:18px; max-width:min(1100px,100%); max-height:94dvh; overflow:auto; display:flex; flex-direction:column; align-items:center; box-shadow:0 28px 70px var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.42))); }
  .viewer-img{ max-width:100%; max-height:74dvh; transform-origin: center center; object-fit:contain; border-radius:12px; }
  .toolbar{ margin-top:10px; display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px; color:var(--text-inverse, #e5e7eb); }
  button{ padding:7px 11px; border:1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.28); border-radius:10px; background:rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08); color:var(--text-inverse, #f8fafc); cursor:pointer; font-weight:700; }
  button:hover{ background:rgba(var(--text-inverse-rgb, 255, 255, 255), 0.14); }
</style>

{#if src}
  <!-- svelte-ignore a11y_click_events_have_key_events: overlay closes on pointer interaction and also supports Enter/Space via handleOverlayKeydown -->
  <div class="viewer-overlay" role="button" tabindex="0" aria-label="Close image viewer" on:click={onClose} on:keydown={handleOverlayKeydown}>
    <div class="viewer-panel" role="dialog" aria-modal="true" aria-label={alt} tabindex="-1" on:click|stopPropagation>
      <img class="viewer-img" src={src} alt={alt} style="transform: scale({zoom});"/>
      <div class="toolbar" aria-label="image viewer controls">
        <button on:click={zoomOut} title="Zoom out">-</button>
        <span>Zoom {Math.round(zoom*100)/100}x</span>
        <button on:click={zoomIn} title="Zoom in">+</button>
        <button on:click={resetZoom} title="Reset zoom">Reset</button>
        <button on:click={onClose} title="Close">Close</button>
      </div>
    </div>
  </div>
{/if}
