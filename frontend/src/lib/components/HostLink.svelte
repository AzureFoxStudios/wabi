<script lang="ts">
    import { onMount } from 'svelte';
    import { canUseDesktopHosting } from '$lib/desktopHosting';
    let available = $state(false);
    onMount(() => { let live = true; void canUseDesktopHosting().then(value => { if (live) available = value; }); return () => { live = false; }; });
</script>
{#if available}<a href="/host" title="Host a community and manage this computer’s server">Host</a>{/if}
<style>a { display: inline-flex; align-items: center; justify-content: center; min-width: 2.5rem; min-height: 2.5rem; margin: .4rem; padding: .4rem; color: var(--accent-secondary); border: 1px solid var(--border-default, #454560); border-radius: var(--radius-md); font-size: .8rem; text-decoration: none; }</style>
