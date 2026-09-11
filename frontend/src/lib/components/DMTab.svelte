<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { channels, currentUser, users, serverMembers } from '$lib/socket';
  import { layoutStore, NOTES_DM_ID } from '$lib/layoutStore';
  import { resolveDmOtherUser } from '$lib/dmConversations';
  import type { User } from '$lib/socket-types';
  import DmHub from './DmHub.svelte';
  import DmConversationHeader from './DmConversationHeader.svelte';
  import DMMessageView from './DMMessageView.svelte';
  import KeepNotesView from './KeepNotesView.svelte';
  import GroupSettingsPanel from './GroupSettingsPanel.svelte';

  const dispatch = createEventDispatcher<{ openSettings: { paymentSurface: 'connections' } }>();
  let showGroupSettings = false;
  let lastSelection: string | null = null;
  $: selectedId = $layoutStore.selectedDmChannelId;
  $: isNotes = selectedId === NOTES_DM_ID;
  $: channel = selectedId ? $channels.find(candidate => candidate.id === selectedId) || ($layoutStore.selectedGroupChannel?.id === selectedId ? $layoutStore.selectedGroupChannel : null) : null;
  $: other = resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
  $: groupRecipient = channel?.type === 'group' ? channel.memberUsers?.[0] || { id: '', username: channel.name || 'Group message', color: '#888', status: 'offline' } as User : null;
  $: if (selectedId !== lastSelection) { lastSelection = selectedId; showGroupSettings = false; }
  function back() { showGroupSettings = false; layoutStore.closeRightDm(); }
</script>

<section class="dm-tab" aria-label="Messages panel">
  {#if selectedId}
    {#if isNotes}
      <header class="notes-header"><button type="button" on:click={back}>← Messages</button><h2>Personal notes</h2></header>
      <div class="dm-content"><KeepNotesView /></div>
    {:else}
      <DmConversationHeader {channel} otherUser={other} context="right" onBack={back} onGroupSettings={channel?.type === 'group' ? () => showGroupSettings = !showGroupSettings : undefined} groupSettingsOpen={showGroupSettings} />
      <div class="dm-content">
        {#if showGroupSettings && channel?.type === 'group'}<GroupSettingsPanel {channel} />
        {:else if channel && (other || groupRecipient)}
          <DMMessageView channelId={selectedId} otherUser={(other || groupRecipient)!} {channel} on:openSettings={event => dispatch('openSettings', event.detail)} />
        {:else}<div class="dm-unavailable" role="status"><h3>Conversation details are unavailable</h3><p>Reconnect to this server to refresh membership and recipient details. No replacement conversation has been created.</p><button type="button" on:click={back}>Back to messages</button></div>{/if}
      </div>
    {/if}
  {:else}<DmHub surface="right" />{/if}
</section>

<style>
  .dm-tab { height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; color:var(--text-heading, #e8eded); background:var(--surface-base, #111b20); }
  .dm-content { flex:1; min-height:0; min-width:0; overflow:hidden; }.notes-header { display:flex; align-items:center; gap:12px; padding:12px; border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }.notes-header h2 { font-size:14px; margin:0; }
  button { min-height:36px; padding:8px 12px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-raised, #1b292f); font:inherit; font-size:12px; color:inherit; cursor:pointer; }button:focus-visible { outline:2px solid var(--accent-primary-color, #7cbeb2); outline-offset:2px; }
  .dm-unavailable { padding:24px 18px; line-height:1.6; }.dm-unavailable h3 { font-size:16px; }.dm-unavailable p { font-size:13px; color:var(--text-secondary, #b7c3c9); }
</style>
