<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import LeaveLiveModal from './LeaveLiveModal.svelte';

  export let channelName: string = '';
  export let onLeave: () => void;

  let showLeaveModal = false;

  function confirmLeave() {
    showLeaveModal = false;
    onLeave();
  }
</script>

<div class="connection-bar">
  <div class="bar-left">
    <span class="live-dot"></span>
    <span class="connected-label">Connected</span>
    <span class="separator">·</span>
    <span class="room-name">#{channelName}</span>
  </div>
  <div class="bar-right">
    <button class="leave-btn" on:click={() => (showLeaveModal = true)}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
        <polyline points="16 17 21 12 16 7"></polyline>
        <line x1="21" y1="12" x2="9" y2="12"></line>
      </svg>
      Leave
    </button>
  </div>
</div>

{#if showLeaveModal}
  <LeaveLiveModal
    onConfirm={confirmLeave}
    onCancel={() => (showLeaveModal = false)}
  />
{/if}

<style>
  .connection-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--surface-highlight, #2b2d31);
    border-top: 1px solid var(--border-subtle, #3f4147);
    position: sticky;
    bottom: 0;
    z-index: 10;
  }

  .bar-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #43b581;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .connected-label {
    font-size: 13px;
    font-weight: 600;
    color: #43b581;
  }

  .separator {
    color: var(--text-muted, #8e9297);
    font-size: 14px;
  }

  .room-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #f2f3f5);
  }

  .leave-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted, #8e9297);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .leave-btn:hover {
    color: var(--danger-color, #e2484d);
    background: rgba(226, 72, 77, 0.1);
  }

  .btn-icon {
    width: 14px;
    height: 14px;
  }
</style>
