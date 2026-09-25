<script lang="ts">
  import { channels } from '../src/lib/channelStore';
  import GroupSettingsPanel from '../src/lib/components/GroupSettingsPanel.svelte';
  import CreateGroupModal from '../src/lib/components/CreateGroupModal.svelte';
  import DmHub from '../src/lib/components/DmHub.svelte';
  import DmConversationView from '../src/lib/components/DmConversationView.svelte';
  import { centerDmChannelId } from '../src/lib/layoutStoreStates';
  let isOpen = $state(false);
  let showHub = $state(false);
  let group = $derived($channels.find(channel => channel.id === 'group-test'));
  let centerGroup = $derived($channels.find(channel => channel.id === $centerDmChannelId && channel.type === 'group'));
</script>

<main>
  <button id="create-group" onclick={() => isOpen = true}>New group</button>
  <button id="show-message-hub" onclick={() => showHub = !showHub}>Toggle messages hub</button>
  {#if !showHub}
    <section aria-label="Group settings">
      {#if group}<GroupSettingsPanel channel={group} />{:else}<p>Group unavailable</p>{/if}
    </section>
  {/if}
  <CreateGroupModal bind:isOpen />
  {#if showHub}<aside class="hub" aria-label="Messages hub"><DmHub /></aside>{/if}
  {#if showHub && centerGroup}<aside class="conversation" aria-label="Center group conversation"><DmConversationView context="center" channelIdProp={centerGroup.id} channelProp={centerGroup} /></aside>{/if}
</main>

<style>
  main { max-width: 380px; padding: var(--space-4); color: var(--text-primary); background: var(--surface-base); }
  section { height: 600px; }
  .hub { position: fixed; inset: 2rem 2rem auto auto; width: min(720px, calc(100vw - 4rem)); height: 560px; z-index: 10; border: 1px solid var(--border-subtle); }
  .conversation { position: fixed; inset: 2rem auto auto 2rem; width: 400px; height: 560px; z-index: 10; border: 1px solid var(--border-subtle); }
  @media (max-width: 700px) { .conversation { display: none; } }
</style>
