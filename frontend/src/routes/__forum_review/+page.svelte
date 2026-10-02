<script lang="ts">
 import ForumChannel from '$lib/components/ForumChannel.svelte';
 import WikiChannel from '$lib/components/WikiChannel.svelte';
 import { currentUser, serverMembers } from '$lib/presenceIdentity';
 import { activeServerUrl } from '$lib/serverUrl';
 import { getAuthToken, setAuthToken } from '$lib/authSession';
 import ForumBody from '$lib/components/ForumBody.svelte';
 import ObjectShareMenu from '$lib/components/ObjectShareMenu.svelte';
 import { onMount } from 'svelte';
 import { initializeTheme } from '$lib/theme/initTheme';
 const text = '**Bold** and *italic*, [website](https://wabi.chat), @Alice and #general.\n\n```rust\nlet message = "code stays code";\n```\n\n| Feature | Status |\n| --- | --- |\n| Rich text | Ready |\n\n![Wabi](/wabi-logo-small.webp)';

 let view = 'body';
 let ready = false;
 onMount(() => {
  void initializeTheme();
  const origin = location.origin, previousToken = getAuthToken(origin), originalFetch = window.fetch;
  activeServerUrl.set(origin); setAuthToken('local-review-only', origin);
  currentUser.set({id:'review',dbUserId:2,username:'Alice',highestRole:'owner',isRegistered:true} as any);
  serverMembers.set([{id:'offline',dbUserId:3,username:'Bryn',highestRole:'member',isRegistered:true} as any]);
  const now=Date.now()*1000;
  const posts = ['General','Bug','Feature'].map((category,index)=>({post_id:`post-${index}`,thread_id:`thread-${index}`,channel_id:'review',author_user_id:index===1?3:2,body:text,created_at_micros:now,is_thread_starter:true,title:`${category} discussion`,tags:[],votes_up:0,votes_down:0,category}));
  const pages = [{pageId:'guide',channelId:'review',title:'Community guide',body:'# Community guide\n\n## Getting started\nWelcome.\n\n## Places\nExplore together.',authorUserId:3,createdAtMicros:now,updatedAtMicros:now,parentPageId:'',slug:'guide',orderIndex:0,isDeleted:false},{pageId:'faq',channelId:'review',title:'Frequently asked questions',body:'# Questions\n\n## Help\nAsk a member.',authorUserId:2,createdAtMicros:now,updatedAtMicros:now,parentPageId:'guide',slug:'faq',orderIndex:1,isDeleted:false}];
  window.fetch=(async(input: RequestInfo | URL,init?: RequestInit)=>{
   const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,origin);
   const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
   if(url.origin===origin && url.pathname==='/api/channels/review/join') return json({joined:true,channelId:'review'});
   if(url.origin===origin && url.pathname.startsWith('/api/forum/review')) {
    if(init?.method==='DELETE'){const id=decodeURIComponent(url.pathname.split('/').pop()!);const at=posts.findIndex(post=>post.post_id===id);if(at>=0)posts.splice(at,1);return json({deleted:true});}
    return url.pathname.endsWith('/threads')?json({threads:posts}):json({posts:posts.filter(post=>url.pathname.includes(post.thread_id))});
   }
   if(url.origin===origin && url.pathname==='/api/wiki/review/pages') return json({pages});
   if(url.origin===origin && url.pathname.startsWith('/api/wiki/review/'))return json({revisions:[]});
   return originalFetch(input,init);
  }) as typeof window.fetch;
  ready=true;
  return ()=>{window.fetch=originalFetch;setAuthToken(previousToken,origin);};
 });
</script>
<nav>{#each ['body','forum','wiki'] as name}<button on:click={()=>view=name}>{name}</button>{/each}</nav>
{#if ready}{#if view==='forum'}<section class="workspace"><ForumChannel channelId="review"/></section>{:else if view==='wiki'}<section class="workspace"><WikiChannel channelId="review"/></section>{:else}<main><header><h1>Forum reading check</h1><ObjectShareMenu record={{kind:'wiki_page',id:'test',slug:'test',title:'Test',channelId:'test'}} menuLabel="Page actions" extraActions={[{label:'Revision history',run:()=>{}}]}/></header><ForumBody {text}/></main>{/if}{/if}
<style>.workspace{height:calc(100vh - 48px);background:var(--surface-base);color:var(--text-primary)}nav{height:48px;display:flex;gap:8px;align-items:center}nav button{padding:8px 16px;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default)}main{max-width:780px;margin:32px auto;padding:24px;background:var(--surface-base);color:var(--text-primary)}header{display:flex;align-items:center;justify-content:space-between}</style>
