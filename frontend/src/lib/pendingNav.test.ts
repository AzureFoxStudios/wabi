import {test,expect,afterEach} from 'bun:test';
import {completePendingNavAfterRender,clearPendingNav,peekPendingNav,setPendingNav,takePendingNav} from './pendingNav';
afterEach(clearPendingNav);
test('a not-yet-loaded or mismatched workspace leaves the target for the intended surface',()=>{
 setPendingNav({kind:'wiki_page',channelId:'wiki-a',pageId:'page-a'});
 expect(takePendingNav('forum_post','forum-a')).toBeNull();
 expect(takePendingNav('wiki_page','wiki-b')).toBeNull();
 expect(peekPendingNav()).toEqual({kind:'wiki_page',channelId:'wiki-a',pageId:'page-a'});
 expect(takePendingNav('wiki_page','wiki-a')).toEqual({kind:'wiki_page',channelId:'wiki-a',pageId:'page-a'});
 expect(peekPendingNav()).toBeNull();
});

test('reader selection runs after rendering and consumes only successful navigation',async()=>{
 const ref={kind:'wiki_page' as const,channelId:'wiki-a',pageId:'page-a'}; setPendingNav(ref);
 let rendered=false; let opened=false;
 expect(await completePendingNavAfterRender(ref,async()=>{rendered=true;},()=>true,()=>{expect(rendered).toBe(true);opened=true;return true;})).toBe(true);
 expect(opened).toBe(true); expect(peekPendingNav()).toBeNull();
 setPendingNav(ref);
 expect(await completePendingNavAfterRender(ref,async()=>{},()=>true,()=>false)).toBe(false);
 expect(peekPendingNav()).toBe(ref);
});
test('a replaced target or retired reader cannot open after rendering',async()=>{
 const ref={kind:'wiki_page' as const,channelId:'wiki-a',pageId:'page-a'};setPendingNav(ref);
 let opened=false;const open=()=>{opened=true;return true;};
 expect(await completePendingNavAfterRender(ref,async()=>{},()=>false,open)).toBe(false);
 expect(await completePendingNavAfterRender(ref,async()=>{setPendingNav({kind:'channel',channelId:'other'});},()=>true,open)).toBe(false);
 expect(opened).toBe(false);expect(peekPendingNav()).toEqual({kind:'channel',channelId:'other'});
});
