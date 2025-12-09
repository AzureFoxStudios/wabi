<script lang="ts">
    import { onMount } from 'svelte';
    import { getCallHistory, clearCallHistory, type CallLog } from '$lib/history';
    import { writable } from 'svelte/store';

    const callHistory = writable<CallLog[]>([]);

    onMount(() => {
        callHistory.set(getCallHistory());
    });

    function handleClearHistory() {
        clearCallHistory();
        callHistory.set([]);
    }

    function formatDuration(seconds: number | undefined): string {
        if (seconds === undefined) return 'N/A';
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    }
</script>

<div class="call-history-container">
    <div class="header">
        <h3>Call History</h3>
        <button on:click={handleClearHistory} title="Clear all history">Clear</button>
    </div>
    <div class="history-list">
        {#if $callHistory.length === 0}
            <p class="empty-message">No call history yet.</p>
        {:else}
            {#each $callHistory as log (log.id)}
                <div class="log-item">
                    <div class="log-details">
                        <span class="username">{log.username}</span>
                        <span class="status {log.status}">{log.status}</span>
                    </div>
                    <div class="log-meta">
                        <span class="time">{new Date(log.startTime).toLocaleString()}</span>
                        <span class="duration">{formatDuration(log.duration)}</span>
                        {#if log.isVideo}
                            <span class="video-icon">📹</span>
                        {/if}
                    </div>
                </div>
            {/each}
        {/if}
    </div>
</div>

<style>
    .call-history-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        background-color: var(--bg-primary);
		color: var(--text-primary);
    }
    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1rem;
        border-bottom: 1px solid var(--bg-secondary);
    }
    .header h3 {
        margin: 0;
    }
    .header button {
        background: var(--accent-red);
        color: white;
        border: none;
        padding: 0.3rem 0.8rem;
        border-radius: 5px;
        cursor: pointer;
    }
    .history-list {
        flex-grow: 1;
        overflow-y: auto;
        padding: 0.5rem;
    }
    .empty-message {
        text-align: center;
        color: var(--text-secondary);
        margin-top: 2rem;
    }
    .log-item {
        padding: 0.8rem;
        border-bottom: 1px solid var(--bg-tertiary);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .log-details .username {
        font-weight: bold;
    }
    .log-details .status {
        margin-left: 0.5rem;
        font-size: 0.8rem;
        padding: 0.1rem 0.4rem;
        border-radius: 3px;
        text-transform: capitalize;
    }
    .status.answered, .status.ended {
        background-color: #2ecc71;
        color: white;
    }
    .status.declined {
        background-color: #e74c3c;
        color: white;
    }
    .status.missed {
        background-color: #f1c40f;
        color: black;
    }
    .log-meta {
        font-size: 0.8rem;
        color: var(--text-secondary);
    }
    .log-meta > span {
        margin-left: 0.5rem;
    }
    .video-icon {
        font-size: 1rem;
    }
</style>
