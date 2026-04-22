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
  .viewer-overlay{ position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,.7); display:flex; align-items:center; justify-content:center; z-index: 9999; }
  .viewer-panel{ background:white; padding:12px; border-radius:8px; max-width:90%; max-height:90%; overflow:auto; display:flex; flex-direction:column; align-items:center; }
  .viewer-img{ max-width:100%; max-height:70vh; transform-origin: center center; }
  .toolbar{ margin-top:8px; display:flex; gap:8px; }
  button{ padding:6px 10px; border:1px solid #ccc; border-radius:4px; background:#f8f8f8; cursor:pointer; }
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
