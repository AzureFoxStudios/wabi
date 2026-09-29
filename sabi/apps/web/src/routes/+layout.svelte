<script lang="ts">
  import '@fontsource/ibm-plex-sans-thai/400.css';
  import '@fontsource/ibm-plex-sans-thai/500.css';
  import '@fontsource/ibm-plex-sans-thai/600.css';
  import '../app.css';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import { get } from '$lib/api.ts';
  import { app, loadBoot, connectStream } from '$lib/state.svelte.ts';
  import Shell from '$components/Shell.svelte';

  let { children } = $props();
  let ready = $state(false);
  let failed = $state('');
  const bare = $derived(page.url.pathname.startsWith('/login') || page.url.pathname.startsWith('/setup') || page.url.pathname.endsWith('/print'));
  const isPublic = $derived(page.url.pathname.startsWith('/login') || page.url.pathname.startsWith('/setup'));

  $effect(() => {
    void page.url.pathname;
    const pub = isPublic;
    if (untrack(() => ready && app.boot)) return;
    // Leaving the login/setup page for the app: show the boot screen until the session is confirmed.
    if (!pub) untrack(() => (ready = false));
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
    })().catch((e) => {
      // 401s already redirect to /login inside the API client; anything else is shown, never a blank page.
      if ((e as { status?: number })?.status !== 401) failed = (e as Error)?.message || 'Could not reach the server.';
    });
  });
</script>

{#if failed}
  <div class="boot fail" role="alert">
    <p>{failed}</p>
    <button class="btn" onclick={() => location.reload()}>Reload</button>
  </div>
{:else if !ready || (!bare && !app.boot)}
  <div class="boot" aria-busy="true"></div>
{:else if bare}
  {@render children()}
{:else}
  <Shell>{@render children()}</Shell>
{/if}

<style>
  .boot { min-height: 100vh; }
  .fail { display: grid; place-content: center; gap: 12px; text-align: center; color: var(--ink-2, #555); }
</style>
