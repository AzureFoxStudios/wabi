<script lang="ts">
  import { steamLaunchUrl } from '$lib/games/model';
  let { messageText = '' }: {messageText?:string} = $props();
  const keys=$derived([...new Set([...messageText.matchAll(/(?:^|[\s(<])steam:\/\/run\/([1-9][0-9]{0,9})(?=$|[\s)>.,!?])/g)].map(m=>`steam:${m[1]}`).filter(k=>steamLaunchUrl(k)))].slice(0,8));
  function launch(key:string) {const url=steamLaunchUrl(key);if(url && window.confirm('Ask the local Steam client to launch this game? This does not join a session.')) window.location.href=url;}
</script>
{#if keys.length}<div class="steam-join-row">{#each keys as key}<button type="button" class="steam-join-button" onclick={()=>launch(key)} title="Requires a local Steam client; this is not a session invitation">Launch game</button>{/each}</div>{/if}
