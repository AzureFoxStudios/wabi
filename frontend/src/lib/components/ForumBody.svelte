<script lang="ts">
 import { onMount } from 'svelte';
 import { parseMessage } from '$lib/markdown';
 import { objectRefStore, resolveObjectRef } from '$lib/objectRefRegistry';
 import { forumAuthors } from '$lib/forumIdentity';
 import { currentUser } from '$lib/presenceIdentity';
 import { forumReferenceEntities, forumShareNavigation } from '$lib/forumReferences';
 import { navigateToRef, type NavRef } from '$lib/navigateToRef';
 import { getServerUrl, activeServerUrl } from '$lib/serverUrl';
 import type { User } from '$lib/socket-types';
 import UserPopout from './UserPopout.svelte';
 let { text }: { text: string } = $props();
 let ready = $state(false);
 let container = $state<HTMLDivElement>();
 $effect(() => { html; if (!container) return; for (const token of container.querySelectorAll<HTMLElement>('[data-ref-kind], .mention-token, .spoiler')) { token.tabIndex = 0; token.setAttribute('role', token.classList.contains('spoiler') ? 'button' : 'link'); } });
 onMount(() => { ready = true; });
 let navigationError = $state('');
 let profile = $state<User | null>(null), anchor = $state<HTMLElement | null>(null), profileOpen = $state(false);
 const html = $derived.by(() => {
  $objectRefStore; $activeServerUrl; $currentUser?.dbUserId;
  const entities = forumReferenceEntities(text, token => { const result = resolveObjectRef(token); return result.status === 'unique' ? result.record : null; });
  return ready ? parseMessage(text, entities, { allowTables: true }) : '';
 });
 async function activate(event: MouseEvent | KeyboardEvent) {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('[data-ref-kind], .mention-token, a, .spoiler'); if (!target) return;
  if (target.classList.contains('spoiler')) { target.classList.add('revealed'); return; }
  let ref: NavRef | null = null;
  const id = target.dataset.refId;
  if (id) {
   switch (target.dataset.refKind) {
    case 'channel': ref = { kind: 'channel', channelId: id }; break;
    case 'forum_post': ref = { kind: 'forum_post', postId: id }; break;
    case 'wiki_page': ref = { kind: 'wiki_page', pageId: id }; break;
    case 'gallery_work': ref = { kind: 'gallery_work', workId: id }; break;
   }
  }
  if (target.dataset.placeId) ref = { kind: 'place', placeId: target.dataset.placeId, layerId: target.dataset.placeLayerId, poiId: target.dataset.placePoiId };
  if (target instanceof HTMLAnchorElement) ref = forumShareNavigation(target.href, getServerUrl() || location.origin);
  if (ref) { event.preventDefault(); event.stopPropagation(); try { await navigateToRef(ref); } catch { navigationError = 'Could not open this reference. Try again.'; } return; }
  if (target.classList.contains('mention-token')) {
   const name = target.textContent?.replace(/^@/, '').trim().toLowerCase();
   const user = [...$forumAuthors.values()].find(item => item.username.toLowerCase() === name || item.handle?.toLowerCase() === name);
   if (user) { event.preventDefault(); profile = user; anchor = target; profileOpen = true; }
  }
 }
</script>
<!-- Sanitized by the shared chat renderer; navigation is delegated to Wabi. -->
<div class="forum-rich-body markdown-content" bind:this={container} role="article" onclick={activate} onkeydown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement && event.target.matches('[data-ref-kind], .mention-token, .spoiler')) { event.preventDefault(); void activate(event); } }}>{@html html}</div>
<span role="status">{navigationError}</span>
{#if profileOpen}<UserPopout user={profile} bind:isOpen={profileOpen} anchorElement={anchor} isOwnProfile={profile?.dbUserId === $currentUser?.dbUserId} />{/if}
<style>
 .forum-rich-body { overflow-wrap: anywhere; line-height: 1.65; }
 .forum-rich-body :global(p) { margin: 0 0 .8em; }
 .forum-rich-body :global(p:last-child) { margin-bottom: 0; }
 .forum-rich-body :global(pre) { overflow: auto; padding: .8em; border-radius: var(--radius-md); background: var(--surface-base); }
 .forum-rich-body :global(a), .forum-rich-body :global(.mention-token) { color: var(--accent-primary); cursor: pointer; }
 .forum-rich-body :global(table) { display: block; overflow: auto; border-collapse: collapse; }
 .forum-rich-body :global(td), .forum-rich-body :global(th) { padding: .35em .6em; border: 1px solid var(--border-default); }
</style>
