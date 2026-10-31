<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 import { wikiCardExcerpt } from '$lib/forumPreview';
 import { parseMessage } from '$lib/markdown';
 import { objectRefStore, resolveObjectRef } from '$lib/objectRefRegistry';
 import { forumAuthors } from '$lib/forumIdentity';
 import { currentUser } from '$lib/presenceIdentity';
 import { forumReferenceEntities, forumShareNavigation } from '$lib/forumReferences';
 import { openGlance, openWebsiteGlance } from '$lib/glance';
 import { navigateToRef, type NavRef } from '$lib/navigateToRef';
 import { getServerUrl, activeServerUrl } from '$lib/serverUrl';
 import type { User } from '$lib/socket-types';
 import UserPopout from './UserPopout.svelte';
 import LinkPreview from './LinkPreview.svelte';
 import ForumLorePreview from './ForumLorePreview.svelte';
 import { channels } from '$lib/channelStore';
 import { createGalleryWorkspace } from '$lib/galleryStore';
 import { createWikiWorkspace } from '$lib/wikiStore';
 import { registerObjectRef, slugify } from '$lib/objectRefRegistry';
 import { authSessionGeneration } from '$lib/authSession';
 import { get } from 'svelte/store';
 import { createReferenceHydrator, type ReferenceSourceDescriptor } from '$lib/forumReferenceHydration';
 let referenceNotice = $state('');
 let previewUrls = $state<string[]>([]);
 let lorePreviews = $state<Array<{channelId:string;filePath:string;lines?:{start:number;end:number}}>>([]);
 const hydration = createReferenceHydrator(() => `${getServerUrl()}:${get(currentUser)?.dbUserId}:${authSessionGeneration(getServerUrl())}`,registerObjectRef);
 onDestroy(() => hydration.dispose());
 $effect(() => {
  $activeServerUrl; $currentUser?.dbUserId;
  if(!ready)return;
  const sources:ReferenceSourceDescriptor[]=$channels.flatMap<ReferenceSourceDescriptor>(channel=> {
   if(channel.type==='wiki')return [{id:channel.id,prefix:'w' as const,create:()=>{
    const workspace=createWikiWorkspace();
    return {dispose:workspace.dispose,load:async()=>{
     await workspace.loadWiki(channel.id);
     return get(workspace.wikiPagesStore).filter(page=>!page.isDeleted).map(page=>({kind:'wiki_page' as const,id:page.pageId,slug:page.slug || slugify(page.title),title:page.title,channelId:channel.id,subtitle:wikiCardExcerpt(page.body)}));
    }};
   }}];
   if(channel.type==='gallery')return [{id:channel.id,prefix:'g' as const,create:()=>{
    const workspace=createGalleryWorkspace();
    return {dispose:workspace.dispose,load:async()=>{
     await workspace.loadGallery(channel.id);
     return get(workspace.galleryItemsStore).map(item=>({kind:'gallery_work' as const,id:item.id,slug:slugify(item.attachmentName),title:item.attachmentName,channelId:channel.id,thumbUrl:item.attachmentUrl}));
    }};
   }}];
   return [];
  });
  const required:string[]=[];
  forumReferenceEntities(text,token=>{required.push(token);return null;});
  referenceNotice=required.length?'Loading linked items…':'';
  let current=true;
  void hydration.hydrate(text,sources).then(()=>{if(current)referenceNotice=required.some(token=>resolveObjectRef(token).status!=='unique')?'Some linked items are unavailable or ambiguous.':'';});
  return ()=>{current=false;};
 });
 $effect(() => {
  html; if (!container) return;
  lorePreviews = [...new Map([...container.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a=>forumShareNavigation(a.href,getServerUrl() || location.origin)).filter((ref): ref is Extract<NavRef,{kind:'lore_file'}> => ref?.kind === 'lore_file').map(ref=>[`${ref.channelId}:${ref.filePath}:${ref.lines ? ref.lines.start + '-' + ref.lines.end : ''}`,ref])).values()].slice(0,4);
  previewUrls = [...new Set([...container.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a => !a.closest('code, pre') && !forumShareNavigation(a.href, getServerUrl() || location.origin)).map(a => a.href).filter(href => /^https?:\/\//.test(href)))].slice(0,4);
 });
 let { text }: { text: string } = $props();
 let ready = $state(false);
 let container = $state<HTMLDivElement>();
 $effect(() => { html; if (!container) return; for (const token of container.querySelectorAll<HTMLElement>('[data-ref-kind], .mention-token, .spoiler')) { token.tabIndex = 0; token.setAttribute('role', token.classList.contains('spoiler') ? 'button' : 'link'); } });
 onMount(() => { ready = true; });
 // Links, references, mentions and spoilers inside the rendered HTML are delegated from the body.
 // The body itself is not a control (its post is the <article>), so the listeners are attached here
 // instead of as attributes that would give a plain container pointer and key handlers.
 $effect(() => {
  const node = container; if (!node) return;
  const onClick = (event: MouseEvent) => { void activate(event); };
  const onKey = (event: KeyboardEvent) => { if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement && event.target.matches('[data-ref-kind], .mention-token, .spoiler')) { event.preventDefault(); void activate(event); } };
  node.addEventListener('click', onClick);
  node.addEventListener('keydown', onKey);
  return () => { node.removeEventListener('click', onClick); node.removeEventListener('keydown', onKey); };
 });
 let navigationError = $state('');
 let profile = $state<User | null>(null), anchor = $state<HTMLElement | null>(null), profileOpen = $state(false);
 const html = $derived.by(() => {
  $objectRefStore; $activeServerUrl; $currentUser?.dbUserId;
  const entities = forumReferenceEntities(text, token => { const result = resolveObjectRef(token); return result.status === 'unique' ? result.record : null; });
  return ready ? parseMessage(text, entities, { allowTables: true }) : '';
 });
 const objectCards = $derived.by(() => {
  $objectRefStore;
  return forumReferenceEntities(text, token => { const result=resolveObjectRef(token); return result.status==='unique'?result.record:null; }).map(entity => [...$objectRefStore.values()].find(record=>record.kind===entity.kind && record.id===entity.targetId)).filter((record,index,list)=>!!record && list.findIndex(other=>other?.id===record.id && other?.kind===record.kind)===index).slice(0,4);
 });
 async function openObject(event: MouseEvent, record: NonNullable<(typeof objectCards)[number]>) {
  const ref: NavRef | null = record.kind==='wiki_page'?{kind:record.kind,pageId:record.id,channelId:record.channelId}:record.kind==='gallery_work'?{kind:record.kind,workId:record.id,channelId:record.channelId}:record.kind==='forum_post'?{kind:record.kind,postId:record.id,channelId:record.channelId}:record.kind==='place'?{kind:'place',placeId:record.id}:null;
  if(ref) try {if (event.altKey) { if (!openGlance(ref)) navigationError = 'Preview unavailable for this reference.'; return; } await navigateToRef(ref);}catch{navigationError='Could not open this reference.';}
 }
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
  if (ref) { event.preventDefault(); event.stopPropagation(); try { if (event.altKey) { if (!openGlance(ref)) navigationError = 'Preview unavailable for this reference.'; return; } await navigateToRef(ref); } catch { navigationError = 'Could not open this reference. Try again.'; } return; }
  if (event.altKey && target instanceof HTMLAnchorElement && openWebsiteGlance(target.href)) { event.preventDefault(); event.stopPropagation(); return; }
  if (target.classList.contains('mention-token')) {
   const name = target.textContent?.replace(/^@/, '').trim().toLowerCase();
   const user = [...$forumAuthors.values()].find(item => item.username.toLowerCase() === name || item.handle?.toLowerCase() === name);
   if (user) { event.preventDefault(); profile = user; anchor = target; profileOpen = true; }
  }
 }
</script>
<!-- Sanitized by the shared chat renderer; navigation is delegated to Wabi. -->
<div class="forum-rich-body w-prose" bind:this={container}>{@html html}</div>
{#each objectCards as record (`${record?.kind}:${record?.id}`)}{#if record}<button class="object-card" type="button" onclick={(event)=>openObject(event,record)} >{#if record.thumbUrl}<img src={record.thumbUrl} alt="" loading="lazy" />{/if}<span><small>{record.kind==='wiki_page'?'Wiki page':record.kind==='gallery_work'?'Gallery work':record.kind==='forum_post'?'Forum thread':'Map place'}</small><strong>{record.title}</strong>{#if record.subtitle}<span>{record.subtitle}</span>{/if}</span></button>{/if}{/each}
{#each lorePreviews as ref (`${ref.channelId}:${ref.filePath}:${ref.lines?.start ?? ''}-${ref.lines?.end ?? ''}`)}<ForumLorePreview channelId={ref.channelId} filePath={ref.filePath} lines={ref.lines} />{/each}
{#each previewUrls as url (url)}<LinkPreview {url} />{/each}
<span class="forum-ref-status" role="status">{navigationError || referenceNotice}</span>
{#if profileOpen}<UserPopout user={profile} bind:isOpen={profileOpen} anchorElement={anchor} isOwnProfile={profile?.dbUserId === $currentUser?.dbUserId} />{/if}
<style>
 /* The body is the one prose style (.w-prose, kit-prose.css): no scoped type here. Linked
    objects are objects in flow (§4.5): lift, hairline, the small in-flow shadow. */
 .object-card {
  display: flex; gap: 14px; align-items: center; box-sizing: border-box; width: 100%; max-width: 440px;
  margin: 18px 0 0; padding: 10px 14px; text-align: left; cursor: pointer;
  border: var(--w-bw) solid var(--w-line); border-radius: var(--radius-md);
  background: var(--w-lift); box-shadow: var(--w-shadow-1); color: var(--w-text);
  transition: border-color var(--w-dur-1) var(--w-ease);
 }
 .object-card:hover { border-color: var(--w-line-strong); }
 .object-card:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
 .object-card > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
 .object-card small { color: var(--w-faint); font: var(--w-t-kicker); letter-spacing: 0.12em; text-transform: uppercase; }
 .object-card strong { font: var(--w-t-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .object-card span span { color: var(--w-mute); font: var(--w-t-small); }
 .object-card img { flex: none; width: 64px; height: 64px; object-fit: cover; border-radius: var(--radius-inner); }
 .forum-rich-body :global(.emote) { display: inline-block; width: auto; height: 1.5em; max-width: 128px; max-height: 128px; margin: 0 0.1em; vertical-align: middle; }
 .forum-rich-body :global(.emoji-inline) { display: inline-block; width: auto; height: 1.2em; margin: 0 0.05em; vertical-align: -0.2em; }
 .forum-ref-status { display: block; margin-top: 8px; color: var(--w-faint); font: var(--w-t-small); }
 .forum-ref-status:empty { display: none; }
</style>
