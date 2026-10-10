<script lang="ts">
 import { onMount } from 'svelte';
 import { glanceMediaKind } from '$lib/glanceTarget';
 import { glance, closeGlance, openGlance, openWebsiteGlance } from '$lib/glance';
 import { navigateToRef } from '$lib/navigateToRef';
 import { forumShareNavigation } from '$lib/forumReferences';
 import { getServerUrl } from '$lib/serverUrl';
 import { channels, channelMessages, joinChannel } from '$lib/socket';
 import { onAuthSessionCleared } from '$lib/authSession';
 import { modalFocus } from '$lib/actions/modalFocus';
 import { portal } from '$lib/actions/portal';
 import { groupMembership } from '$lib/groupAccess';
 import { activeServerUrl } from '$lib/serverUrl';
 import { currentUser } from '$lib/presenceIdentity';
 import type { NavRef } from '$lib/pendingNav';

 let Component = $state<any>(null);
 let props = $state<Record<string, unknown>>({});
 let error = $state('');
 let loading = $state(false);
 const channel = $derived($glance && 'ref' in $glance ? $channels.find(item => item.id === $glance.channelId) : undefined);
 const messages = $derived(channel ? ($channelMessages[channel.id] || []) : []);
 const mediaKind = $derived($glance && 'url' in $glance ? glanceMediaKind($glance.url) : null);
 const title = $derived(channel?.name || ($glance && 'url' in $glance ? $glance.title || new URL($glance.url).hostname : 'Preview'));

 $effect(() => {
  const target = $glance;
  Component = null; props = {}; error = ''; loading = !!target;
  let active = true;
  if (!target || 'url' in target) { loading = false; return; }
  const id = target.channelId, ref = target.ref;
  if (ref.kind !== 'place' && (!id || !channel)) { error = 'This destination is no longer available.'; loading = false; return; }
  const kind = channel?.type;
  void (async () => {
   try {
    if (ref.kind === 'place') {
     const module = await import('$lib/addons/server-map/MapWorkspace.svelte');
     if (active) { Component = module.default; props = {variant: 'compact', initialPlaceId: ref.placeId, previewLayerId: ref.layerId ?? null, previewPoiId: ref.poiId ?? null, preview: true}; }
    } else if (kind === 'wiki') {
     const module = await import('./WikiChannel.svelte');
     if (active) { Component = module.default; props = {channelId: id, draftSurface: 'glance', previewPageId: ref.kind === 'wiki_page' ? ref.pageId : undefined}; }
    } else if (kind === 'forum') {
     const module = await import('./ForumChannel.svelte');
     if (active) { Component = module.default; props = {channelId: id, draftSurface: 'glance', previewPostId: ref.kind === 'forum_post' ? ref.postId : undefined}; }
    } else if (kind === 'gallery') {
     const module = await import('./GalleryChannel.svelte');
     if (active) { Component = module.default; props = {channelId: id, previewWorkId: ref.kind === 'gallery_work' ? ref.workId : undefined, preview: true}; }
    } else if (kind === 'lore') {
     const module = await import('./lore/LoreProjectWorkspace.svelte');
     if (active) { Component = module.default; props = {channelKey: id, projectName: channel?.name || 'Lore', serverUrl: getServerUrl(), accountId: String($currentUser?.dbUserId ?? ''), roleName: $currentUser?.highestRole || '', compactHeader: true, preview: true, initialFilePath: ref.kind === 'lore_file' ? ref.filePath : undefined}; }
    } else if (kind === 'text') {
     joinChannel(id);
     const module = await import('./MessageList.svelte');
     if (active) { Component = module.default; props = {channelId: id, messageDomScope: 'glance'}; }
    } else if (active) error = 'This workspace does not support an embedded preview yet. Continue to open it.';
   } catch { if (active) error = 'Could not load this preview. Continue to try opening the destination.'; }
   finally { if (active) loading = false; }
  })();
  return () => { active = false; };
 });

 async function proceed() {
  const target = $glance;
  if (!target) return;
  try {
   if ('url' in target) window.open(target.url, '_blank', 'noopener,noreferrer');
   else await navigateToRef(target.ref);
   closeGlance();
  } catch { error = 'Could not open this destination.'; }
 }
 onMount(() => {
  const stopAuth = onAuthSessionCleared(closeGlance);
  const stopRevocation = groupMembership.onRevoked(({channelId}) => { if ($glance && 'ref' in $glance && $glance.channelId === channelId) closeGlance(); });
  let server: string | undefined, account: number | undefined;
  const stopServer = activeServerUrl.subscribe(next => { if (server !== undefined && server !== next) closeGlance(); server = next; });
  const stopAccount = currentUser.subscribe(next => { const id = next?.dbUserId; if (account !== undefined && account !== id) closeGlance(); account = id; });
  function intercept(event: MouseEvent) {
   if (!event.altKey || event.button !== 0 || !(event.target instanceof Element)) return;
   const node = event.target.closest<HTMLElement>('a[href], [data-ref-kind], [data-place-id]');
   if (!node || (node instanceof HTMLAnchorElement && node.getAttribute('href')?.startsWith('#'))) return;
   let ref: NavRef | null = null;
   const id = node.dataset.refId;
   if (node.dataset.placeId) ref = {kind:'place',placeId:node.dataset.placeId,layerId:node.dataset.placeLayerId,poiId:node.dataset.placePoiId};
   if (id) {
    if (node.dataset.refKind === 'channel') ref = {kind:'channel',channelId:id};
    if (node.dataset.refKind === 'wiki_page') ref = {kind:'wiki_page',pageId:id};
    if (node.dataset.refKind === 'forum_post') ref = {kind:'forum_post',postId:id};
    if (node.dataset.refKind === 'gallery_work') ref = {kind:'gallery_work',workId:id};
   }
   if (node instanceof HTMLAnchorElement) ref = forumShareNavigation(node.href, getServerUrl() || location.origin) || ref;
   const opened = ref ? openGlance(ref) : node instanceof HTMLAnchorElement && openWebsiteGlance(node.href, node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || undefined);
   if (opened || ref) {event.preventDefault();event.stopImmediatePropagation();}
  }
  document.addEventListener('click', intercept, true);
  return () => {stopAuth(); stopRevocation(); stopServer(); stopAccount(); document.removeEventListener('click', intercept, true); closeGlance();};
 });
