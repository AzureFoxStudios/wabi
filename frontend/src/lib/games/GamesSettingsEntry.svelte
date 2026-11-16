<script lang="ts">
	import { _ } from '$lib/i18n';
  import { openGames } from './navigation';
</script>
<section class="games-settings-entry">
  <h3>{$_('games_ws.title_own')}</h3>
  <p>{$_('gse.desc')}</p>
  <div><button onclick={() => openGames()}>{$_('gse.open_board')}</button><button onclick={() => openGames({tab:'steam'})}>{$_('games_ws.tab_steam')}</button></div>
</section>
<style>
.games-settings-entry{padding:1.2rem;margin:1rem 0;border:1px solid var(--border-subtle);border-radius:12px;background:var(--surface-raised);color:var(--text-primary);}
h3{margin:0 0 .5rem;}p{color:var(--text-secondary);font-size:.9rem;line-height:1.5;}div{display:flex;gap:.6rem;flex-wrap:wrap;}button{border:1px solid var(--border-subtle);border-radius:8px;padding:.65rem .9rem;background:var(--surface-base);color:var(--text-primary);font:inherit;cursor:pointer;}button:hover,button:focus-visible{border-color:var(--accent-primary-color);}
</style>
