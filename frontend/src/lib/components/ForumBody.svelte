<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 import { wikiCardExcerpt } from '$lib/forumPreview';
 import { parseMessage } from '$lib/markdown';
 import { objectRefStore, resolveObjectRef } from '$lib/objectRefRegistry';
 import { forumAuthors } from '$lib/forumIdentity';
 import { currentUser } from '$lib/presenceIdentity';
 import { forumReferenceEntities, forumShareNavigation } from '$lib/forumReferences';
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
 let lorePreviews = $state<Array<{channelId:string;filePath:string}>>([]);
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
  lorePreviews = [...new Map([...container.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a=>forumShareNavigation(a.href,getServerUrl() || location.origin)).filter((ref): ref is Extract<NavRef,{kind:'lore_file'}> => ref?.kind === 'lore_file').map(ref=>[`${ref.channelId}:${ref.filePath}`,ref])).values()].slice(0,4);
  previewUrls = [...new Set([...container.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a => !a.closest('code, pre') && !forumShareNavigation(a.href, getServerUrl() || location.origin)).map(a => a.href).filter(href => /^https?:\/\//.test(href)))].slice(0,4);
 });
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
 const objectCards = $derived.by(() => {
  $objectRefStore;
  return forumReferenceEntities(text, token => { const result=resolveObjectRef(token); return result.status==='unique'?result.record:null; }).map(entity => [...$objectRefStore.values()].find(record=>record.kind===entity.kind && record.id===entity.targetId)).filter((record,index,list)=>!!record && list.findIndex(other=>other?.id===record.id && other?.kind===record.kind)===index).slice(0,4);
 });
 async function openObject(record: NonNullable<(typeof objectCards)[number]>) {
  const ref: NavRef | null = record.kind==='wiki_page'?{kind:record.kind,pageId:record.id,channelId:record.channelId}:record.kind==='gallery_work'?{kind:record.kind,workId:record.id,channelId:record.channelId}:record.kind==='forum_post'?{kind:record.kind,postId:record.id,channelId:record.channelId}:record.kind==='place'?{kind:'place',placeId:record.id}:null;
  if(ref) try {await navigateToRef(ref);}catch{navigationError='Could not open this reference.';}
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
{#each objectCards as record (`${record?.kind}:${record?.id}`)}{#if record}<button class="object-card" type="button" onclick={()=>openObject(record)}>{#if record.thumbUrl}<img src={record.thumbUrl} alt="" loading="lazy" />{/if}<span><small>{record.kind==='wiki_page'?'Wiki page':record.kind==='gallery_work'?'Gallery work':record.kind==='forum_post'?'Forum thread':'Map place'}</small><strong>{record.title}</strong>{#if record.subtitle}<span>{record.subtitle}</span>{/if}</span></button>{/if}{/each}
{#each lorePreviews as ref (`${ref.channelId}:${ref.filePath}`)}<ForumLorePreview channelId={ref.channelId} filePath={ref.filePath} />{/each}
{#each previewUrls as url (url)}<LinkPreview {url} />{/each}
<span role="status">{navigationError || referenceNotice}</span>
{#if profileOpen}<UserPopout user={profile} bind:isOpen={profileOpen} anchorElement={anchor} isOwnProfile={profile?.dbUserId === $currentUser?.dbUserId} />{/if}
<style>
 .object-card {display:flex;gap:.8rem;align-items:center;width:100%;padding:.8rem;margin:.8rem 0;text-align:left;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--surface-raised);color:var(--text-primary);cursor:pointer;}
 .object-card>span {display:flex;flex-direction:column;gap:.3rem;} .object-card small,.object-card span span {color:var(--text-secondary);font-size:.8rem;} .object-card img {width:72px;height:72px;object-fit:cover;border-radius:var(--radius-sm);}
 .forum-rich-body :global(.mention-token-gallery_work), .forum-rich-body :global(.mention-token-forum_post), .forum-rich-body :global(.mention-token-wiki_page), .forum-rich-body :global(.mention-token-place) { display: inline-flex; padding: .3rem .55rem; margin: .12rem 0; border: 1px solid var(--border-default); border-radius: .45rem; background: var(--surface-base); font-weight: 500; }

 .forum-rich-body { overflow-wrap: anywhere; line-height: 1.65; }
 .forum-rich-body :global(p) { margin: 0 0 .8em; }
 .forum-rich-body :global(p:last-child) { margin-bottom: 0; }
 .forum-rich-body :global(pre) { overflow: auto; padding: .8em; border-radius: var(--radius-md); background: var(--surface-base); }
 .forum-rich-body :global(a), .forum-rich-body :global(.mention-token) { color: var(--accent-primary); cursor: pointer; }
 .forum-rich-body :global(table) { display: block; overflow: auto; border-collapse: collapse; }
 .forum-rich-body :global(td), .forum-rich-body :global(th) { padding: .35em .6em; border: 1px solid var(--border-default); }
</style>
