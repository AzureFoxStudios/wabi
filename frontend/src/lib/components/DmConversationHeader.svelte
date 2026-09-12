<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { currentUser, users, socket, leaveGroup, joinChannel } from '$lib/socket';
  import type { Channel, User } from '$lib/socket-types';
  import { layoutStore } from '$lib/layoutStore';
  import { openRightGroupDm } from '$lib/dmNavigation';
  import { getApiBase } from '$lib/api/utils';
  import { getUserIdentityKey } from '$lib/localNicknames';
  import { dmPersonName, dmHandle } from '$lib/dmPresentation';
  import { getDmStableUserId } from '$lib/dmConversations';
  import { pinnedDmIdsStore, togglePinnedDm } from '$lib/pinDms';
  import { startCall, startGroupCall, type GroupCallRingingTarget } from '$lib/calling';
  import { openDetachedPanel } from '$lib/detachedPanels';
  import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
  import type { ContextMenuItem } from '$lib/context-menu/types';
  import { LatestIntent } from '$lib/latestIntent';

  export let channel: Channel | null;
  export let otherUser: User | null = null;
  export let context: 'center' | 'right' = 'right';
  export let onBack: () => void;
  export let onGroupSettings: (() => void) | undefined = undefined;
  export let groupSettingsOpen = false;
  let showPrivacy = false;
  let menuOpen = false, menuX = 0, menuY = 0;
  let menuItems: ContextMenuItem[] = [];
  let busy = false, error = '';
  let lastConversation = '';
  const intents = new LatestIntent();
  $: title = channel?.type === 'group' ? channel.name || 'Group message' : dmPersonName(otherUser);
  $: host = hostLabel(getApiBase(), $socket?.id);
  $: identity = `${context}:${channel?.id || ''}:${getDmStableUserId($currentUser)}:${host}`;
  $: if (identity !== lastConversation) { lastConversation = identity; intents.cancel(); menuOpen = false; showPrivacy = false; busy = false; error = ''; }
  $: canCall = !!channel && !!$socket?.connected && (channel.type === 'group' || !!otherUser);
  onDestroy(() => intents.dispose());

  function hostLabel(base: string, _connectionId?: string): string {
    try { const url = new URL(base || (typeof window !== 'undefined' ? window.location.origin : '')); return `${url.host}${url.pathname.replace(/\/+$/, '')}`; }
    catch { return 'This server'; }
  }
  async function call(withVideo: boolean) {
    const target = channel, person = otherUser, connection = get(socket);
    if (!target || !connection?.connected || busy) return;
    const request = intents.begin(); busy = true; error = '';
    try {
      if (target.type === 'group') {
        const self = getDmStableUserId(get(currentUser));
        const members = new Set(target.members || []);
        const invitees = new Map<string, GroupCallRingingTarget>();
        for (const user of get(users)) {
          const stableId = getDmStableUserId(user);
          if (stableId && stableId !== self && (members.has(stableId) || members.has(user.id))) invitees.set(stableId, { stableUserId: stableId, username: user.username });
        }
        await startGroupCall(connection, target.id, target.name || 'Group message', withVideo, { localDisplayName: get(currentUser)?.username || 'Wabi user', invitees: [...invitees.values()] });
      } else if (person) {
        await startCall(connection, getUserIdentityKey(person), withVideo, { scope: 'dm', displayName: dmPersonName(person) });
      }
    } catch (e) { if (intents.current(request)) error = e instanceof Error ? e.message : 'Could not start the call. Check your connection and microphone permissions.'; }
    finally { if (intents.current(request)) busy = false; }
  }
  function openOtherSurface() {
    if (!channel) return;
    if (channel.type === 'group') {
      if (context === 'right') layoutStore.openCenterGroupDm(channel.id, channel);
      else openRightGroupDm(channel);
    } else {
      if (context === 'right') layoutStore.openCenterDm(channel.id, otherUser);
      else layoutStore.openDM(channel.id, otherUser);
    }
    joinChannel(channel.id);
  }
  async function leave(target: Channel) {
    if (!window.confirm(`Leave “${target.name || 'this group'}”? This removes your membership, not the other members' conversation.`)) return;
    const request = intents.begin(); busy = true; error = '';
    try { await leaveGroup(target.id); }
    catch (e) { if (intents.current(request)) error = e instanceof Error ? e.message : 'Could not confirm leaving the group.'; }
    finally { if (intents.current(request)) busy = false; }
    // The server's group-removed event owns targeted view cleanup.
  }
  function openMenu(event: MouseEvent) {
    const target = channel;
    if (!target) return;
    const name = title, settings = onGroupSettings;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); menuX = rect.right; menuY = rect.bottom + 4;
    menuItems = [
      { id: 'pin', label: get(pinnedDmIdsStore).includes(target.id) ? 'Unpin conversation' : 'Pin conversation', icon: 'pin', onSelect: () => togglePinnedDm(target.id) },
      { id: 'privacy', label: 'Privacy and hosting', icon: 'settings', onSelect: () => { showPrivacy = !showPrivacy; } },
      { id: 'window', label: 'Open in separate window', onSelect: () => { openDetachedPanel({ kind: 'channel-chat', channelId: target.id, channelName: name }); } }
    ];
    if (target.type === 'group') {
      if (settings) menuItems.push({ id: 'group-settings', label: groupSettingsOpen ? 'Back to messages' : 'Group settings', icon: 'settings', onSelect: settings });
      menuItems.push({ id: 'leave-divider', type: 'separator' }, { id: 'leave', label: 'Leave group…', icon: 'log-out', disabled: busy, onSelect: () => leave(target) });
    }
    menuOpen = true;
  }
