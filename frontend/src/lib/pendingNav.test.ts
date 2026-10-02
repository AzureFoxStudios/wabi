import {test,expect,afterEach} from 'bun:test';
import {clearPendingNav,peekPendingNav,setPendingNav,takePendingNav} from './pendingNav';
afterEach(clearPendingNav);
test('a not-yet-loaded or mismatched workspace leaves the target for the intended surface',()=>{
 setPendingNav({kind:'wiki_page',channelId:'wiki-a',pageId:'page-a'});
 expect(takePendingNav('forum_post','forum-a')).toBeNull();
 expect(takePendingNav('wiki_page','wiki-b')).toBeNull();
 expect(peekPendingNav()).toEqual({kind:'wiki_page',channelId:'wiki-a',pageId:'page-a'});
 expect(takePendingNav('wiki_page','wiki-a')).toEqual({kind:'wiki_page',channelId:'wiki-a',pageId:'page-a'});
 expect(peekPendingNav()).toBeNull();
});
