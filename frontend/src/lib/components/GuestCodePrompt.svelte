<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { acceptLocalMockGuestCode, isLocalMockApiMode } from '$lib/localMockApi';
  import { getServerUrl } from '../serverUrl';

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

    if (isLocalMockApiMode()) {
      if (acceptLocalMockGuestCode(code)) {
        sessionStorage.setItem('guestAccessCode', code.trim());
        dispatch('verified', { code: code.trim() });
        show = false;
      } else {
        error = 'Please enter a code';
      }
      loading = false;
      return;
    }

    try {
      const response = await fetch(`${getServerUrl()}/api/guest/verify-code`, {
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
      <div class="modal-kicker">LOCAL · BUSINESS HUB</div>
      <h2>Guest Access Required</h2>
      <p class="intro">Enter your special access code to create and edit business data.</p>

      <label class="access-field">
        <span>ACCESS CODE</span>
        <input
          type="text"
          bind:value={code}
          on:keydown={handleKeydown}
          placeholder="Enter access code"
          disabled={loading}
          autocomplete="off"
        />
      </label>

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
    background:
      radial-gradient(circle at 50% 38%, rgba(243, 107, 33, 0.08), transparent 34%),
      rgba(0, 0, 0, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--z-modal);
    padding: 1rem;
    backdrop-filter: blur(10px);
  }

  .modal-content {
    position: relative;
    width: min(440px, 100%);
    background:
      var(--biz-dot-grid, radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.075) 1px, transparent 0)) 0 0 / 16px 16px,
      linear-gradient(180deg, var(--biz-bg-card, #0d0f12), var(--biz-bg-secondary, #090a0c));
    border: 1px solid var(--biz-border-light, rgba(255, 255, 255, 0.14));
    border-radius: 12px;
    padding: 1.35rem;
    box-shadow: var(--biz-shadow-lg, 0 24px 80px rgba(0, 0, 0, 0.46));
    color: var(--biz-text-primary, #f4f4f5);
  }

  .modal-content::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  .modal-kicker,
  .access-field span {
    font-family: var(--biz-font-mono, monospace);
    font-size: 0.65rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--biz-text-tertiary, #71717a);
  }

  h2 {
    margin: 0.25rem 0 0.5rem 0;
    color: var(--biz-text-primary, #f4f4f5);
    font-size: 1.35rem;
    font-weight: 650;
  }

  .intro {
    color: var(--biz-text-secondary, #a1a1aa);
    margin: 0 0 1rem 0;
    line-height: 1.5;
  }

  .access-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 1rem;
  }

  input {
    width: 100%;
    padding: 0.78rem 0.85rem;
    border: 1px solid var(--biz-border, rgba(255, 255, 255, 0.085));
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.045);
    color: var(--biz-text-primary, #f4f4f5);
    caret-color: var(--biz-accent, #f36b21);
    font-size: 0.95rem;
    box-sizing: border-box;
  }

  input::placeholder {
    color: var(--biz-text-muted, #52525b);
  }

  input:focus {
    outline: none;
    border-color: var(--biz-accent, #f36b21);
    box-shadow: 0 0 0 3px var(--biz-accent-soft, rgba(243, 107, 33, 0.16));
  }

  .button-group {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  button {
    flex: 1;
    padding: 0.78rem 1rem;
    border: 1px solid var(--biz-border, rgba(255, 255, 255, 0.085));
    border-radius: 8px;
    font-weight: 650;
    cursor: pointer;
    transition: all 0.16s ease;
    font-family: inherit;
  }

  button.primary {
    background: var(--biz-accent, #f36b21);
    border-color: var(--biz-accent, #f36b21);
    color: #fff7ed;
  }

  button.primary:hover:not(:disabled) {
    background: var(--biz-accent-hover, #ff7a2f);
    transform: translateY(-1px);
  }

  button.secondary {
    background: rgba(255, 255, 255, 0.04);
    color: var(--biz-text-secondary, #a1a1aa);
  }

  button.secondary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.075);
    color: var(--biz-text-primary, #f4f4f5);
  }

  button:focus-visible {
    outline: 2px solid var(--biz-accent, #f36b21);
    outline-offset: 2px;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
  }

  .error {
    color: var(--biz-danger, #ff4d4d);
    font-size: 0.875rem;
    margin: -0.35rem 0 1rem 0;
  }

  .hint {
    font-size: 0.84rem;
    line-height: 1.45;
    text-align: center;
    color: var(--biz-text-tertiary, #71717a);
    margin: 0;
  }

  @media (max-width: 520px) {
    .modal-overlay {
      align-items: flex-start;
      padding: 1rem 0.9rem;
    }

    .modal-content {
      padding: 1rem;
    }

    .button-group {
      flex-direction: column;
    }
  }
</style>
