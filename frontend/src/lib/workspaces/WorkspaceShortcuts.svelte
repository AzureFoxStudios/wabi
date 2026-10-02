<script lang="ts">
    import { openWorkspace } from './bridge';
</script>
<nav aria-label="Document workspace tools" class="workspace-shortcuts">
    <button type="button" onclick={()=>openWorkspace('documents')}>Shared Documents</button>
    <button type="button" onclick={()=>openWorkspace('sheets')}>Sheets addon</button>
    <button type="button" onclick={()=>openWorkspace('present')}>Present addon</button>
    <button type="button" onclick={()=>openWorkspace('audience')}>Join presentation</button>
</nav>
<style>.workspace-shortcuts{display:flex;gap:.4rem;flex-wrap:wrap;padding:.4rem .65rem;border-bottom:1px solid var(--border-subtle,#35384c)}button{font:12px var(--font-sans,system-ui);background:var(--surface-raised,#24283d);color:var(--text-primary,#eef0f8);border:1px solid var(--border-subtle,#484c66);border-radius:5px;padding:.4rem .6rem;cursor:pointer}button:focus-visible{outline:2px solid var(--accent-primary,#a7a6ff);outline-offset:2px}</style>
