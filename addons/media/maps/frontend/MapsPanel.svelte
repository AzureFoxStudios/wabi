<script lang="ts">
    let markers: { id: string; name: string; lat: number; lng: number }[] = [
        { id: '1', name: 'Home', lat: 37.7749, lng: -122.4194 },
        { id: '2', name: 'Office', lat: 37.7849, lng: -122.4094 },
    ];

    let selectedMarker: string | null = null;
    let viewMode: 'map' | 'list' = 'list';
</script>

<div class="maps-panel">
    <div class="header">
        <h3>Maps</h3>
        <div class="view-toggle">
            <button class:active={viewMode === 'list'} on:click={() => (viewMode = 'list')}>List</button>
            <button class:active={viewMode === 'map'} on:click={() => (viewMode = 'map')}>Map</button>
        </div>
    </div>

    {#if viewMode === 'list'}
        <div class="marker-list">
            {#each markers as marker}
                <button
                    class="marker-item"
                    class:selected={selectedMarker === marker.id}
                    on:click={() => (selectedMarker = marker.id)}
                >
                    <span class="marker-name">{marker.name}</span>
                    <span class="marker-coords">{marker.lat.toFixed(4)}, {marker.lng.toFixed(4)}</span>
                </button>
            {/each}
        </div>
    {:else}
        <div class="map-placeholder">
            <span>Map View</span>
        </div>
    {/if}

    <div class="actions">
        <button class="add-btn">Add Location</button>
    </div>
</div>

<style>
    .maps-panel {
        padding: 1rem;
    }

    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
    }

    .header h3 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
    }

    .view-toggle {
        display: flex;
        gap: 0.25rem;
    }

    .view-toggle button {
        padding: 0.25rem 0.5rem;
        border: 1px solid #333;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 0.75rem;
    }

    .view-toggle button.active {
        background: #3b82f6;
        border-color: #3b82f6;
    }

    .marker-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .marker-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem;
        border: 1px solid #333;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: left;
    }

    .marker-item:hover {
        background: #2a2a2a;
    }

    .marker-item.selected {
        border-color: #3b82f6;
        background: #1e3a5f;
    }

    .marker-name {
        font-weight: 500;
    }

    .marker-coords {
        font-size: 0.75rem;
        color: #888;
    }

    .map-placeholder {
        height: 200px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #1a1a1a;
        border-radius: 4px;
        color: #666;
    }

    .actions {
        margin-top: 1rem;
    }

    .add-btn {
        width: 100%;
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 4px;
        background: #3b82f6;
        color: white;
        cursor: pointer;
        font-weight: 500;
    }

    .add-btn:hover {
        background: #2563eb;
    }
</style>