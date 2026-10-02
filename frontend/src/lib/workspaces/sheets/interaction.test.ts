import {test,expect} from 'bun:test';
import * as Y from 'yjs';
import {initialize,orderedSheets,axes,setCell,setCells,versions,reorderRows,removeSheet,restoreSheet,addSheet,setStyle,styleOf,setColumnWidth,columnWidth,formatValue} from './model';
function fixture(){const doc=new Y.Doc();initialize(doc.getMap('data'));const data=doc.getMap('data'),first=orderedSheets(data)[0];return{doc,data,id:first.id,sheet:first.value};}
test('invalid bulk edits do not partially mutate a workbook',()=>{
    const {doc,data,id,sheet}=fixture(),rows=axes(sheet,'rows'),columns=axes(sheet,'columns');
    expect(()=>setCells(data,id,[{row:rows[0].id,column:columns[0].id,input:'first'},{row:'missing',column:columns[0].id,input:'bad'}],{})).toThrow();
    expect(versions(sheet,rows[0].id,columns[0].id)).toHaveLength(0);doc.destroy();
});
test('shared reordering preserves cell identities and invalid permutations are rejected',()=>{
    const {doc,data,id,sheet}=fixture(),rows=axes(sheet,'rows'),columns=axes(sheet,'columns');setCell(data,id,rows[0].id,columns[0].id,'00127',{});
    reorderRows(data,id,rows.map(row=>row.id).reverse(),{});expect(axes(sheet,'rows').at(-1)?.id).toBe(rows[0].id);expect(versions(sheet,rows[0].id,columns[0].id)[0].input).toBe('00127');
    expect(()=>reorderRows(data,id,[rows[0].id],{})).toThrow();doc.destroy();
});
test('removed sheets remain restorable and at least one stays visible',()=>{
    const {doc,data,id}=fixture();expect(()=>removeSheet(data,id,{})).toThrow();addSheet(data,'Second',2,2);removeSheet(data,id,{});expect(orderedSheets(data).some(sheet=>sheet.id===id)).toBe(false);restoreSheet(data,id,{});expect(orderedSheets(data)).toHaveLength(2);doc.destroy();
});
test('number formatting, wraps and column widths retain supported values',()=>{
    const {doc,data,id,sheet}=fixture(),row=axes(sheet,'rows')[0].id,column=axes(sheet,'columns')[0].id;
    setStyle(data,id,[{row,column}],{wrap:true,border:true,precision:1,currency:'THB',fill:'#aabbcc'},{});
    expect(styleOf(sheet,row,column).wrap).toBe(true);setColumnWidth(data,id,column,220,{});expect(columnWidth(sheet,column)).toBe(220);
    expect(()=>setColumnWidth(data,id,column,Infinity,{})).toThrow();expect(formatValue(.125,{format:'percent',precision:1})).toBe('12.5%');expect(formatValue(1.25,{format:'number',precision:3})).toBe('1.250');doc.destroy();
});
