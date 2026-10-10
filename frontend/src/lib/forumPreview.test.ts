import {test,expect} from 'bun:test';
import {canPreviewLoreText,loreTextExcerpt,wikiCardExcerpt} from './forumPreview';
test('automatic Lore previews accept bounded source/text and leave binary or oversized files to the viewer',()=>{
 expect(canPreviewLoreText('src/main.rs',65536)).toBe(true);
 for(const [path,bytes] of [['a.rs',65537],['photo.png',100],['archive.zip',100],['a.txt',-1],['a.txt',NaN]] as const) expect(canPreviewLoreText(path,bytes)).toBe(false);
});
test('file excerpts bound lines and characters without interpreting reference or HTML syntax',()=>{
 const source='<script>alert(1)</script> ^w/guide\n'+Array.from({length:20},(_,i)=>`line ${i}`).join('\n');
 expect(loreTextExcerpt(source).split('\n')).toHaveLength(12);
 expect(loreTextExcerpt(source)).toStartWith('<script>alert(1)</script> ^w/guide');
 expect(loreTextExcerpt('x'.repeat(2000))).toHaveLength(1600);
});

test('Wiki cards omit image markup and destinations while retaining linked titles',()=>{
 expect(wikiCardExcerpt('# Guide\n A **wetland**. ![Screenshot](https://example.com/image.png) [Read more](https://example.com)')).toBe('Guide A wetland. Read more');
 expect(wikiCardExcerpt('x'.repeat(200))).toHaveLength(180);
});
