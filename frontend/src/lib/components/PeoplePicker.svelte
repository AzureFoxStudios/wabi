<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { users, serverMembers, currentUser } from '$lib/socket';
  import type { User } from '$lib/socket-types';
  import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
  import { dmPersonName, dmHandle } from '$lib/dmPresentation';

  export let busy = false;
  export let pendingName = '';
  const dispatch = createEventDispatcher<{ select: User; close: void }>();
  let search = '';
  let inputEl: HTMLInputElement;
  let root: HTMLElement;
  $: filtered = buildDmDirectoryUsers({ onlineUsers: $users || [], serverMembers: $serverMembers || [], currentUser: $currentUser, searchQuery: search });
  onMount(() => inputEl?.focus());
</script>

<svelte:window on:keydown={event => { if (event.key === 'Escape' && root?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); dispatch('close'); } }} />
<section bind:this={root} class="people-picker" aria-label="New message">
  <div class="picker-heading">
    <div><h3>Who would you like to message?</h3><p>People on this server, including offline members.</p></div>
    <button type="button" class="picker-cancel" on:click={() => dispatch('close')}>Cancel</button>
  </div>
  <label class="picker-search">
    <span>Name or handle</span>
    <input bind:this={inputEl} type="search" placeholder="Search people" bind:value={search} autocomplete="off" />
  </label>
  {#if busy}<p class="picker-progress" role="status">Opening your conversation with {pendingName || 'this person'}…</p>{/if}
  <div class="picker-results" aria-busy={busy}>
    {#each filtered as user (getDmDirectoryKey(user))}
      <button type="button" class="picker-person" disabled={busy} on:click={() => dispatch('select', user)} aria-label={`Message ${dmPersonName(user)}${dmHandle(user) ? `, ${dmHandle(user)}` : ''}`}>
        <span class="picker-avatar" aria-hidden="true">
          {#if user.profilePicture}<img src={user.profilePicture} alt="" loading="lazy" />{:else}{dmPersonName(user).charAt(0).toUpperCase()}{/if}
        </span>
        <span class="picker-identity"><strong>{dmPersonName(user)}</strong>{#if dmHandle(user)}<small>{dmHandle(user)}</small>{/if}</span>
        <span class="picker-action">Message <span aria-hidden="true">→</span></span>
      </button>
    {:else}
      <div class="picker-empty" role="status"><strong>{search.trim() ? 'No matching people' : 'No other members available'}</strong><p>{search.trim() ? 'Try another name or handle.' : 'Reconnect to refresh the member list, or invite someone to this server.'}</p></div>
    {/each}
  </div>
</section>

<style>
  .people-picker { display:flex; flex-direction:column; min-width:0; border:1px solid var(--color-border-primary, #334047); border-radius:12px; background:var(--surface-raised, #1b292f); overflow:hidden; color:var(--text-heading, #e8eded); }
  .picker-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:16px 16px 8px; }.picker-heading div { min-width:0; }
  h3 { font-size:14px; line-height:1.4; margin:0; } p { font-size:12px; line-height:1.5; color:var(--text-secondary, #b7c3c9); margin:4px 0 0; }
  button,input { font:inherit; color:inherit; box-sizing:border-box; }button { cursor:pointer; }button:disabled { opacity:.55; cursor:wait; }
  button:focus-visible,input:focus-visible { outline:2px solid var(--accent-primary-color, #7cbeb2); outline-offset:2px; }
  .picker-cancel { min-height:36px; border:1px solid var(--color-border-primary, #334047); background:var(--surface-base, #111b20); border-radius:8px; padding:6px 10px; font-size:12px; flex-shrink:0; }
  .picker-search { display:flex; flex-direction:column; gap:6px; padding:8px 16px 12px; font-size:12px; color:var(--text-secondary, #b7c3c9); }
  input { width:100%; min-width:0; min-height:40px; padding:8px 12px; border:1px solid var(--color-border-primary, #334047); background:var(--surface-base, #111b20); border-radius:8px; font-size:14px; }
  .picker-results { max-height:320px; overflow:auto; overscroll-behavior:contain; padding:4px 8px 8px; }
  .picker-person { display:flex; align-items:center; gap:10px; width:100%; min-height:62px; padding:10px 8px; border:1px solid transparent; border-radius:8px; background:transparent; text-align:left; }
  .picker-person:hover:not(:disabled) { background:var(--surface-base, #111b20); border-color:var(--color-border-primary, #334047); }
  .picker-avatar { width:36px; height:36px; border-radius:50%; display:grid; place-items:center; overflow:hidden; background:var(--surface-base, #111b20); border:1px solid var(--color-border-primary, #334047); flex-shrink:0; font-weight:650; }.picker-avatar img { width:100%; height:100%; object-fit:cover; }
  .picker-identity { display:flex; flex-direction:column; flex:1; min-width:0; gap:3px; }.picker-identity strong,.picker-identity small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.picker-identity strong { font-size:14px; }.picker-identity small { color:var(--text-secondary, #b7c3c9); font-size:12px; }
  .picker-action { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; color:var(--text-secondary, #b7c3c9); flex-shrink:0; }
  .picker-empty { padding:24px 12px; font-size:14px; text-align:center; }.picker-progress { margin:0; padding:8px 16px; }
  @media (pointer:coarse) { .picker-cancel,input { min-height:44px; } }
</style>