</script>

<header class="conversation-header">
  <div class="conversation-bar">
    <button type="button" class="header-icon" on:click={onBack} aria-label="Back to conversations" title="Back to conversations"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>
    <span class="header-avatar" aria-hidden="true">{#if channel?.type === 'group' ? channel.avatar : otherUser?.profilePicture}<img src={channel?.type === 'group' ? channel.avatar : otherUser?.profilePicture} alt="" />{:else}{channel?.type === 'group' ? '#' : title.charAt(0).toUpperCase()}{/if}</span>
    <div class="header-identity"><h2 title={title}>{title}</h2><div class="header-meta">{#if channel?.type !== 'group' && dmHandle(otherUser)}<span>{dmHandle(otherUser)}</span>{/if}<span class="header-host" title={`Hosted on ${host}`}>{host}</span></div></div>
    <div class="header-actions" role="group" aria-label="Conversation tools">
      <div class="header-calls"><button type="button" class="header-tool" disabled={!canCall || busy} on:click={() => void call(false)} aria-label={`Voice call ${title}`} title="Voice call"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2.1Z"/></svg><span>Call</span></button><button type="button" class="header-tool" disabled={!canCall || busy} on:click={() => void call(true)} aria-label={`Video call ${title}`} title="Video call"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 10 6-4v12l-6-4"/></svg><span>Video</span></button></div>
      <button type="button" class="header-icon" disabled={!channel} on:click={openOtherSurface} aria-label={context === 'right' ? 'Open in main view' : 'Open in side panel'} title={context === 'right' ? 'Open in main view' : 'Open in side panel'}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
      <button type="button" class="header-icon" disabled={!channel} on:click={openMenu} aria-label="More conversation actions" aria-haspopup="menu" aria-expanded={menuOpen} title="More conversation actions"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
    </div>
  </div>
  {#if channel?.type === 'dm' && !otherUser}<p class="header-notice" role="status">Recipient details are unavailable. Reconnect to refresh this conversation.</p>{/if}
  {#if error}<p class="header-notice error" role="alert">{error}</p>{/if}
  {#if showPrivacy}<div class="header-privacy"><strong>Hosted on {host}</strong><p>Messages and attachments are not end-to-end encrypted. The server operator can read them. Normal application access is limited to conversation members.</p><button type="button" class="header-tool" on:click={() => showPrivacy = false}>Close details</button></div>{/if}
</header>
<ContextMenu open={menuOpen} x={menuX} y={menuY} items={menuItems} ariaLabel="Conversation actions" headerLabel={title} on:close={() => menuOpen = false} />

<style>
  .conversation-header { flex-shrink:0; min-width:0; color:var(--text-heading, #e8eded); background:var(--surface-base, #111b20); border-bottom:1px solid var(--color-border-primary, #334047); container-type:inline-size; }
  .conversation-bar { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:12px; }.header-identity { flex:1; min-width:60px; }h2 { font-size:15px; line-height:1.4; margin:0; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .header-avatar { display:grid; place-items:center; width:36px; height:36px; flex-shrink:0; border-radius:50%; background:var(--surface-raised, #1b292f); border:1px solid var(--color-border-primary, #334047); overflow:hidden; font-weight:600; }.header-avatar img { width:100%; height:100%; object-fit:cover; }
  .header-meta { display:flex; flex-wrap:wrap; gap:3px 8px; margin-top:3px; font-size:11px; color:var(--text-secondary, #b7c3c9); }.header-meta span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .header-actions,.header-calls { display:flex; align-items:center; gap:4px; }.header-calls { padding-right:6px; margin-right:2px; border-right:1px solid var(--color-border-primary, #334047); }
  button { font:inherit; color:inherit; cursor:pointer; }button:disabled { opacity:.45; cursor:not-allowed; }button:focus-visible { outline:2px solid var(--accent-primary-color, #7cbeb2); outline-offset:2px; }
  .header-icon,.header-tool { display:inline-flex; align-items:center; justify-content:center; min-height:36px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-raised, #1b292f); }.header-icon { width:36px; padding:7px; flex-shrink:0; }.header-tool { gap:6px; padding:7px 10px; font-size:12px; font-weight:550; }
  .header-icon:hover:not(:disabled),.header-tool:hover:not(:disabled) { border-color:var(--accent-primary-color, #7cbeb2); }
  .header-notice,.header-privacy { margin:0; padding:12px 16px; font-size:12px; line-height:1.6; background:var(--surface-raised, #1b292f); border-top:1px solid var(--color-border-primary, #334047); }.header-privacy p { margin:6px 0 12px; color:var(--text-secondary, #b7c3c9); }.error { border-left:3px solid var(--color-danger, #e68b87); }
  @container (max-width:480px) { .header-actions { flex-basis:100%; justify-content:flex-end; padding-top:6px; border-top:1px solid var(--color-border-primary, #334047); }.header-calls { margin-right:auto; border-right:0; padding-right:0; }.header-tool { min-width:72px; }.header-identity { min-width:100px; } }
  @container (max-width:260px) { .conversation-bar { gap:6px; padding:8px; }.header-avatar { display:none; }.header-tool { min-width:0; padding:7px; }.header-calls { gap:3px; }.header-icon { width:32px; } }
  @media (pointer:coarse) { .header-icon,.header-tool { min-height:44px; }.header-icon { width:44px; } }
</style>
