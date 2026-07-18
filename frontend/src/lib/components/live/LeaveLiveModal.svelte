<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let onConfirm: () => void;
  export let onCancel: () => void;

  const dispatch = createEventDispatcher<{ close: void }>();

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onCancel();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="modal-overlay" on:click={handleOverlayClick} role="dialog" aria-modal="true" tabindex="-1">
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-content" on:click|stopPropagation>
    <div class="modal-header">
      <h2>Leave Live Room?</h2>
      <button class="close-btn" on:click={onCancel} aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <p>Your local scrollback for this visit will clear.</p>
      <p>You can rejoin anytime — you'll only see messages the server still has alive.</p>
    </div>
    <div class="modal-footer">
      <button class="cancel-btn" on:click={onCancel}>Stay</button>
      <button class="confirm-btn" on:click={onConfirm}>Leave Room</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: var(--surface-base, #1e1f22);
    border-radius: 12px;
    width: 420px;
    max-width: 90vw;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px 0;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary, #f2f3f5);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted, #8e9297);
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--text-primary, #f2f3f5);
  }

  .modal-body {
    padding: 16px 24px;
  }

  .modal-body p {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-secondary, #b5bac1);
    line-height: 1.5;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 16px 24px 20px;
  }

  .cancel-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: var(--surface-highlight, #2b2d31);
    color: var(--text-primary, #f2f3f5);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .cancel-btn:hover {
    background: var(--surface-hover, #35373c);
  }

  .confirm-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: var(--danger-color, #e2484d);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .confirm-btn:hover {
    filter: brightness(0.9);
  }
</style>
