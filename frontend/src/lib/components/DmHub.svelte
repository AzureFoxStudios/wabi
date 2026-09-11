<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { layoutStore } from '$lib/layoutStore';
  import { centerDmChannelId } from '$lib/layoutStoreStates';
  import { channels, channelMessages, currentUser, users, serverMembers, socket, channelUnreadCounts, createDM, joinChannel } from '$lib/socket';
  import type { Channel, User } from '$lib/socket-types';
  import { getApiBase } from '$lib/api/utils';
  import { authSessionGeneration } from '$lib/authSession';
  import { resolveDmOtherUser, getDmStableUserId } from '$lib/dmConversations';
  import { resolveDmEntry } from '$lib/dmEntry';
  import { dmPersonName, dmHandle, dmPreview, dmActivityTime, dmTimeLabel, sortDmConversations } from '$lib/dmPresentation';
  import { LatestIntent } from '$lib/latestIntent';
  import { pinnedDmIdsStore, togglePinnedDm } from '$lib/pinDms';
  import { openDetachedPanel } from '$lib/detachedPanels';
  import PeoplePicker from './PeoplePicker.svelte';
  import CreateGroupModal from './CreateGroupModal.svelte';
  import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
  import type { ContextMenuItem } from '$lib/context-menu/types';

  export let surface: 'center' | 'right' = 'center';
  let query = '';
  let filter: 'all' | 'unread' | 'pinned' = 'all';
  let showPeoplePicker = false;
  let showCreateGroup = false;
  let pendingUser: User | null = null;
  let error = '';
  let newMessageButton: HTMLButtonElement;
  const intents = new LatestIntent();
  let menuChannel: Channel | null = null;
  let menuX = 0, menuY = 0;
  let menuItems: ContextMenuItem[] = [];
  let lastAccount = '';

  $: account = `${getApiBase()}:${getDmStableUserId($currentUser)}:${$socket?.id || ''}`;
  $: if (lastAccount !== account) { lastAccount = account; intents.cancel(); pendingUser = null; error = ''; menuChannel = null; showPeoplePicker = false; }
  $: pinned = new Set($pinnedDmIdsStore);
  $: conversations = sortDmConversations(
    ($channels || []).filter(channel => channel.type === 'dm' || channel.type === 'group'),
    $channelMessages, pinned,
    channel => channel.type === 'group' ? channel.name || 'Group message' : dmPersonName(resolveDmOtherUser(channel, $currentUser, $users, $serverMembers))
  );
  $: rows = conversations.map(channel => {
    const person = resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
    return { channel, person, label: channel.type === 'group' ? channel.name || 'Group message' : dmPersonName(person), unread: $channelUnreadCounts[channel.id] || 0 };
  });
  $: visible = rows.filter(row => (filter !== 'unread' || row.unread > 0) && (filter !== 'pinned' || pinned.has(row.channel.id)) && `${row.label} ${dmHandle(row.person)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  $: selected = surface === 'center' ? $centerDmChannelId : $layoutStore.selectedDmChannelId;
  onDestroy(() => intents.dispose());

  function cancelPicker() {
    intents.cancel(); pendingUser = null; showPeoplePicker = false; error = '';
    void tick().then(() => newMessageButton?.focus());
  }
  function open(channel: Channel, destination = surface) {
    intents.cancel(); pendingUser = null; showPeoplePicker = false; error = '';
    const person = resolveDmOtherUser(channel, get(currentUser), get(users), get(serverMembers));
    if (channel.type === 'group') {
      if (destination === 'center') layoutStore.openCenterGroupDm(channel.id, channel);
      else layoutStore.openGroupDM(channel.id, channel);
    } else {
      if (destination === 'center') layoutStore.openCenterDm(channel.id, person);
      else layoutStore.openDM(channel.id, person);
    }
    joinChannel(channel.id);
  }
  async function selectPerson(person: User) {
    if (pendingUser || getDmStableUserId(person) === getDmStableUserId(get(currentUser))) return;
    const connection = get(socket);
    if (!connection?.connected) { error = 'Reconnect to this server before starting a conversation.'; return; }
    const base = getApiBase(), session = authSessionGeneration(base), self = getDmStableUserId(get(currentUser));
    const request = intents.begin(); pendingUser = person; error = '';
    const result = await resolveDmEntry({ channels: get(channels), target: person, createDm: createDM });
    if (!intents.current(request) || getApiBase() !== base || authSessionGeneration(base) !== session || getDmStableUserId(get(currentUser)) !== self || get(socket) !== connection) return;
    pendingUser = null;
    if (result.ok === false) { error = result.error; return; }
    showPeoplePicker = false;
    if (surface === 'center') layoutStore.openCenterDm(result.channelId, person);
    else layoutStore.openDM(result.channelId, person);
    joinChannel(result.channelId);
  }
  function actionsFor(channel: Channel, event: MouseEvent) {
    event.preventDefault(); event.stopPropagation();
    menuChannel = channel; menuX = event.clientX; menuY = event.clientY;
    // Capture the target now: the menu clears its state before an action runs.
    menuItems = [
      { id: 'open', label: 'Open conversation', icon: 'message-circle', onSelect: () => open(channel) },
      { id: 'other-panel', label: surface === 'center' ? 'Open in side panel' : 'Open in main view', onSelect: () => open(channel, surface === 'center' ? 'right' : 'center') },
      { id: 'pin', label: pinned.has(channel.id) ? 'Unpin conversation' : 'Pin conversation', icon: 'pin', onSelect: () => togglePinnedDm(channel.id) },
      { id: 'window', label: 'Open in separate window', onSelect: () => { openDetachedPanel({ kind: 'channel-chat', channelId: channel.id, channelName: channel.type === 'group' ? channel.name : dmPersonName(resolveDmOtherUser(channel, get(currentUser), get(users), get(serverMembers))) }); } }
    ];
  }
  function openActions(channel: Channel, event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    actionsFor(channel, event); menuX = rect.right; menuY = rect.bottom + 4;
  }
</script>

<section class="dm-hub" class:compact={surface === 'right'} aria-label="Direct messages">
  <header class="hub-header">
    <div class="hub-title"><h2>Messages</h2><p>Direct and group conversations on this server</p></div>
    <button type="button" bind:this={newMessageButton} class="hub-primary" aria-expanded={showPeoplePicker} on:click={() => showPeoplePicker ? cancelPicker() : (showPeoplePicker = true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New message</span>
    </button>
  </header>
  <div class="hub-tools">
    <label class="hub-search"><span class="sr-only">Search conversations by name or handle</span><input type="search" placeholder="Search conversations" bind:value={query} /></label>
    <div class="hub-tool-row">
      <div class="hub-filters" role="group" aria-label="Filter conversations">
        <button type="button" aria-pressed={filter === 'all'} on:click={() => filter = 'all'}>All</button>
        <button type="button" aria-pressed={filter === 'unread'} on:click={() => filter = 'unread'}>Unread</button>
        <button type="button" aria-pressed={filter === 'pinned'} on:click={() => filter = 'pinned'}>Pinned</button>
      </div>
      <button type="button" class="hub-secondary" on:click={() => showCreateGroup = true}>New group</button>
    </div>
  </div>
  {#if showPeoplePicker}
    <div class="hub-picker"><PeoplePicker busy={!!pendingUser} pendingName={dmPersonName(pendingUser)} on:select={event => void selectPerson(event.detail)} on:close={cancelPicker} />{#if error}<p class="hub-error" role="alert">{error}</p>{/if}</div>
  {/if}
  <div class="hub-list">
    {#if surface === 'right'}<button type="button" class="hub-notes" on:click={() => layoutStore.openNotes()}><span>Personal notes</span><small>Open notes →</small></button>{/if}
    {#each visible as row (row.channel.id)}
      <div class="hub-row" class:active={selected === row.channel.id} class:unread={row.unread > 0}>
        <button type="button" class="hub-conversation" aria-current={selected === row.channel.id ? 'true' : undefined} on:click={() => open(row.channel)} on:contextmenu={event => actionsFor(row.channel, event)}>
          <span class="hub-avatar" aria-hidden="true">
            {#if row.channel.type === 'group' ? row.channel.avatar : row.person?.profilePicture}<img src={row.channel.type === 'group' ? row.channel.avatar : row.person?.profilePicture} alt="" loading="lazy" />{:else}<span>{row.channel.type === 'group' ? '#' : row.label.charAt(0).toUpperCase()}</span>{/if}
          </span>
          <span class="hub-summary"><span class="hub-top"><strong>{row.label}</strong>{#if pinned.has(row.channel.id)}<small class="hub-pin">Pinned</small>{/if}<time>{dmTimeLabel(dmActivityTime($channelMessages[row.channel.id]))}</time></span><span class="hub-bottom"><span class="hub-preview">{dmPreview($channelMessages[row.channel.id])}</span>{#if row.unread > 0}<span class="hub-unread" aria-label={`${row.unread} unread messages`}>{row.unread > 99 ? '99+' : row.unread}</span>{/if}</span></span>
        </button>
        <button type="button" class="hub-more" aria-label={`Actions for ${row.label}`} title="Conversation actions" on:click={event => openActions(row.channel, event)}><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
      </div>
    {:else}
      <div class="hub-empty"><h3>{rows.length ? 'No conversations match' : 'Start with a hello'}</h3><p>{rows.length ? 'Try another search or conversation filter.' : 'Choose New message, pick a person, and start talking. They do not need to be online.'}</p>{#if rows.length}<button type="button" class="hub-secondary" on:click={() => { query = ''; filter = 'all'; }}>Clear filters</button>{:else}<button type="button" class="hub-primary" on:click={() => showPeoplePicker = true}>New message</button>{/if}</div>
    {/each}
  </div>
</section>
<ContextMenu open={!!menuChannel} x={menuX} y={menuY} items={menuItems} ariaLabel="Conversation actions" on:close={() => menuChannel = null} />
<CreateGroupModal bind:isOpen={showCreateGroup} />

<style>
  .dm-hub { height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; color:var(--text-heading, #e8eded); background:var(--surface-base, #111b20); container-type:inline-size; }
  button,input { font:inherit; color:inherit; box-sizing:border-box; }button { cursor:pointer; }button:focus-visible,input:focus-visible { outline:2px solid var(--accent-primary-color, #7cbeb2); outline-offset:2px; }
  .hub-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:18px; border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }
  h2 { margin:0; font-size:20px; letter-spacing:-.025em; }p { margin:4px 0 0; font-size:12px; line-height:1.5; color:var(--text-secondary, #b7c3c9); }.hub-title { min-width:0; flex:1 1 170px; }
  .hub-primary,.hub-secondary { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:8px 12px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-raised, #1b292f); font-size:12px; font-weight:600; }
  .hub-primary { border-color:var(--accent-primary-color, #7cbeb2); background:color-mix(in srgb, var(--accent-primary-color, #7cbeb2) 16%, var(--surface-base, #111b20)); }.hub-primary:hover,.hub-secondary:hover { filter:brightness(1.12); }
  .hub-tools { padding:14px 18px; display:flex; flex-direction:column; gap:10px; border-bottom:1px solid var(--color-border-primary, #334047); }
  .hub-search input { width:100%; min-width:0; min-height:40px; padding:8px 12px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-raised, #1b292f); font-size:14px; }
  .hub-tool-row { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }.hub-filters { display:flex; gap:2px; background:var(--surface-raised, #1b292f); padding:3px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; }
  .hub-filters button { min-height:30px; padding:4px 10px; border:1px solid transparent; background:transparent; border-radius:5px; font-size:12px; color:var(--text-secondary, #b7c3c9); }.hub-filters button[aria-pressed="true"] { background:var(--surface-base, #111b20); border-color:var(--color-border-primary, #334047); color:var(--text-heading, #e8eded); font-weight:650; }
  .hub-picker { padding:12px; overflow:auto; max-height:55%; flex-shrink:0; }.hub-error { padding:10px 12px; border-left:3px solid var(--color-danger, #e68b87); background:var(--surface-raised, #1b292f); }
  .hub-list { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:10px; }.hub-row { display:flex; align-items:center; border:1px solid transparent; border-radius:10px; margin:2px 0; min-width:0; }.hub-row:hover,.hub-row:focus-within { background:var(--surface-raised, #1b292f); border-color:var(--color-border-primary, #334047); }.hub-row.active { background:color-mix(in srgb, var(--accent-primary-color, #7cbeb2) 12%, var(--surface-base, #111b20)); border-color:var(--accent-primary-color, #7cbeb2); }
  .hub-conversation { display:flex; align-items:center; gap:12px; flex:1; min-width:0; padding:12px; border:0; background:transparent; border-radius:9px; text-align:left; }
  .hub-avatar { flex-shrink:0; display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--color-border-primary, #334047); border-radius:50%; overflow:hidden; background:var(--surface-raised, #1b292f); font-weight:650; }.hub-avatar img { height:100%; width:100%; object-fit:cover; }
  .hub-summary { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; }.hub-top,.hub-bottom { display:flex; align-items:center; gap:8px; min-width:0; }.hub-top strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:500; }.unread .hub-top strong { font-weight:750; }.hub-top time { margin-left:auto; white-space:nowrap; color:var(--text-secondary, #b7c3c9); font-size:11px; }.hub-pin { color:var(--text-secondary, #b7c3c9); font-size:10px; }.hub-preview { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; color:var(--text-secondary, #b7c3c9); flex:1; }.hub-unread { min-width:22px; padding:2px 5px; border-radius:12px; background:var(--accent-primary-color, #7cbeb2); color:var(--text-on-accent, #111b20); font-size:11px; text-align:center; font-weight:700; }
  .hub-more { width:34px; height:34px; margin-right:6px; flex-shrink:0; display:grid; place-items:center; border:1px solid var(--color-border-primary, #334047); border-radius:7px; background:var(--surface-base, #111b20); opacity:0; }.hub-row:hover .hub-more,.hub-row:focus-within .hub-more { opacity:1; }
  .hub-notes { width:100%; display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:44px; padding:10px 12px; margin-bottom:10px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-raised, #1b292f); font-size:13px; text-align:left; }.hub-notes small { font-size:11px; color:var(--text-secondary, #b7c3c9); }
  .hub-empty { text-align:center; max-width:380px; margin:clamp(24px, 8vh, 90px) auto; padding:16px; }.hub-empty h3 { margin:0 0 8px; font-size:18px; }.hub-empty p { font-size:14px; margin-bottom:18px; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .compact .hub-header,.compact .hub-tools { padding:12px; }.compact .hub-title p { font-size:11px; }.compact .hub-list { padding:6px; }.compact .hub-conversation { padding:10px 8px; gap:8px; }.compact .hub-avatar { width:34px; height:34px; }
  @container (max-width:320px) { .hub-primary { flex-grow:1; }.hub-title { flex-basis:100%; }.hub-top { flex-wrap:wrap; }.hub-top strong { flex:1 1 80px; }.hub-top time { font-size:10px; } }
  @media (hover:none), (pointer:coarse) { .hub-more { opacity:1; width:40px; height:40px; }.hub-primary,.hub-secondary,.hub-filters button { min-height:44px; } }
</style>
