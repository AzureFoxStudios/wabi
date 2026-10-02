import { test, expect } from 'bun:test';
import { emptyInk, readNoteInk, saveNoteInk, checkedInk, inkPreview } from './ink';
test('ink edits replace the same sheet and preserve surrounding writing',()=>{
 const ink=emptyInk();ink.strokes=[{color:'#172326',width:3,points:[[10,20],[30,40]]}];
 const text=saveNoteInk('Before',ink,'data:image/png;base64,YQ==')+'\nAfter';
 expect(readNoteInk(text)).toEqual(ink);
 const changed={...ink,guide:'dots' as const};const saved=saveNoteInk(text,changed,'data:image/png;base64,Yg==');
 expect(saved.startsWith('Before')).toBe(true);expect(saved.endsWith('After')).toBe(true);
 expect(saved.match(/wabi-note-ink/g)?.length).toBe(1);expect(readNoteInk(saved)).toEqual(changed);
});
test('ink input refuses executable colors, malformed points and oversized documents',()=>{
 expect(()=>checkedInk({...emptyInk(),strokes:[{color:'url(javascript:1)',width:3,points:[[1,2]]}]})).toThrow();
 expect(()=>checkedInk({...emptyInk(),strokes:[{color:'#000000',width:3,points:[[Infinity,2]]}]})).toThrow();
 expect(()=>saveNoteInk('x'.repeat(2_000_000),emptyInk(),'data:image/png;base64,YQ==')).toThrow();
 expect(readNoteInk('<!--wabi-note-ink:v1:invalid-->')).toBeNull();
});
test('only bounded inline PNG previews render, with no remote images or SVG execution',()=>{
 expect(inkPreview('data:image/png;base64,YQ==')).toBe(true);
 for(const source of ['https://tracker.test/a.png','data:image/svg+xml;base64,YQ==','data:image/png;base64,YQ==" onerror="alert(1)'])expect(inkPreview(source)).toBe(false);
});

import { strokeTouches } from './ink';
test('eraser hits the middle of a sparse stroke without removing distant strokes', () => {
 const stroke = { color: '#000000', width: 3, points: [[0, 0], [100, 0]] as [number, number][] };
 expect(strokeTouches(stroke, [50, 5])).toBe(true);
 expect(strokeTouches(stroke, [50, 40])).toBe(false);
});

import { noteWritingText, replaceNoteWriting } from './ink';
test('typing surface hides portable ink data and prose edits preserve the drawing', () => {
 const text = saveNoteInk('Original prose', emptyInk(), 'data:image/png;base64,YQ==');
 expect(noteWritingText(text)).toBe('Original prose');
 const changed = replaceNoteWriting(text, 'New prose');
 expect(noteWritingText(changed)).toBe('New prose');
 expect(readNoteInk(changed)).toEqual(emptyInk());
 expect(changed).toContain('data:image/png;base64,YQ==');
});
