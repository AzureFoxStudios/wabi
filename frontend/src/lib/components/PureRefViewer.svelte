<script>
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';

  let ws;
  let imageUrl = 'http://localhost:12345/static/board.png';
  let cacheBuster = Date.now();
  let isConnected = false;
  let showViewer = false;

  onMount(() => {
    // Disabled for now - PureRef server not running on port 12345
    /*
    ws = new WebSocket('ws://localhost:12345');

    ws.onopen = () => {
      console.log('[PureRefViewer] Connected to connector.');
      isConnected = true;
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'refresh') {
        console.log('[PureRefViewer] Refresh message received. Updating image.');
        cacheBuster = Date.now();
      }
    };

    ws.onclose = () => {
      console.log('[PureRefViewer] Disconnected from connector.');
      isConnected = false;
    };

    ws.onerror = (err) => {
      console.error('[PureRefViewer] WebSocket error:', err);
      isConnected = false;
    };
    */
    isConnected = false;

    // Add keydown listener for closing with Escape key
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    if (browser) {
      if (ws) {
        ws.close();
      }
      window.removeEventListener('keydown', handleKeydown);
    }
  });

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      showViewer = false;
    }
  }

  function openViewer() {
    showViewer = true;
    cacheBuster = Date.now(); // Refresh image when opening
  }

</script>

{#if isConnected}
  <div class="pureref-button-container">
    <button on:click={openViewer}>
      View PureRef Board
    </button>
  </div>
{/if}

{#if showViewer}
  <div class="viewer-overlay" on:click={() => showViewer = false}>
    <div class="viewer-content" on:click|stopPropagation>
      <img src="{imageUrl}?v={cacheBuster}" alt="PureRef Board" />
    </div>
  </div>
{/if}

<style>
  .pureref-button-container {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 1000;
  }

  .viewer-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: rgba(0, 0, 0, 0.8);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
    cursor: pointer;
  }

  .viewer-content {
    max-width: 90vw;
    max-height: 90vh;
    cursor: default;
  }

  .viewer-content img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
