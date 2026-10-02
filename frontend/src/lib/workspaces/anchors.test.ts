import {expect,test} from 'bun:test';
import * as Y from 'yjs';
import {textAnchor,textPosition,rangeAnchor,slideAnchor,parseAnchor,linkAnchor,describeAnchor} from './anchors';

test('passage anchors follow independent edits and identify deleted passages',()=>{
    const first=new Y.Doc(),body=first.getText('body');body.insert(0,'Hello คน 🙂 world');
    const from=body.toString().indexOf('คน'),to=body.toString().indexOf(' world');const anchor=textAnchor(body,from,to)!;
    const second=new Y.Doc();Y.applyUpdate(second,Y.encodeStateAsUpdate(first));second.getText('body').insert(0,'Prefix ');Y.applyUpdate(first,Y.encodeStateAsUpdate(second));
    expect(textPosition(first,anchor)).toEqual({from:from+7,to:to+7});
    const position=textPosition(first,anchor)!;body.delete(position.from,position.to-position.from);
    expect(describeAnchor(first,anchor).missing).toBe(true);expect(describeAnchor(first,anchor).quote).toBe('คน 🙂');
    first.destroy();second.destroy();
});
test('range references retain row identities after reordering and mark tombstones',()=>{
    const doc=new Y.Doc(),sheets=new Y.Map(),sheet=new Y.Map(),rows=new Y.Map(),columns=new Y.Map();doc.getMap('data').set('sheets',sheets);sheets.set('sheet1',sheet);sheet.set('rows',rows);sheet.set('columns',columns);rows.set('row1',{id:'row1',position:1});columns.set('col1',{id:'col1',position:1});
    const anchor=rangeAnchor('sheet1',['row1'],['col1'],'Private grades');expect(describeAnchor(doc,anchor).missing).toBe(false);
    rows.set('row1',{id:'row1',position:10});expect(describeAnchor(doc,anchor).missing).toBe(false);
    rows.set('row1',{id:'row1',position:10,removed:true});expect(describeAnchor(doc,anchor).missing).toBe(true);doc.destroy();
});
test('copied reference links exclude private titles and quoted content',()=>{
    const doc=new Y.Doc();doc.getText('body').insert(0,'SECRET TEXT');
    const raw=textAnchor(doc.getText('body'),0,11)!;expect(linkAnchor(raw)).not.toContain('SECRET');expect(parseAnchor(linkAnchor(raw))?.kind).toBe('text');
    expect(linkAnchor(slideAnchor('slide1','Private strategy'))).not.toContain('strategy');
    expect(parseAnchor('{"v":1,"kind":"text","start":[-1],"end":[2],"length":1,"quote":""}')).toBe(null);
    expect(parseAnchor('x'.repeat(5000))).toBe(null);doc.destroy();
});
