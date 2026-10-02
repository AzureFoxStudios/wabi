import { test, expect, mock } from 'bun:test';
import { writable } from 'svelte/store';
let context='server-a:account-1', previous=context, server='https://a.invalid';
mock.module('./serverUrl',()=>({getServerUrl:()=>server}));
const listeners: (()=>void)[]=[];
const places=writable<any[]>([]), placeScope=writable<{server:string;realm:string|null}|null>(null);
mock.module('./placeStore',()=>({placeRegistry:places,placeRegistryScope:placeScope}));
mock.module('./groupAccess',()=>({groupContext:()=>({server:'fixture',account:context}),groupMembership:{onContextChanged:(callback:()=>void)=>{listeners.push(callback);return()=>{};},realm:()=>{if(context!==previous){previous=context;for(const callback of listeners)callback();}return JSON.stringify(['fixture',context]);}}}));
const {registerObjectRef,resolveObjectRef,initObjectRefRegistry}=await import('./objectRefRegistry');
initObjectRefRegistry();
test('a server or account switch invalidates copied references before lookup',()=>{
 for(const next of ['server-b:account-1','server-b:account-2']) {
  registerObjectRef({kind:'wiki_page',id:'page',slug:'guide',title:'Guide',channelId:'wiki'});
  expect(resolveObjectRef('w/guide').status).toBe('unique');
  context=next;expect(resolveObjectRef('w/guide').status).toBe('miss');
 }
});

test('server replacement invalidates references even without an account-context event',()=>{
 registerObjectRef({kind:'place',id:'map',slug:'map',title:'Map',channelId:''});
 expect(resolveObjectRef('m/map').status).toBe('unique');
 server='https://anonymous-server.invalid';expect(resolveObjectRef('m/map').status).toBe('miss');
});

test('a retained place snapshot is not attributed to a replacement server',()=>{
 server='https://fresh.invalid';placeScope.set({server:'https://old.invalid',realm:JSON.stringify(['fixture',context])});places.set([{id:'old-place',name:'Old place'}]);
 expect(resolveObjectRef('m/old-place').status).toBe('miss');
 placeScope.set({server,realm:JSON.stringify(['fixture',context])});places.set([{id:'fresh-place',name:'Fresh place'}]);
 expect(resolveObjectRef('m/fresh-place').status).toBe('unique');
});
