import {test,expect} from 'bun:test';
import {createReferenceHydrator,type ReferenceSourceDescriptor} from './forumReferenceHydration';
const record={kind:'wiki_page' as const,id:'page',slug:'guide',title:'Guide',channelId:'wiki'};
test('cold Wiki references load without mounting a Wiki workspace, and repeat renders coalesce',async()=>{
 let loads=0;const published:unknown[]=[];
 const source:ReferenceSourceDescriptor={id:'wiki',prefix:'w',create:()=>({load:async()=>{loads++;return [record];},dispose(){}})};
 const reader=createReferenceHydrator(()=> 'server/account/session',value=>published.push(value));
 await Promise.all([reader.hydrate('See ^w/guide',[source]),reader.hydrate('See ^w/guide again',[source])]);
 expect(loads).toBe(1);expect(published).toEqual([record]);reader.dispose();
});
test('code and escaped references never trigger metadata requests',async()=>{
 let loads=0;const reader=createReferenceHydrator(()=> 'scope',()=>{});
 await reader.hydrate('`^w/guide` \\^w/guide\n```\n^w/guide\n```',[{id:'wiki',prefix:'w',create:()=>({load:async()=>{loads++;return [record];},dispose(){}})}]);
 expect(loads).toBe(0);reader.dispose();
});
test('late old-account replies are discarded and scope changes dispose requests',async()=>{
 let scope='first',resolve!:(records:typeof record[])=>void,disposed=0;const published:unknown[]=[];
 const reader=createReferenceHydrator(()=>scope,value=>published.push(value));
 const pending=reader.hydrate('^w/guide',[{id:'wiki',prefix:'w',create:()=>({load:()=>new Promise(done=>{resolve=done;}),dispose(){disposed++;}})}]);
 scope='second';await reader.hydrate('',[]);resolve([record]);await pending;
 expect(disposed).toBe(1);expect(published).toEqual([]);reader.dispose();
});

test('removing an accessible channel retires its pending preview request',async()=>{
 let resolve!:(records:typeof record[])=>void,disposed=0;const published:unknown[]=[];
 const reader=createReferenceHydrator(()=> 'scope',value=>published.push(value));
 const pending=reader.hydrate('^w/guide',[{id:'wiki',prefix:'w',create:()=>({load:()=>new Promise(done=>{resolve=done;}),dispose(){disposed++;}})}]);
 await reader.hydrate('^w/guide',[]);resolve([record]);await pending;
 expect(disposed).toBe(1);expect(published).toEqual([]);reader.dispose();
});
