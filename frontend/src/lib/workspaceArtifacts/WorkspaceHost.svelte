<script lang="ts">
  import type {Selection} from './navigation';
  import './workspace.css';
  let {selection}=$props<{selection:Selection}>();
</script>
<section class="wabi-workspace" aria-label="Documents and optional workspace tools">
  {#key selection.nonce}
    {#if selection.kind==='library'}{#await import('./Library.svelte') then module}<module.default />{:catch error}<p role="alert">{String(error)}</p>{/await}{:else if selection.kind==='audience'&&selection.id}{#await import('./Audience.svelte') then module}<module.default id={selection.id} />{:catch error}<p role="alert">{String(error)}</p>{/await}{:else}{#await import('./EditorShell.svelte') then module}<module.default {selection} />{:catch error}<p role="alert">{String(error)}</p>{/await}{/if}
  {/key}
</section>
