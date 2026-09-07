<script lang="ts">
  import { channels } from '../src/lib/channelStore';
  import GroupSettingsPanel from '../src/lib/components/GroupSettingsPanel.svelte';
  import CreateGroupModal from '../src/lib/components/CreateGroupModal.svelte';
  let isOpen = $state(false);
  let group = $derived($channels.find(channel => channel.id === 'group-test'));
</script>

<main>
  <button id="create-group" onclick={() => isOpen = true}>New group</button>
  <section aria-label="Group settings">
    {#if group}<GroupSettingsPanel channel={group} />{:else}<p>Group unavailable</p>{/if}
  </section>
  <CreateGroupModal bind:isOpen />
</main>

<style>
  main { max-width: 380px; padding: var(--space-4); color: var(--text-primary); background: var(--surface-base); }
  section { height: 600px; }
</style>
