<script lang="ts">
  import '@fontsource/ibm-plex-sans-thai/400.css';
  import '@fontsource/ibm-plex-sans-thai/500.css';
  import '@fontsource/ibm-plex-sans-thai/600.css';
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { app, loadBoot, connectStream } from '$lib/state.svelte.ts';
  import Shell from '$components/Shell.svelte';

  let { children } = $props();
  let ready = $state(false);
  const bare = $derived(page.url.pathname.startsWith('/login') || page.url.pathname.startsWith('/setup') || page.url.pathname.endsWith('/print'));
  const isPublic = $derived(page.url.pathname.startsWith('/login') || page.url.pathname.startsWith('/setup'));

  $effect(() => {
    void page.url.pathname;
    if (ready && app.boot) return;
    (async () => {
      const s = await get('session');
      if (!s.setUp && !page.url.pathname.startsWith('/setup')) return goto('/setup', { replaceState: true });
      if (!s.user) {
        if (!isPublic) return goto(`/login?next=${encodeURIComponent(page.url.pathname + page.url.search)}`, { replaceState: true });
        ready = true;
        return;
      }
      if (isPublic) return goto('/', { replaceState: true });
      await loadBoot();
      connectStream();
      ready = true;
    })().catch(() => (ready = true));
  });
</script>

{#if !ready}
  <div class="boot" aria-busy="true"></div>
{:else if bare || !app.boot}
  {@render children()}
{:else}
  <Shell>{@render children()}</Shell>
{/if}

<style>
  .boot { min-height: 100vh; }
</style>
