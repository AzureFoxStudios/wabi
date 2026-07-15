<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { users, currentUser } from '$lib/socket';
  import type { User } from '$lib/socket-types';

  const dispatch = createEventDispatcher<{
    select: User;
    close: void;
  }>();

  let search = '';

  $: filtered = ($users || []).filter((u: User) => {
    if (u.id === $currentUser?.id) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (u.username || '').toLowerCase().includes(q)
      || (u.handle || '').toLowerCase().includes(q);
  });

  function select(user: User) {
    dispatch('select', user);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      dispatch('close');
    }
  }

  let inputEl: HTMLInputElement;
  onMount(() => {
    inputEl?.focus();
  });
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="people-picker" role="dialog" aria-label="Select a person">
  <div class="people-picker-header">
    <input
      bind:this={inputEl}
      class="people-picker-input"
      type="text"
      placeholder="Search people..."
      bind:value={search}
      on:keydown={(e) => { if (e.key === 'Escape') dispatch('close'); }}
    />
    <button class="people-picker-close" on:click={() => dispatch('close')}>&times;</button>
  </div>

  <div class="people-picker-list">
    {#if search}
      {#each filtered as user (user.id)}
        <button class="people-picker-item" on:click={() => select(user)}>
          <div class="people-picker-avatar">
            {#if user.profilePicture}
              <img src={user.profilePicture} alt="" class="people-picker-avatar-img" />
            {:else}
              <span class="people-picker-avatar-letter">{(user.handle || user.username || '?')[0]}</span>
            {/if}
          </div>
          <div class="people-picker-info">
            <span class="people-picker-name">{user.handle || user.username}</span>
            {#if user.handle && user.username}
              <span class="people-picker-handle">@{user.handle}</span>
            {/if}
          </div>
        </button>
      {:else}
        <div class="people-picker-empty">No results</div>
      {/each}
    {:else}
      {#each filtered as user (user.id)}
        <button class="people-picker-item" on:click={() => select(user)}>
          <div class="people-picker-avatar">
            {#if user.profilePicture}
              <img src={user.profilePicture} alt="" class="people-picker-avatar-img" />
            {:else}
              <span class="people-picker-avatar-letter">{(user.handle || user.username || '?')[0]}</span>
            {/if}
          </div>
          <div class="people-picker-info">
            <span class="people-picker-name">{user.handle || user.username}</span>
            {#if user.handle && user.username}
              <span class="people-picker-handle">@{user.handle}</span>
            {/if}
          </div>
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .people-picker {
    display: flex;
    flex-direction: column;
    max-height: 300px;
    border-bottom: 1px solid var(--color-border-primary, #302b63);
    background: var(--surface-raised, #302b63);
  }

  .people-picker-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
  }

  .people-picker-input {
    flex: 1;
    padding: 5px 8px;
    border: 1px solid var(--color-border-primary, #302b63);
    border-radius: var(--radius-sm, 4px);
    background: var(--surface-base, #24243e);
    color: var(--text-heading, #e0e0ff);
    font-size: var(--text-sm, 13px);
    outline: none;
  }
  .people-picker-input::placeholder {
    color: var(--text-muted, #9999ff);
  }
  .people-picker-input:focus {
    border-color: var(--accent-primary, #6366f1);
  }

  .people-picker-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-muted, #9999ff);
    cursor: pointer;
    font-size: 16px;
    padding: 0;
  }
  .people-picker-close:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text-heading, #e0e0ff);
  }

  .people-picker-list {
    flex: 1;
    overflow-y: auto;
    max-height: 240px;
  }

  .people-picker-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .people-picker-item:hover {
    background: rgba(255,255,255,0.06);
  }

  .people-picker-avatar {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-full, 9999px);
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-primary, #6366f1);
    color: #fff;
    font-size: 12px;
    font-weight: var(--font-weight-semibold, 600);
  }

  .people-picker-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .people-picker-avatar-letter {
    text-transform: uppercase;
  }

  .people-picker-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .people-picker-name {
    font-size: var(--text-sm, 13px);
    font-weight: var(--font-weight-medium, 500);
    color: var(--text-heading, #e0e0ff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .people-picker-handle {
    font-size: 11px;
    color: var(--text-muted, #9999ff);
  }

  .people-picker-empty {
    padding: 16px;
    text-align: center;
    color: var(--text-muted, #9999ff);
    font-size: var(--text-sm, 13px);
  }
</style>
