import * as Y from 'yjs';
import {cellKey,heads,literal,parseFormula,renderFormula,shiftFormula,type Axis,type CellVersion,type Expr,type WorkbookSnapshot,type Scalar} from './formula';
export interface CellStyle {
    bold?:boolean;italic?:boolean;format?:'general'|'number'|'percent'|'currency'|'text'|'date';
    align?:'left'|'center'|'right';fill?:string;wrap?:boolean;border?:boolean;precision?:number;currency?:string;
}
export type YSheet=Y.Map<unknown>;
export interface CellTarget {row:string;column:string;}
const uid=()=>crypto.randomUUID();
function map<T>(parent:Y.Map<unknown>,name:string):Y.Map<T>{const value=parent.get(name);if(!(value instanceof Y.Map))throw new Error(`Workbook is missing ${name}`);return value as Y.Map<T>;}
export function sheets(data:Y.Map<unknown>){return map<YSheet>(data,'sheets');}
export function axes(sheet:YSheet,kind:'rows'|'columns'):Axis[]{return Array.from(map<Axis>(sheet,kind),([id,value])=>({...value,id})).filter(value=>!value.removed).sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));}
export function orderedSheets(data:Y.Map<unknown>){return Array.from(sheets(data),([id,value])=>({id,value})).filter(item=>!item.value.get('removed')).sort((a,b)=>Number(a.value.get('position'))-Number(b.value.get('position'))||a.id.localeCompare(b.id));}
function activeSheet(data:Y.Map<unknown>,id:string){const sheet=sheets(data).get(id);if(!sheet||sheet.get('removed'))throw new Error('Sheet was removed; its content is retained.');return sheet;}
export function initialize(data:Y.Map<unknown>){data.set('schema',1);data.set('sheets',new Y.Map<YSheet>());addSheet(data,'Sheet 1',100,20);}
export function addSheet(data:Y.Map<unknown>,name:string,rows=100,columns=20){
    const collection=sheets(data);if(collection.size>=20)throw new Error('This release supports up to 20 sheets including retained deleted sheets.');
    if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows>10000||columns>256||rows<1||columns<1)throw new Error('Sheet exceeds supported grid dimensions.');
    const sheet=new Y.Map<unknown>(),id=uid();collection.set(id,sheet);sheet.set('name',name.trim().slice(0,100)||'Sheet');sheet.set('position',collection.size);
    for(const key of ['rows','columns','ops','styles','structureEdits'])sheet.set(key,new Y.Map());
    for(let i=0;i<rows;i++){const id=uid();map<Axis>(sheet,'rows').set(id,{id,position:i});}
    for(let i=0;i<columns;i++){const id=uid();map<Axis>(sheet,'columns').set(id,{id,position:i});}
    return{id,sheet};
}
export function renameSheet(data:Y.Map<unknown>,id:string,name:string,origin:unknown){
    const sheet=activeSheet(data,id),title=name.trim().slice(0,100);if(!title)throw new Error('Sheet name cannot be empty.');
    if(orderedSheets(data).some(item=>item.id!==id&&String(item.value.get('name')).toLocaleLowerCase()===title.toLocaleLowerCase()))throw new Error('Choose a unique sheet name.');
    data.doc!.transact(()=>sheet.set('name',title),origin);
}
export function reorderSheet(data:Y.Map<unknown>,id:string,direction:-1|1,origin:unknown){
    const list=orderedSheets(data),index=list.findIndex(item=>item.id===id),other=list[index+direction];if(index<0||!other)return;
    data.doc!.transact(()=>{[list[index],list[index+direction]]=[list[index+direction],list[index]];list.forEach((item,index)=>item.value.set('position',index));},origin);
}
export function removeSheet(data:Y.Map<unknown>,id:string,origin:unknown){const sheet=activeSheet(data,id);if(orderedSheets(data).length<2)throw new Error('Keep at least one sheet.');data.doc!.transact(()=>sheet.set('removed',true),origin);}
export function restoreSheet(data:Y.Map<unknown>,id:string,origin:unknown){const sheet=sheets(data).get(id);if(!sheet)throw new Error('Retained sheet was not found.');data.doc!.transact(()=>sheet.set('removed',false),origin);}
export function snapshot(data:Y.Map<unknown>):WorkbookSnapshot {
    return{sheets:orderedSheets(data).map(({id,value})=>{
        const cells:Record<string,CellVersion[]>={};for(const[opId,op]of map<CellVersion>(value,'ops'))(cells[op.cell]||=[]).push({...op,id:opId});
        return{id,name:String(value.get('name')||'Sheet'),rows:axes(value,'rows'),columns:axes(value,'columns'),cells};
    })};
}
export function versions(sheet:YSheet,row:string,column:string){const cell=cellKey(row,column);return heads(Array.from(map<CellVersion>(sheet,'ops'),([id,value])=>({...value,id})).filter(value=>value.cell===cell));}
export function inputOf(version:CellVersion|undefined,book:WorkbookSnapshot,sheetId:string){return version?.expression?renderFormula(version.expression,book,sheetId):version?.input||'';}
export function setCell(data:Y.Map<unknown>,sheetId:string,row:string,column:string,input:string,origin:unknown,prepared?:{expression?:Expr;literal?:Scalar;cached?:Scalar;imported?:boolean},expectedParents?:string[]){
    if(input.length>8192)throw new Error('A cell may contain at most 8,192 characters.');const sheet=activeSheet(data,sheetId);
    if(!axes(sheet,'rows').some(item=>item.id===row)||!axes(sheet,'columns').some(item=>item.id===column))throw new Error('The target row or column was removed. Your entry has not moved to another cell.');
    const ops=map<CellVersion>(sheet,'ops');if(ops.size>=200000)throw new Error('Workbook edit history has reached its supported limit. Export a copy before continuing.');
    let expression=prepared?.expression,parseError:string|undefined;
    if(input.startsWith('=')&&!expression&&prepared?.literal===undefined){try{expression=parseFormula(input,snapshot(data),sheetId);}catch(error){parseError=error instanceof Error?error.message:'#UNSUPPORTED!';}}
    const id=uid(),version:CellVersion={id,cell:cellKey(row,column),input,parents:expectedParents??versions(sheet,row,column).map(value=>value.id),...(expression?{expression}:{}),...(parseError?{parseError}:{}),...(prepared||{})};
    data.doc!.transact(()=>ops.set(id,version),origin);
}
/** Preflight the whole batch: Yjs transactions do not roll back thrown errors. */
export function setCells(data:Y.Map<unknown>,sheetId:string,changes:(CellTarget&{input:string})[],origin:unknown){
    const sheet=activeSheet(data,sheetId),ops=map<CellVersion>(sheet,'ops');
    if(changes.length>20000||ops.size+changes.length>200000)throw new Error('Batch exceeds the supported edit-history limit; nothing was changed.');
    const rows=new Set(axes(sheet,'rows').map(row=>row.id)),columns=new Set(axes(sheet,'columns').map(column=>column.id));
    const book=snapshot(data),current=book.sheets.find(sheet=>sheet.id===sheetId)!,prepared:CellVersion[]=[];
    for(const change of changes){
        if(!rows.has(change.row)||!columns.has(change.column)||change.input.length>8192)throw new Error('A target or value is invalid; nothing was changed.');
        const id=uid(),cell=cellKey(change.row,change.column),version:CellVersion={id,cell,input:change.input,parents:heads(current.cells[cell]||[]).map(item=>item.id)};
        if(change.input.startsWith('=')){try{version.expression=parseFormula(change.input,book,sheetId);}catch(e){version.parseError=e instanceof Error?e.message:'#UNSUPPORTED!';}}
        prepared.push(version);
    }
    if(new Set(prepared.map(version=>version.cell)).size!==prepared.length)throw new Error('Batch contains duplicate target cells; nothing was changed.');
    data.doc!.transact(()=>{for(const version of prepared)ops.set(version.id,version);},origin);
}
export function paste(data:Y.Map<unknown>,sheetId:string,startRow:number,startColumn:number,values:string[][],origin:unknown){
    const sheet=activeSheet(data,sheetId),rows=axes(sheet,'rows'),columns=axes(sheet,'columns');
    if(!Number.isInteger(startRow)||!Number.isInteger(startColumn)||startRow<0||startColumn<0||startRow+values.length>rows.length||values.some(row=>startColumn+row.length>columns.length))throw new Error('Add enough rows and columns before pasting; nothing was changed.');
    const changes=values.flatMap((row,r)=>row.map((input,c)=>({row:rows[startRow+r].id,column:columns[startColumn+c].id,input})));setCells(data,sheetId,changes,origin);
}
function structure(sheet:YSheet,operation:string){const history=map<string>(sheet,'structureEdits');if(history.size>=20000)throw new Error('Workbook structure history is full.');return()=>history.set(uid(),operation);}
export function insertAxis(data:Y.Map<unknown>,sheetId:string,kind:'rows'|'columns',index:number,origin:unknown){
    const sheet=activeSheet(data,sheetId),list=axes(sheet,kind),target=map<Axis>(sheet,kind);
    if(!Number.isInteger(index)||index<0||index>list.length)throw new Error('Invalid insertion position.');
    if(list.length>=(kind==='rows'?10000:256)||target.size>=(kind==='rows'?12000:512))throw new Error('Grid dimension or retained-axis limit reached.');
    const previous=list[index-1]?.position??((list[0]?.position||0)-2),next=list[index]?.position??previous+2,position=(previous+next)/2;
    if(!Number.isFinite(position)||position===previous||position===next)throw new Error('This insertion position is exhausted; export a normalized copy.');
    const id=uid(),record=structure(sheet,'insert');data.doc!.transact(()=>{target.set(id,{id,position});record();},origin);return id;
}
export function removeAxis(data:Y.Map<unknown>,sheetId:string,kind:'rows'|'columns',id:string,origin:unknown){
    const sheet=activeSheet(data,sheetId),target=map<Axis>(sheet,kind),before=target.get(id);if(!before||before.removed)return;
    if(axes(sheet,kind).length<=1)throw new Error('A sheet needs at least one row and column.');const record=structure(sheet,'remove');data.doc!.transact(()=>{target.set(id,{...before,removed:true});record();},origin);
}
export function reorderRows(data:Y.Map<unknown>,sheetId:string,ids:string[],origin:unknown){
    const sheet=activeSheet(data,sheetId),list=axes(sheet,'rows');
    if(ids.length!==list.length||new Set(ids).size!==ids.length||list.some(row=>!ids.includes(row.id)))throw new Error('Rows changed. Refresh the view before reordering.');
    const rows=map<Axis>(sheet,'rows'),record=structure(sheet,'reorder');data.doc!.transact(()=>{ids.forEach((id,position)=>rows.set(id,{...rows.get(id)!,position}));record();},origin);
}
export function columnWidth(sheet:YSheet,id:string):number {const width=(map<Axis&{width?:number}>(sheet,'columns').get(id))?.width;return typeof width==='number'&&Number.isFinite(width)?Math.max(60,Math.min(600,width)):140;}
export function setColumnWidth(data:Y.Map<unknown>,sheetId:string,id:string,width:number,origin:unknown){
    const sheet=activeSheet(data,sheetId),columns=map<Axis&{width?:number}>(sheet,'columns'),before=columns.get(id);
    if(!before||before.removed||!Number.isInteger(width)||width<60||width>600)throw new Error('Column width must be 60–600 pixels.');data.doc!.transact(()=>columns.set(id,{...before,width}),origin);
}
export function styleOf(sheet:YSheet,row:string,column:string):CellStyle{return map<CellStyle>(sheet,'styles').get(cellKey(row,column))||{};}
export function setStyle(data:Y.Map<unknown>,sheetId:string,cells:CellTarget[],patch:CellStyle,origin:unknown){
    const sheet=activeSheet(data,sheetId),styles=map<CellStyle>(sheet,'styles'),rows=new Set(axes(sheet,'rows').map(row=>row.id)),columns=new Set(axes(sheet,'columns').map(column=>column.id));
    if(cells.length>20000||styles.size+cells.filter(cell=>!styles.has(cellKey(cell.row,cell.column))).length>200000)throw new Error('Formatting range exceeds the supported limit.');
    if(cells.some(cell=>!rows.has(cell.row)||!columns.has(cell.column)))throw new Error('A formatting target was removed.');
    if(patch.fill&&!/^#[0-9a-f]{6}$/i.test(patch.fill))throw new Error('Use a six-digit hexadecimal fill color.');
    if(patch.precision!==undefined&&(!Number.isInteger(patch.precision)||patch.precision<0||patch.precision>10))throw new Error('Decimal precision must be 0–10.');
    if(patch.currency!==undefined&&!/^[A-Z]{3}$/.test(patch.currency))throw new Error('Use a three-letter currency code.');
    data.doc!.transact(()=>{for(const cell of cells){const key=cellKey(cell.row,cell.column);styles.set(key,{...(styles.get(key)||{}),...patch});}},origin);
}
export function fill(data:Y.Map<unknown>,sheetId:string,from:{r:number;c:number},to:{r:number;c:number},origin:unknown){
    const book=snapshot(data),sheet=book.sheets.find(sheet=>sheet.id===sheetId);if(!sheet)throw new Error('Sheet unavailable.');
    if(!sheet.rows[from.r]||!sheet.columns[from.c]||!sheet.rows[to.r]||!sheet.columns[to.c])throw new Error('Fill target is outside the grid.');
    const source=heads(sheet.cells[cellKey(sheet.rows[from.r].id,sheet.columns[from.c].id)]||[]);if(source.length!==1)throw new Error('Choose one non-conflicting source cell.');
    const value=source[0],expression=value.expression?shiftFormula(value.expression,book,to.r-from.r,to.c-from.c):undefined;
    setCell(data,sheetId,sheet.rows[to.r].id,sheet.columns[to.c].id,expression?renderFormula(expression,book,sheetId):value.input,origin,expression?{expression}:value.literal!==undefined?{literal:value.literal}:undefined);
}
export function cachedResultIsStale(data:Y.Map<unknown>){for(const{value}of orderedSheets(data)){if(map<string>(value,'structureEdits').size)return true;for(const op of map<CellVersion>(value,'ops').values())if(!op.imported)return true;}return false;}
export function recoverRemoved(sheet:YSheet){const rows=new Set(axes(sheet,'rows').map(row=>row.id)),columns=new Set(axes(sheet,'columns').map(column=>column.id));return Array.from(map<CellVersion>(sheet,'ops').values()).filter(value=>{const[row,column]=value.cell.split('|');return !rows.has(row)||!columns.has(column);});}
export function formatValue(value:Scalar,style:CellStyle){
    if(value===null)return '';if(typeof value!=='number')return String(value);
    const precision=style.precision===undefined?undefined:Math.max(0,Math.min(10,style.precision));
    const digits=precision===undefined?{}:{minimumFractionDigits:precision,maximumFractionDigits:precision};
    switch(style.format){
        case'number':return value.toLocaleString('en-US',{maximumFractionDigits:4,...digits});
        case'percent':return value.toLocaleString('en-US',{style:'percent',maximumFractionDigits:2,...digits});
        case'currency':return value.toLocaleString('en-US',{style:'currency',currency:/^[A-Z]{3}$/.test(style.currency||'')?style.currency!:'USD',...digits});
        // Explicit native serial convention. Source-application date systems are
        // converted at import, never inferred from arbitrary text.
        case'date':{if(!Number.isFinite(value)||Math.abs(value)>2000000)return '#DATE!';const date=new Date(Date.UTC(1899,11,30)+Math.trunc(value)*86400000);return Number.isNaN(date.valueOf())?'#DATE!':date.toISOString().slice(0,10);}
        default:return String(value);
    }
}
export {Y,cellKey,heads,literal};
