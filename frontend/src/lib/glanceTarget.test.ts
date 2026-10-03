import {test, expect} from 'bun:test';
import {resolveGlanceChannel, websiteGlanceUrl, glanceMediaKind} from './glanceTarget';
const channels = [{id:'wiki',name:'Guides'},{id:'chat',name:'General'}];
test('Wiki target resolves without navigation and inaccessible owners are rejected',()=>{
 const ref = {kind:'wiki_page' as const,pageId:'p'};
 expect(resolveGlanceChannel(ref,channels,[{kind:'wiki_page',id:'p',channelId:'wiki'}])).toBe('wiki');
 expect(ref).toEqual({kind:'wiki_page',pageId:'p'});
 expect(resolveGlanceChannel({...ref,channelId:'removed'},channels,[])).toBeUndefined();
});
test('ambiguous cross-channel references fail closed',()=>{
 expect(resolveGlanceChannel({kind:'wiki_page',pageId:'p'},channels,[{kind:'wiki_page',id:'p',channelId:'wiki'},{kind:'wiki_page',id:'p',channelId:'chat'}])).toBeUndefined();
});
test('channel names and explicit Lore owners resolve from accessible channels',()=>{
 expect(resolveGlanceChannel({kind:'channel',channelId:'#general'},channels,[])).toBe('chat');
 expect(resolveGlanceChannel({kind:'lore_file',channelId:'wiki',filePath:'guide.md'},channels,[])).toBe('wiki');
});
test('website previews reject executable, local and malformed URLs',()=>{
 for(const href of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','not a URL']) expect(websiteGlanceUrl(href)).toBeNull();
 expect(websiteGlanceUrl('https://example.com/guide')).toBe('https://example.com/guide');
});
test('uploaded media uses a viewer rather than a blocked webpage iframe',()=>{
 expect(glanceMediaKind('https://example.com/uploads/file.PNG?signature=opaque')).toBe('image');
 expect(glanceMediaKind('https://example.com/clip.webm')).toBe('video');
 expect(glanceMediaKind('https://example.com/song.mp3')).toBe('audio');
 expect(glanceMediaKind('https://example.com/?filename=image.png')).toBeNull();
 expect(glanceMediaKind('not a URL')).toBeNull();
});
