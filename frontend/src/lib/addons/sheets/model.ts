import type { Fields, Json } from '../../workspaceArtifacts/model';
export type Ref = {sheet: string; row: string; col: string; absRow: boolean; absCol: boolean};
export type Expr = {type:'value'; value:number|string|boolean} | {type:'ref'; ref:Ref} | {type:'range'; from:Ref; to:Ref} | {type:'unary'; op:string; right:Expr} | {type:'binary'; op:string; left:Expr; right:Expr} | {type:'call'; name:string; args:Expr[]};
export type Cell = {raw:string; ast?:Expr; unsupported?:boolean; cached?:string|number|boolean};
export type Sheet = {name:string; rows:string[]; columns:string[]};
export const cellKey = (sheet:string,row:string,col:string) => `c:${sheet}:${row}:${col}`;
export const sheetKey = (id:string) => `s:${id}`;
export function columnName(n:number):string { let s=''; for(n++; n>0; n=Math.floor((n-1)/26)) s=String.fromCharCode(65+(n-1)%26)+s; return s; }
export function columnIndex(s:string):number { return [...s.toUpperCase()].reduce((a,c)=>a*26+c.charCodeAt(0)-64,0)-1; }
export function sheetIds(f:Fields):string[] { return Array.isArray(f.sheets) ? f.sheets.filter((v):v is string=>typeof v==='string') : []; }
export function getSheet(f:Fields,id:string):Sheet { const s=f[sheetKey(id)] as unknown as Sheet; if(!s || !Array.isArray(s.rows) || !Array.isArray(s.columns)) throw new Error('Invalid sheet'); return s; }
export function createSheet(name='Sheet 1',rows=100,columns=20):{id:string; fields:Fields} {
  const id=crypto.randomUUID();
  return {id,fields:{[sheetKey(id)]:{name,rows:Array.from({length:rows},()=>crypto.randomUUID()),columns:Array.from({length:columns},()=>crypto.randomUUID())}}};
}
export function newWorkbook():Fields { const s=createSheet(); return {title:'Untitled sheet',sheets:[s.id],...s.fields}; }
export function getCell(f:Fields,s:string,r:string,c:string):Cell { const value=f[cellKey(s,r,c)]; return value && typeof value==='object' && !Array.isArray(value) ? value as unknown as Cell : {raw:''}; }
export function resolveRef(f:Fields,sheetId:string,token:string):Ref {
  const match=token.match(/^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(\$?)([A-Za-z]+)(\$?)([1-9][0-9]*)$/);
  if(!match) throw new Error('Invalid cell reference');
  let sid=sheetId;
  const name=match[1]?.replace(/''/g,"'") || match[2];
  if(name) sid=sheetIds(f).find(id=>getSheet(f,id).name.toLowerCase()===name.toLowerCase()) || '';
  if(!sid) throw new Error('Unknown sheet');
  const s=getSheet(f,sid), row=s.rows[Number(match[6])-1], col=s.columns[columnIndex(match[4])];
  // Missing references remain explicitly invalid, never point at another cell.
  return {sheet:sid,row:row || `missing-row-${match[6]}`,col:col || `missing-col-${match[4]}`,absRow:!!match[5],absCol:!!match[3]};
}
export function formatRef(f:Fields,ref:Ref,currentSheet:string):string {
  let s:Sheet; try{s=getSheet(f,ref.sheet);}catch{return '#REF!';}
  const r=s.rows.indexOf(ref.row), c=s.columns.indexOf(ref.col);
  if(r<0 || c<0) return '#REF!';
  const prefix=ref.sheet===currentSheet?'':`'${s.name.replace(/'/g,"''")}'!`;
  return `${prefix}${ref.absCol?'$':''}${columnName(c)}${ref.absRow?'$':''}${r+1}`;
}
export function formulaText(f:Fields,sid:string,e:Expr):string {
  switch(e.type){
    case 'value':return typeof e.value==='string'?`"${e.value.replace(/"/g,'""')}"`:String(e.value).toUpperCase();
    case 'ref':return formatRef(f,e.ref,sid);
    case 'range':return `${formatRef(f,e.from,sid)}:${formatRef(f,e.to,sid)}`;
    case 'unary':return e.op==='%'?`(${formulaText(f,sid,e.right)})%`:`${e.op}(${formulaText(f,sid,e.right)})`;
    case 'binary':return `(${formulaText(f,sid,e.left)}${e.op}${formulaText(f,sid,e.right)})`;
    case 'call':return `${e.name}(${e.args.map(x=>formulaText(f,sid,x)).join(',')})`;
  }
}
export function rawText(f:Fields,sid:string,cell:Cell):string { return cell.ast?'='+formulaText(f,sid,cell.ast):cell.raw; }
export function shiftFormula(f:Fields,ast:Expr,dr:number,dc:number):Expr {
  const out=structuredClone(ast);
  function ref(r:Ref){ const s=getSheet(f,r.sheet); if(!r.absRow) r.row=s.rows[s.rows.indexOf(r.row)+dr] || 'missing-row'; if(!r.absCol) r.col=s.columns[s.columns.indexOf(r.col)+dc] || 'missing-col'; }
  function visit(e:Expr){if(e.type==='ref') ref(e.ref); else if(e.type==='range'){ref(e.from);ref(e.to);}else if(e.type==='unary') visit(e.right);else if(e.type==='binary'){visit(e.left);visit(e.right);}else if(e.type==='call')e.args.forEach(visit);}
  visit(out);return out;
}
export function asJson(value:unknown):Json { return value as Json; }
