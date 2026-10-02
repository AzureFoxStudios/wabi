import { test, expect, mock, afterAll } from 'bun:test';
import { get } from 'svelte/store';
let server='https://a.invalid', realm='a:1', previous=realm;
const listeners:(()=>void)[]=[];
mock.module('$app/environment',()=>({browser:true,dev:true,building:false}));
mock.module('./serverUrl',()=>({getServerUrl:()=>server}));
mock.module('./groupAccess',()=>({groupMembership:{realm:()=>{if(realm!==previous){previous=realm;listeners.forEach(fn=>fn());}return realm;},onContextChanged:(fn:()=>void)=>{listeners.push(fn);return()=>{};}}}));
mock.module('./api/utils',()=>({parseApiJson:(response:Response)=>response.json()}));
mock.module('./localMockApi',()=>({isLocalMockApiMode:()=>false,getLocalMockPlaces:()=>[]}));
mock.module('./optionalEndpoints',()=>({isEndpointUnsupported:()=>false,markEndpointUnsupported:()=>{}}));
mock.module('./placeNormalization',()=>({normalizeRegistryPayload:(rows:unknown[])=>rows}));
const {loadPlaceRegistry,placeRegistry,placeRegistryLoading,publishPlaceRegistry}=await import('./placeStore');
const originalFetch=globalThis.fetch;
afterAll(()=>{globalThis.fetch=originalFetch;});
const json=(id:string)=>new Response(JSON.stringify({places:[{id}]}));
test('late place response cannot repopulate the previous server registry',async()=>{
 let resolve!:(response:Response)=>void;
 globalThis.fetch=(()=>new Promise(done=>resolve=done)) as unknown as typeof fetch;
 const old=loadPlaceRegistry(true);
 server='https://b.invalid';realm='b:1';globalThis.fetch=(async()=>json('fresh')) as unknown as typeof fetch;
 await loadPlaceRegistry(true);resolve(json('old'));expect(await old).toEqual([]);
 expect(get(placeRegistry)[0].id).toBe('fresh');expect(get(placeRegistryLoading)).toBe(false);
});
test('account replacement cancels an older request on the same server',async()=>{
 let resolve!:(response:Response)=>void;
 globalThis.fetch=(()=>new Promise(done=>resolve=done)) as unknown as typeof fetch;
 const old=loadPlaceRegistry(true);
 realm='b:2';globalThis.fetch=(async()=>json('account-two')) as unknown as typeof fetch;
 await loadPlaceRegistry(true);resolve(json('account-one'));expect(await old).toEqual([]);
 expect(get(placeRegistry)[0].id).toBe('account-two');
});

test('server change bypasses a completed cache without an account-context event',async()=>{
 server='https://c.invalid';let calls=0;globalThis.fetch=(async()=>{calls+=1;return json('server-c');}) as unknown as typeof fetch;
 await loadPlaceRegistry();expect(calls).toBe(1);expect(get(placeRegistry)[0].id).toBe('server-c');
});

test('a mutation acknowledgement from a retired scope cannot publish into the current registry',()=>{
 expect(publishPlaceRegistry([{id:'retired'}] as any,{server:'https://previous.invalid',realm:'b:1'})).toBe(false);
 expect(get(placeRegistry)[0].id).toBe('server-c');
});
