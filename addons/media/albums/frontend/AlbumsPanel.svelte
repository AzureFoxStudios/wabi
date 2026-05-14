<script lang="ts">
    let albums: { id: string; name: string; photoCount: number }[] = [
        { id: '1', name: 'Vacation 2024', photoCount: 42 },
        { id: '2', name: 'Family', photoCount: 18 },
    ];

    let selectedAlbum: string | null = null;
</script>

<div class="albums-panel">
    <div class="header">
        <h3>Albums</h3>
    </div>

    <div class="album-list">
        {#each albums as album}
            <button
                class="album-item"
                class:selected={selectedAlbum === album.id}
                on:click={() => (selectedAlbum = album.id)}
            >
                <span class="album-name">{album.name}</span>
                <span class="photo-count">{album.photoCount} photos</span>
            </button>
        {/each}
    </div>

    <div class="actions">
        <button class="create-btn">New Album</button>
    </div>
</div>

<style>
    .albums-panel {
        padding: 1rem;
    }

    .header h3 {
        margin: 0 0 1rem 0;
        font-size: 1rem;
        font-weight: 600;
    }

    .album-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .album-item {
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

    .album-item:hover {
        background: #2a2a2a;
    }

    .album-item.selected {
        border-color: #3b82f6;
        background: #1e3a5f;
    }

    .album-name {
        font-weight: 500;
    }

    .photo-count {
        font-size: 0.875rem;
        color: #888;
    }

    .actions {
        margin-top: 1rem;
    }

    .create-btn {
        width: 100%;
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 4px;
        background: #3b82f6;
        color: white;
        cursor: pointer;
        font-weight: 500;
    }

    .create-btn:hover {
        background: #2563eb;
    }
</style>