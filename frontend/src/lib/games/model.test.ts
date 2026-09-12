import { describe, expect, test } from 'bun:test';
import { board, privateSelection, selections, steamLaunchUrl, steamStoreUrl, safeAuthorizeUrl, invitationIntersection } from './model';
import { createGameClient } from './client';
const game=()=>privateSelection({key:'steam:570',title:'Dota 2'});
describe('curated games and Steam boundaries',()=>{
  test('import defaults are private, with no invitation or favorite inference',()=>{expect(game()).toMatchObject({visibility:'private',invitations:false,favorite:false,rotation:true});});
  test('launch is not a session join and accepts only exact app identities',()=>{
    expect(steamLaunchUrl('steam:570')).toBe('steam://run/570');
    expect(steamStoreUrl('steam:570')).toBe('https://store.steampowered.com/app/570/');
    for(const key of ['steam:0','steam:01','steam:4294967296','steam:570//--flag','steam:570?x=1','steam:570\n','local:570']) expect(steamLaunchUrl(key)).toBeNull();
  });
  test('same titles with different identities are never silently merged',()=>{const a=game(),b={...game(),key:'steam:571'};a.visibility=b.visibility='server';a.invitations=b.invitations=true;expect(invitationIntersection([[a],[b]])).toEqual([]);});
  test('private selections never influence matches',()=>{const a={...game(),visibility:'server' as const,invitations:true};expect(invitationIntersection([[a],[game()]])).toEqual([]);expect(invitationIntersection([[a],[a]])).toEqual([{key:a.key,title:a.title}]);expect(invitationIntersection([[a],[{...a,invitations:false}]])).toEqual([]);});
  test('empty, oversized, duplicate and invalid selections fail',()=>{for(const value of [null,[game(),game()],Array(65).fill(game()),[{...game(),title:''}],[{...game(),tags:['x','x']}],[{...game(),visibility:'friends'}],[{...game(),note:'\u0000'}]]) expect(()=>selections(value)).toThrow();});
  test('Unicode limits agree with server code-point bounds',()=>{expect(selections([{...game(),title:'🐈'.repeat(120)}])[0].title).toHaveLength(240);expect(()=>selections([{...game(),title:'🐈'.repeat(121)}])).toThrow();});
  test('metadata and raw playtime cannot enter the saved shape',()=>{expect(selections([{...game(),playtime_forever:42}])[0]).not.toHaveProperty('playtime_forever');});
  test('rotation and favorites are independent and clear explicitly',()=>{const b=board({revision:'0',entries:[{...game(),rotation:false,favorite:true}],steamId:null,showSteamLink:false});expect(b.entries[0].favorite).toBe(true);expect(board({...b,entries:[]}).entries).toEqual([]);});
  test('only the fixed Steam login destination is accepted',()=>{expect(safeAuthorizeUrl('https://steamcommunity.com/openid/login?openid.mode=checkid_setup')).toContain('steamcommunity.com');for(const u of ['https://steamcommunity.com.evil.test/openid/login','http://steamcommunity.com/openid/login','https://u:p@steamcommunity.com/openid/login','javascript:alert(1)','https://steamcommunity.com/openid/login#x']) expect(()=>safeAuthorizeUrl(u)).toThrow();});
});
describe('game request ownership',()=>{
  const initial=()=>({server:'https://one.test',userId:'1',generation:1,token:'private-token'});
  test('bearer stays in a header and responses request no caching',async()=>{let seen:any;const c=createGameClient(initial, (async(u,o)=>{seen={u,o};return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});}) as unknown as typeof fetch);expect(await c.request<{ok:boolean}>('/games/me')).toEqual({ok:true});expect(seen.u).not.toContain('private-token');expect(seen.o.headers.Authorization).toBe('Bearer private-token');expect(seen.o.cache).toBe('no-store');expect(seen.o.credentials).toBe('omit');c.dispose();});
  for(const field of ['server','userId','generation','token'] as const) test(`late response discarded after ${field} changes`,async()=>{
    const ctx=initial();let resolve!:(r:Response)=>void;const c=createGameClient(()=>ctx,(()=>new Promise(r=>{resolve=r;})) as unknown as typeof fetch);
    const pending=c.request('/games/me');(ctx as any)[field]=field==='generation'?2:'changed';resolve(new Response('{}'));await expect(pending).rejects.toThrow('Session changed');c.dispose();
  });
  test('dispose aborts every in-flight request',async()=>{let signal:AbortSignal|undefined;const c=createGameClient(initial,((_,o)=>new Promise((_resolve,reject)=>{signal=o?.signal as AbortSignal;signal.addEventListener('abort',()=>reject(new TypeError('cancelled')));})) as unknown as typeof fetch);const pending=c.request('/games/me');c.dispose();expect(signal!.aborted).toBe(true);await expect(pending).rejects.toThrow('Session changed');});
  test('a failed mutation is never automatically retried',async()=>{let count=0;const c=createGameClient(initial,(async()=>{count++;throw new TypeError('network');}) as unknown as typeof fetch);await expect(c.request('/games/me','PUT',{})).rejects.toThrow('reload before retrying');expect(count).toBe(1);});
  test('server conflicts preserve a useful error',async()=>{const c=createGameClient(initial,(async()=>new Response('{"error":"Game selections changed. Reload before saving."}',{status:409})) as unknown as typeof fetch);await expect(c.request('/games/me','PUT',{})).rejects.toThrow('Reload before saving');});
});
