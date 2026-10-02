import { describe, test, expect } from 'bun:test';
import { forumReferenceEntities, forumShareNavigation } from './forumReferences';
describe('Forum references', () => {
 const record = {kind:'wiki_page' as const,id:'page-1',slug:'guide',title:'Guide',channelId:'wiki'};
 test('resolves copied references but leaves code and unknown references literal', () => {
  const text='Read ^w/guide, `^w/guide`\n```text\n^w/guide\n```\n^w/missing';
  const entities=forumReferenceEntities(text, token=>token==='w/guide'?record:null);
  expect(entities).toHaveLength(1); expect(text.slice(entities[0].start,entities[0].end)).toBe('^w/guide');
 });
 test('ignores escaped tokens, tilde fences, unclosed fences and existing link targets', () => {
  for (const text of ['\\^w/guide', '~~~text\n^w/guide\n~~~', '```text\n^w/guide', '[link](https://example.test/^w/guide)', '``^w/guide``']) expect(forumReferenceEntities(text, () => record)).toEqual([]);
 });
 test('routes each supported shared object link', () => {
  for(const [kind,key] of [['forum_post','postId'],['wiki_page','pageId'],['gallery_work','workId'],['place','placeId']]) {
   expect(forumShareNavigation(`/c/channel?ref=${kind}%3Aid`, 'https://wabi.chat')).toMatchObject({kind,[key]:'id'});
  }
 });
 test('rejects foreign origins, malformed paths and unsupported references', () => {
  for(const href of ['https://other.test/c/x?ref=wiki_page:id','javascript:alert(1)','/c/%zz?ref=wiki_page:id','/c/x?ref=unknown:id','/c/x?ref=wiki_page:']) expect(forumShareNavigation(href,'https://wabi.chat')).toBeNull();
 });
});
test('copied forum, wiki, image and map references retain their target kinds', () => {
 const kinds = {'f/thread':'forum_post','w/page':'wiki_page','g/image':'gallery_work','m/place':'place'} as const;
 const text='^f/thread ^w/page ^g/image ^m/place';
 const entities=forumReferenceEntities(text,token=>token in kinds?{kind:kinds[token as keyof typeof kinds],id:token,slug:token.split('/')[1],title:token,channelId:'channel'}:null);
 expect(entities.map(entity=>entity.kind)).toEqual(['forum_post','wiki_page','gallery_work','place']);
});
test('Lore file links keep authenticated project identity and path',()=>{
 expect(forumShareNavigation('/?wabiNav=lore_file&channelId=ch_abc&path=proof%2Ffile.txt','https://wabi.chat')).toEqual({kind:'lore_file',channelId:'ch_abc',filePath:'proof/file.txt'});
 for(const url of ['https://other.test/?wabiNav=lore_file&channelId=ch_abc&path=x','/?wabiNav=lore_file&channelId=ch_abc&path=../secret','/?wabiNav=lore_file&path=x']) expect(forumShareNavigation(url,'https://wabi.chat')).toBeNull();
});

test('copied references display the object title while keeping canonical source offsets', () => {
 const text='See ^g/image';
 const [ref]=forumReferenceEntities(text,()=>({kind:'gallery_work',id:'work',slug:'image',title:'My sketch.png',channelId:'gallery'}));
 expect(ref.displayText).toBe('My sketch.png');
 expect(text.slice(ref.start,ref.end)).toBe('^g/image');
});
