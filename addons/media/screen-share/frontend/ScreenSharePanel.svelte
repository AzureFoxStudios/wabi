<script lang="ts">
    import { createEventDispatcher } from 'svelte';

    const dispatch = createEventDispatcher();

    let isSharing = false;
    let viewerCount = 0;

    function startShare() {
        isSharing = true;
    }

    function stopShare() {
        isSharing = false;
    }
</script>

<div class="screen-share-panel">
    <div class="header">
        <h3>Screen Share</h3>
    </div>

    <div class="content">
        {#if isSharing}
            <div class="sharing-status">
                <span class="indicator active"></span>
                <span>Sharing your screen</span>
                <span class="viewers">{viewerCount} viewers</span>
            </div>
            <button class="stop-btn" on:click={stopShare}>Stop Sharing</button>
        {:else}
            <div class="available">
                <button class="share-btn" on:click={startShare}>Share Screen</button>
            </div>
        {/if}
    </div>
</div>

<style>
    .screen-share-panel {
        padding: 1rem;
    }

    .header h3 {
        margin: 0 0 1rem 0;
        font-size: 1rem;
        font-weight: 600;
    }

    .sharing-status {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #666;
    }

    .indicator.active {
        background: #22c55e;
    }

    .viewers {
        margin-left: auto;
        color: #888;
        font-size: 0.875rem;
    }

    button {
        width: 100%;
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
    }

    .share-btn {
        background: #3b82f6;
        color: white;
    }

    .share-btn:hover {
        background: #2563eb;
    }

    .stop-btn {
        background: #ef4444;
        color: white;
    }

    .stop-btn:hover {
        background: #dc2626;
    }
</style>