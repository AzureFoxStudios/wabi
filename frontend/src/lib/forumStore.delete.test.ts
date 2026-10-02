import { test, expect, mock } from 'bun:test';
import { get } from 'svelte/store';
let respond: (url:string,init?:RequestInit)=>Promise<Response>;
mock.module('$lib/authSession',()=>({getAuthToken:()=> 'fixture-token',onAuthSessionCleared:()=>()=>{}}));
mock.module('$lib/serverUrl',()=>({getServerUrl:()=> 'https://fixture.invalid'}));
mock.module('./api/channelAccess',()=>({fetchChannel:(_channel:string,url:string,init?:RequestInit)=>respond(url,init)}));
mock.module('./groupAccess',()=>({groupMembership:{realm:()=>{},onContextChanged:()=>()=>{},onRevoked:()=>()=>{}}}));
const {createForumWorkspace}=await import('./forumStore');
const post={post_id:'starter',thread_id:'thread',channel_id:'forum',author_user_id:2,title:'Title',body:'Body',is_thread_starter:true,created_at_micros:1};
const json=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status}));
test('confirmed deletion removes the thread and clears its selected view',async()=>{
 const w=createForumWorkspace();respond=()=>json({threads:[post]});await w.loadThreads('forum');w.forumSelectedThreadIdStore.set('thread');
 respond=(_url,init)=>{expect(init?.method).toBe('DELETE');return json({deleted:true});};
 expect(await w.deleteForumPost('forum','thread','starter')).toBe(true);expect(get(w.forumThreadsStore)).toEqual([]);expect(get(w.forumSelectedThreadIdStore)).toBeNull();w.dispose();
});
test('rejected deletion keeps the post visible and surfaces an error',async()=>{
 const w=createForumWorkspace();respond=()=>json({threads:[post]});await w.loadThreads('forum');respond=()=>json({},403);
 expect(await w.deleteForumPost('forum','thread','starter')).toBe(false);expect(get(w.forumThreadsStore)).toHaveLength(1);expect(get(w.forumErrorStore)).toContain('403');w.dispose();
});
test('late acknowledgement does not mutate a replacement channel',async()=>{
 const w=createForumWorkspace();respond=()=>json({threads:[post]});await w.loadThreads('forum');let resolve!:(value:Response)=>void;respond=()=>new Promise(done=>resolve=done);
 const pending=w.deleteForumPost('forum','thread','starter');respond=()=>json({threads:[{...post,post_id:'new',channel_id:'other'}]});await w.loadThreads('other');resolve(new Response('{"deleted":true}'));
 expect(await pending).toBe(false);expect(get(w.forumThreadsStore)[0].post_id).toBe('new');w.dispose();
});
