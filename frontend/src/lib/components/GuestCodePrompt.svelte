<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let show = false;

  let code = '';
  let error = '';
  let loading = false;

  const dispatch = createEventDispatcher();

  async function verifyCode() {
    if (!code.trim()) {
      error = 'Please enter a code';
      return;
    }

    loading = true;
    error = '';

    try {
      const response = await fetch('/api/guest/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() })
      });

      const result = await response.json();

      if (result.valid) {
        // Store code in sessionStorage (not localStorage - session only)
        sessionStorage.setItem('guestAccessCode', code.trim());
        dispatch('verified', { code: code.trim() });
        show = false;
      } else {
        error = result.message || 'Invalid code';
      }
    } catch (err) {
      error = 'Failed to verify code';
      console.error('Code verification error:', err);
    } finally {
      loading = false;
    }
  }

  function skipAsReadOnly() {
    dispatch('readonly');
    show = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !loading) {
      verifyCode();
    }
  }
</script>

{#if show}
  <div class="modal-overlay">
    <div class="modal-content">
      <h2>Guest Access Required</h2>
      <p>Enter your special access code to create and edit business data.</p>

      <input
        type="text"
        bind:value={code}
        on:keydown={handleKeydown}
        placeholder="Enter access code"
        disabled={loading}
        autocomplete="off"
      />

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="button-group">
        <button on:click={verifyCode} disabled={loading} class="primary">
          {loading ? 'Verifying...' : 'Verify Code'}
        </button>
        <button on:click={skipAsReadOnly} disabled={loading} class="secondary">
          Continue as Read-Only
        </button>
      </div>

      <p class="hint">Don't have a code? You can still view data in read-only mode.</p>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: #1a2332;
    border-radius: 12px;
    padding: 2rem;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  }

  h2 {
    margin: 0 0 0.5rem 0;
    color: #f1f5f9;
  }

  p {
    color: #94a3b8;
    margin: 0 0 1rem 0;
  }

  input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #2d3a4d;
    border-radius: 8px;
    background: #243044;
    color: #f1f5f9;
    font-size: 1rem;
    margin-bottom: 1rem;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: #f59e0b;
  }

  .button-group {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  button {
    flex: 1;
    padding: 0.75rem 1rem;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  button.primary {
    background: #f59e0b;
    color: white;
  }

  button.primary:hover:not(:disabled) {
    background: #d97706;
  }

  button.secondary {
    background: #243044;
    color: #94a3b8;
  }

  button.secondary:hover:not(:disabled) {
    background: #2d3a4d;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .error {
    color: #ef4444;
    font-size: 0.875rem;
    margin: -0.5rem 0 1rem 0;
  }

  .hint {
    font-size: 0.875rem;
    text-align: center;
    color: #64748b;
  }
</style>
