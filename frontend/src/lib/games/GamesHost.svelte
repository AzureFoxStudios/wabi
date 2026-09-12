<script lang="ts">
  import { currentUser } from '$lib/socket';
  import { getServerUrl } from '$lib/serverUrl';
  import { authSessionGeneration } from '$lib/authSession';
  import { gamesDialog } from './navigation';
  let Workspace = $state<typeof import('./GamesWorkspace.svelte').default | null>(null);
  let loadError = $state('');
  $effect(() => {
    const request=$gamesDialog;
    const id=$currentUser?.dbUserId;
    if (request && (String(id)!==request.owner || getServerUrl()!==request.server || authSessionGeneration(request.server)!==request.generation)) {
      gamesDialog.set(null); return;
    }
    if (request && !Workspace) {
      let alive=true; loadError='';
      import('./GamesWorkspace.svelte').then(m=>{if(alive) Workspace=m.default;}).catch(()=>{if(alive) loadError='Could not open Games. Reload the app and try again.';});
      return ()=>{alive=false;};
    }
  });
</script>
{#if $gamesDialog && Workspace}
  {#key $gamesDialog}
    <Workspace request={$gamesDialog} onclose={() => gamesDialog.set(null)} />
  {/key}
{:else if $gamesDialog && loadError}
  <div role="alert">{loadError}<button onclick={() => gamesDialog.set(null)}>Close</button></div>
{/if}