</script>

{#if $glance}
 <!-- svelte-ignore a11y_click_events_have_key_events -->
 <div class="glance-backdrop" use:portal role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closeGlance(); }}>
  <div class="glance-dialog" role="dialog" aria-modal="true" aria-label={`Preview: ${title}`} tabindex="-1" use:modalFocus={closeGlance}>
   <header><strong>{title}</strong><button onclick={closeGlance} aria-label="Close preview">✕</button></header>
   <div class="glance-page">
    {#if loading}<p role="status">Loading preview…</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if Component}{#key $glance}{#if channel?.type === 'text'}<Component {...props} {messages} />{:else}<Component {...props} />{/if}{/key}
    {:else if $glance && 'url' in $glance}
     {#if mediaKind === 'image'}<div class="glance-media"><img src={$glance.url} alt={title} onerror={() => error = 'Could not load this image.'} /></div>
     {:else if mediaKind === 'video'}<div class="glance-media"><video src={$glance.url} controls aria-label={title} onerror={() => error = 'Could not load this video.'}></video></div>
     {:else if mediaKind === 'audio'}<div class="glance-media"><audio src={$glance.url} controls aria-label={title} onerror={() => error = 'Could not load this audio.'}></audio></div>
     {:else}<p class="website-note">Some websites block embedded previews. Use Continue to site if the page stays blank.</p>
      <iframe title={`Preview of ${title}`} src={$glance.url} sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer"></iframe>
     {/if}

    {/if}
   </div>
   <footer><span>Alt-click a link to preview · Escape to close</span><button onclick={proceed}>{$glance && 'url' in $glance ? 'Continue to site' : 'Continue to destination'} →</button></footer>
  </div>
 </div>
{/if}

<style>
 .glance-backdrop{position:fixed;inset:0;z-index:var(--z-modal,1000);background:var(--w-scrim);display:grid;place-items:center;padding:clamp(12px,4vw,48px);}
 .glance-dialog{width:min(100%,980px);height:min(82dvh,900px);display:flex;flex-direction:column;outline:none;color:var(--w-text);}
 header strong{font:600 calc(18px * var(--w-fs, 1))/1.2 var(--w-serif);}footer span{font-family:var(--w-mono);}header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;flex-shrink:0;}header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
 button{border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));background:var(--w-raise);color:var(--w-text);padding:8px 12px;cursor:pointer;}button:focus-visible{outline:2px solid var(--accent-primary);}
 .glance-page{position:relative;flex:1;min-height:0;overflow:auto;background:var(--w-bg2);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));box-shadow:0 20px 70px rgba(0,0,0,.4);}
 .glance-page>p{padding:16px;}iframe{width:100%;height:calc(100% - 60px);border:0;background:white;}.website-note,footer span{font-size:.8rem;color:var(--w-mute);}
 .glance-media{display:grid;place-items:center;min-height:100%;padding:16px;box-sizing:border-box;}.glance-media img,.glance-media video{max-width:100%;max-height:65dvh;object-fit:contain;}.glance-media audio{width:min(100%,600px);}
 .glance-page :global(.lightbox-backdrop){position:absolute;z-index:1;}
 @media(max-width:600px){.glance-dialog{height:90dvh;}footer span{display:none;}footer{justify-content:flex-end;}}
</style>
