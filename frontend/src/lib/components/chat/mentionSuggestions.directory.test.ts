import {test,expect,mock} from 'bun:test';
import {writable} from 'svelte/store';
mock.module('$lib/channelStore',()=>({channels:writable([])}));
mock.module('$lib/objectRefRegistry',()=>({searchObjectRefs:()=>[]}));
const {mentionDirectory,computeMentionSuggestions}=await import('./mentionSuggestions');
import type {User} from '$lib/socket-types';
const user=(id:string,dbUserId:number,username:string,handle?:string)=>({id,dbUserId,username,handle}) as User;
test('offline registered members remain mentionable and online identity wins duplicates',()=>{
 const roster=[user('offline',2,'MinMin','min'),user('saved',1,'Old name')];
 const directory=mentionDirectory(roster,[user('socket',1,'wabi')]);
 expect(directory.map(u=>u.username)).toEqual(['MinMin','wabi']);
 expect(computeMentionSuggestions('@m',2,directory,'socket').suggestions.map(s=>s.label)).toEqual(['MinMin']);
 expect(computeMentionSuggestions('@min',4,directory,'socket').show).toBe(true);
 expect(computeMentionSuggestions('@',1,directory,'socket').suggestions.map(s=>s.label)).toEqual(['MinMin']);
});
