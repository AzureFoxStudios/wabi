import { describe, test, expect } from 'bun:test';
import * as Y from 'yjs';
import { initialize, snapshot, orderedSheets, axes, setCell, insertAxis, removeAxis, recoverRemoved, versions, fill } from './model';
import { calculate, columnIndex, columnName, cellKey, literal, parseFormula, renderFormula } from './formula';
function base(){const doc=new Y.Doc();initialize(doc.getMap('data'));return doc;}
function clone(doc:Y.Doc){const copy=new Y.Doc();Y.applyUpdate(copy,Y.encodeStateAsUpdate(doc));return copy;}
function first(doc:Y.Doc){const data=doc.getMap('data'),{id,value}=orderedSheets(data)[0];return{data,id,value,rows:axes(value,'rows'),columns:axes(value,'columns')};}
function write(doc:Y.Doc,r:number,c:number,value:string,origin:unknown='test'){const s=first(doc);setCell(s.data,s.id,s.rows[r].id,s.columns[c].id,value,origin);}
function result(doc:Y.Doc,r:number,c:number){const s=first(doc),key=`${s.id}/${cellKey(s.rows[r].id,s.columns[c].id)}`,calc=calculate(snapshot(s.data));return calc.errors[key]||calc.values[key];}
function exchange(a:Y.Doc,b:Y.Doc){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au);}

describe('native spreadsheet formulas',()=>{
    test('column coordinates round trip',()=>{for(const n of [0,25,26,51,52,255,701])expect(columnIndex(columnName(n))).toBe(n);});
    test('literal entry preserves leading zeros and date-like identifiers',()=>{expect(literal('00127')).toBe('00127');expect(literal('1/2')).toBe('1/2');expect(literal('12')).toBe(12);expect(literal('false')).toBe(false);expect(literal('')).toBe(null);});
    test('arithmetic and the supported aggregation set',()=>{const d=base();write(d,0,0,'10');write(d,1,0,'20');write(d,2,0,'30');write(d,0,1,'=SUM(A1:A3)');write(d,1,1,'=AVERAGE(A1:A3)');write(d,2,1,'=IF(A1<15,ROUND(1.235,2),99)');expect(result(d,0,1)).toBe(60);expect(result(d,1,1)).toBe(20);expect(result(d,2,1)).toBe(1.24);d.destroy();});
    test('errors propagate and unsupported formulas do not become zero',()=>{const d=base();write(d,0,0,'=1/0');write(d,0,1,'=A1+2');write(d,1,0,'=WEBSERVICE("https://example.invalid/")');expect(result(d,0,0)).toBe('#DIV/0!');expect(result(d,0,1)).toBe('#DIV/0!');expect(result(d,1,0)).toBe('#UNSUPPORTED!');d.destroy();});
    test('cycle detection terminates',()=>{const d=base();write(d,0,0,'=B1');write(d,0,1,'=A1');expect(result(d,0,0)).toBe('#CYCLE!');d.destroy();});
    test('stable references follow column insertion',()=>{const d=base();write(d,0,0,'7');write(d,0,1,'=A1*3');const s=first(d);insertAxis(s.data,s.id,'columns',0,'test');expect(result(d,0,2)).toBe(21);const book=snapshot(s.data),op=book.sheets[0].cells[cellKey(s.rows[0].id,s.columns[1].id)][0];expect(renderFormula(op.expression!,book,s.id)).toContain('B1');d.destroy();});
    test('fill shifts relative references but preserves absolute references',()=>{const d=base();write(d,0,0,'5');write(d,1,0,'9');write(d,0,1,'=A1+$A$1');const s=first(d);fill(s.data,s.id,{r:0,c:1},{r:1,c:1},'test');expect(result(d,1,1)).toBe(14);d.destroy();});
    test('bounded parser rejects oversized input',()=>{const d=base(),s=first(d);expect(()=>parseFormula('='+Array(9000).fill('1').join('+'),snapshot(s.data),s.id)).toThrow('#LIMIT!');d.destroy();});
});

describe('independent-client spreadsheet merge behavior',()=>{
    test('concurrent scalar values remain alternatives, never concatenated digits',()=>{const seed=base(),a=clone(seed),b=clone(seed);write(a,0,0,'12');write(b,0,0,'13');exchange(a,b);const s=first(a);expect(versions(s.value,s.rows[0].id,s.columns[0].id).map(v=>v.input).sort()).toEqual(['12','13']);expect(result(a,0,0)).toBe('#CONFLICT!');expect(result(b,0,0)).toBe('#CONFLICT!');write(a,0,0,'14');exchange(a,b);expect(result(a,0,0)).toBe(14);expect(result(b,0,0)).toBe(14);seed.destroy();a.destroy();b.destroy();});
    test('different cells survive offline edits and repeated delivery',()=>{const seed=base(),a=clone(seed),b=clone(seed);write(a,0,0,'William');write(b,0,1,'42');exchange(a,b);exchange(a,b);expect(result(a,0,0)).toBe('William');expect(result(a,0,1)).toBe(42);expect(snapshot(first(a).data)).toEqual(snapshot(first(b).data));seed.destroy();a.destroy();b.destroy();});
    test('a concurrent row deletion never shifts someone’s edit onto the next row',()=>{const seed=base(),a=clone(seed),b=clone(seed),s=first(a);removeAxis(s.data,s.id,'rows',s.rows[0].id,'delete');write(b,0,0,'Do not lose this');exchange(a,b);expect(result(a,0,0)).toBeUndefined();expect(recoverRemoved(first(a).value).some(v=>v.input==='Do not lose this')).toBe(true);expect(first(a).rows[0].id).toBe(s.rows[1].id);seed.destroy();a.destroy();b.destroy();});
    test('undo tracks the local author instead of rewinding the whole workbook',()=>{const seed=base(),a=clone(seed),b=clone(seed),origin={};const undo=new Y.UndoManager(first(a).data,{trackedOrigins:new Set([origin])});write(a,0,0,'Mine',origin);write(b,0,1,'Theirs');exchange(a,b);undo.undo();exchange(a,b);expect(result(a,0,0)).toBeUndefined();expect(result(a,0,1)).toBe('Theirs');undo.destroy();seed.destroy();a.destroy();b.destroy();});
});
