import type { Fields, Json } from '../../workspaceArtifacts/model';
import { xml, all, children, first, text, escape as x, partPath, type XNode } from '../../workspaceArtifacts/formats/xml';
import { readZip, writeZip, zipText } from '../../workspaceArtifacts/formats/zip';
import { createSheet, getSheet, getCell, sheetIds, sheetKey, cellKey, columnIndex, columnName, rawText, formulaText, shiftFormula, type Cell } from './model';
import { makeCell, literal, createCalculator } from './formula';
import { writeDelimited } from './csv';

export interface WorkbookImport {fields: Fields; warnings: string[]}
export interface WorkbookExport {name: string; bytes: Uint8Array; mime: string; warnings: string[]}
interface ImportedCell {row:number; col:number; raw:string; formula?:string; cached?:string|number|boolean; format?:string; shared?:string; sharedOrigin?:boolean}
interface ImportedSheet {name:string; cells:ImportedCell[]; rows:number; columns:number; hidden?:boolean}
const MAX_CELLS=200_000;
const DECLARATION='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SML='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL='http://schemas.openxmlformats.org/package/2006/relationships';
const ODF_NS='xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';
function filename(title:unknown,extension:string){return String(title||'workbook').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,100)+'.'+extension;}
function positions(address:string):[number,number]{const m=address.match(/^([A-Za-z]+)([1-9][0-9]*)$/);if(!m)throw new Error('Invalid workbook cell address');const row=Number(m[2])-1,col=columnIndex(m[1]);if(row>=100_000||col>=256)throw new Error('Populated cells exceed 100,000 rows or 256 columns');return [row,col];}
function native(sheets:ImportedSheet[],title:string,warnings:string[],dateSystem='1900'):WorkbookImport{
  if(!sheets.length||sheets.length>100)throw new Error('A workbook must contain 1–100 sheets');
  const fields:Fields={title,sheets:[],dateSystem};const names=new Set<string>(),ids:string[]=[];
  for(const s of sheets){if(!s.name||s.name.length>200||names.has(s.name.toLowerCase()))throw new Error('Duplicate, empty, or oversized sheet name');names.add(s.name.toLowerCase());const created=createSheet(s.name,Math.max(100,s.rows),Math.max(20,s.columns));ids.push(created.id);Object.assign(fields,created.fields);}
  fields.sheets=ids;let populated=0,unsupported=0,sharedMissing=0;
  for(let index=0;index<sheets.length;index++){
    const sid=ids[index],s=getSheet(fields,sid),source=sheets[index],shared=new Map<string,{cell:Cell;row:number;col:number}>();
    // Masters are independent of XML order, and all sheet identities already exist.
    for(const c of source.cells)if(c.sharedOrigin&&c.shared&&c.formula)shared.set(c.shared,{cell:makeCell(fields,sid,'='+c.formula),row:c.row,col:c.col});
    const seen=new Set<string>();
    for(const c of source.cells){
      if(++populated>MAX_CELLS)throw new Error('Workbook exceeds 200,000 populated cells');
      const k=cellKey(sid,s.rows[c.row],s.columns[c.col]);if(seen.has(k))throw new Error('Duplicate cell address');seen.add(k);
      let cell:Cell;
      if(c.formula!==undefined)cell=makeCell(fields,sid,'='+c.formula);
      else if(c.shared){const master=shared.get(c.shared);if(master?.cell.ast)cell={raw:'=',ast:shiftFormula(fields,master.cell.ast,c.row-master.row,c.col-master.col)};else{cell={raw:'=UNSUPPORTED_SHARED_FORMULA()',unsupported:true};sharedMissing++;}}
      else cell={raw:c.raw};
      if(cell.unsupported){unsupported++;if(c.cached!==undefined)cell.cached=c.cached;}
      fields[k]=cell as unknown as Json;
      if(c.format)fields['f:'+k.slice(2)]={format:c.format};
    }
    if(source.hidden)warnings.push(`Hidden source sheet “${source.name}” was imported visibly into this private copy. Hidden sheets are not a privacy boundary.`);
  }
  if(unsupported)warnings.push(`${unsupported} unsupported formulas were retained, not calculated. Cached source results are historical only.`);
  if(sharedMissing)warnings.push(`${sharedMissing} shared-formula followers could not be resolved; they are marked unsupported.`);
  if(JSON.stringify(fields).length>32*1024*1024)throw new Error('Native workbook exceeds 32 MiB');
  return {fields,warnings};
}
export function workbookFromRows(rows:string[][],title='Imported sheet',textOnly=true):Fields{
  if(rows.length>100_000)throw new Error('Too many rows');const cells:ImportedCell[]=[];let columns=1;
  rows.forEach((row,r)=>{if(row.length>256)throw new Error('Too many columns');columns=Math.max(columns,row.length);row.forEach((value,c)=>{if(value.length>65536)throw new Error('Cell text exceeds 65,536 characters');if(value!=='')cells.push({row:r,col:c,raw:textOnly?"'"+value:value.startsWith('=')?"'"+value:value});if(cells.length>MAX_CELLS)throw new Error('Too many populated cells');});});
  return native([{name:'Sheet 1',cells,rows:rows.length,columns}],title,[]).fields;
}
function paragraphText(n:XNode):string {return all(n,'p').map(text).join('\n');}
export async function importWorkbookBytes(buffer:ArrayBuffer,name:string):Promise<WorkbookImport>{
  const zip=await readZip(buffer),warnings=['Import preserves cell data and the supported formula subset. Pivot tables, macros, embedded objects, conditional formatting, rich styles, and imported charts are not editable in this copy. Keep the original for full fidelity.'];
  if(/\.ods$/i.test(name)){
    const root=xml(await zipText(zip,'content.xml')),tables=all(root,'table').filter(t=>t.name==='table:table');const sheets:ImportedSheet[]=[];let populated=0;
    for(const table of tables){
      const cells:ImportedCell[]=[],rows=all(table,'table-row');let row=0,maxRow=0,maxCol=0;
      for(const r of rows){const repeat=Number(r.attrs['table:number-rows-repeated']||1);if(!Number.isSafeInteger(repeat)||repeat<1||repeat>1_048_576)throw new Error('Invalid repeated row count');let col=0;const values:ImportedCell[]=[];
        for(const c of children(r).filter(c=>['table:table-cell','table:covered-table-cell'].includes(c.name))){const cr=Number(c.attrs['table:number-columns-repeated']||1);if(!Number.isSafeInteger(cr)||cr<1||cr>16384)throw new Error('Invalid repeated column count');const type=c.attrs['office:value-type'],formula=c.attrs['table:formula'];let raw='';let cached:string|number|boolean|undefined;
          if(type==='float'||type==='percentage'||type==='currency'){raw=c.attrs['office:value']||'';if(raw&&!Number.isFinite(Number(raw)))throw new Error('Invalid numeric cell');if(raw)cached=Number(raw);}
          else if(type==='boolean'){raw=c.attrs['office:boolean-value']==='true'?'TRUE':'FALSE';cached=raw==='TRUE';}
          else {const t=type==='date'?c.attrs['office:date-value']||'':type==='time'?c.attrs['office:time-value']||'':paragraphText(c);if(t!==''||type==='string'){raw="'"+t;cached=t;}}
          if(formula||raw){if(row+repeat>100_000||col+cr>256)throw new Error('Populated ODS cells exceed row/column limits');for(let n=0;n<cr;n++)values.push({row:0,col:col+n,raw,formula:formula?fromOdfFormula(formula):undefined,cached,format:type==='percentage'?'percent':type==='currency'?'currency':undefined});}
          col+=cr;
        }
        if(values.length){if(populated+values.length*repeat>MAX_CELLS)throw new Error('Repeated ODS cells exceed the populated cell limit');for(let n=0;n<repeat;n++)for(const c of values)cells.push({...c,row:row+n});populated+=values.length*repeat;maxRow=row+repeat;maxCol=Math.max(maxCol,...values.map(c=>c.col+1));}
        row+=repeat;
      }
      sheets.push({name:table.attrs['table:name']||`Sheet ${sheets.length+1}`,cells,rows:maxRow,columns:maxCol});
    }
    const epoch=first(root,'null-date')?.attrs['table:date-value'];
    if(epoch&&epoch!=='1899-12-30'&&epoch!=='1904-01-01')warnings.push('Nonstandard ODS date epoch: date-like values remain source values.');
    return native(sheets,name.replace(/\.ods$/i,''),warnings,epoch==='1904-01-01'?'1904':'1900');
  }
  if(!/\.xlsx$/i.test(name))throw new Error('Only XLSX and ODS workbook containers are supported');
  const workbookPath='xl/workbook.xml',workbook=xml(await zipText(zip,workbookPath)),relationships=xml(await zipText(zip,'xl/_rels/workbook.xml.rels'));
  const relations=new Map(all(relationships,'Relationship').filter(r=>r.attrs.TargetMode!=='External').map(r=>[r.attrs.Id,partPath(workbookPath,r.attrs.Target)]));
  let strings:string[]=[];if(zip.has('xl/sharedStrings.xml'))strings=all(xml(await zipText(zip,'xl/sharedStrings.xml')),'si').map(n=>all(n,'t').map(text).join(''));
  const formats:string[]=[];
  if(zip.has('xl/styles.xml')){const style=xml(await zipText(zip,'xl/styles.xml')),custom=new Map(all(style,'numFmt').map(n=>[n.attrs.numFmtId,n.attrs.formatCode]));const cellXfs=first(style,'cellXfs');for(const xf of cellXfs?children(cellXfs,'xf'):[]){const id=Number(xf.attrs.numFmtId),code=custom.get(String(id))||'';formats.push(id===9||id===10||/%/.test(code)?'percent':id>=14&&id<=22||/[ymd]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g,''))?'date':id===49?'text':id>=1&&id<=4?'number':'general');}}
  const sheets:ImportedSheet[]=[];
  for(const source of all(workbook,'sheet')){
    const path=relations.get(source.attrs['r:id']);if(!path)throw new Error('Missing or external worksheet relationship');const root=xml(await zipText(zip,path)),cells:ImportedCell[]=[];let maxRow=0,maxCol=0;
    for(const c of all(root,'c')){const [row,col]=positions(c.attrs.r),v=text(first(c,'v')),type=c.attrs.t,formula=first(c,'f');let raw='',cached:string|number|boolean|undefined;
      if(type==='s'){const index=Number(v);if(!Number.isInteger(index)||index<0||index>=strings.length)throw new Error('Invalid shared-string reference');raw="'"+strings[index];cached=strings[index];}
      else if(type==='inlineStr'){const val=all(c,'t').map(text).join('');raw="'"+val;cached=val;}
      else if(type==='str'||type==='e'||type==='d'){raw="'"+v;cached=v;}
      else if(type==='b'){raw=v==='1'?'TRUE':'FALSE';cached=v==='1';}
      else if(v!==''){if(!Number.isFinite(Number(v)))throw new Error('Invalid numeric cell');raw=v;cached=Number(v);}
      if(!formula&&!raw)continue;
      const formulaValue=formula?text(formula):undefined;
      cells.push({row,col,raw,formula:formulaValue||undefined,cached,format:formats[Number(c.attrs.s||0)],shared:formula?.attrs.t==='shared'?formula.attrs.si:undefined,sharedOrigin:formula?.attrs.t==='shared'&&!!formulaValue});maxRow=Math.max(maxRow,row+1);maxCol=Math.max(maxCol,col+1);
      if(cells.length>MAX_CELLS)throw new Error('Workbook exceeds cell limit');
    }
    if(all(root,'mergeCell').length)warnings.push(`Merged cells in “${source.attrs.name}” were flattened to their stored cell values.`);
    sheets.push({name:source.attrs.name,cells,rows:maxRow,columns:maxCol,hidden:source.attrs.state==='hidden'||source.attrs.state==='veryHidden'});
  }
  return native(sheets,name.replace(/\.xlsx$/i,''),warnings,first(workbook,'workbookPr')?.attrs.date1904==='1'?'1904':'1900');
}
/** Convert only syntactic OpenFormula references, outside quoted strings. */
function fromOdfFormula(input:string):string{
  const body=input.replace(/^(?:of|oooc):=/,'');let out='',quoted=false;
  for(let i=0;i<body.length;i++){const c=body[i];if(c==='"'){out+=c;if(quoted&&body[i+1]==='"'){out+='"';i++;}else quoted=!quoted;continue;}if(!quoted&&c==='['){const end=body.indexOf(']',i);if(end<0)return 'UNSUPPORTED_ODF_FORMULA()';const ref=body.slice(i+1,end).split(':').map(s=>s.startsWith('.')?s.slice(1):s.replace(/^\$?('(?:[^']|'')+'|[^.]+)\./,'$1!')).join(':');out+=ref;i=end;}else out+=!quoted&&c===';'?',':c;}
  return out;
}
function odfFormula(fields:Fields,sid:string,cell:Cell):string{
  if(!cell.ast)return '';
  // Emit OpenFormula from the parsed tree, preserving stable reference targets.
  function emit(e:NonNullable<Cell['ast']>):string{
    if(e.type==='ref')return '['+formulaText(fields,sid,e).replace(/!(?=\$?[A-Z])/g,'.').replace(/^(?!.*!|.*'.*'\.)/,'.')+']';
    if(e.type==='range'){const one=emit({type:'ref',ref:e.from}),two=emit({type:'ref',ref:e.to});return one.slice(0,-1)+':'+two.slice(1);}
    if(e.type==='call')return e.name+'('+e.args.map(emit).join(';')+')';
    if(e.type==='binary')return '('+emit(e.left)+e.op+emit(e.right)+')';
    if(e.type==='unary')return e.op==='%'?'('+emit(e.right)+')%':e.op+'('+emit(e.right)+')';
    return formulaText(fields,sid,e);
  }
  return 'of:='+emit(cell.ast);
}
export function exportWorkbookBytes(fields:Fields,active:string,format:'csv'|'tsv'|'xlsx'|'ods'):WorkbookExport{
  const ids=sheetIds(fields),calc=createCalculator(fields),warnings=['Export contains supported cells, formulas, and basic number formats. Comments, collaboration history, charts, custom layouts and unsupported styling remain in the native Wabi backup, not this export.'];let unsupported=0;
  const dims=(sid:string)=>{const s=getSheet(fields,sid);let rows=0,cols=0;for(const k of Object.keys(fields)){if(!k.startsWith('c:'+sid+':'))continue;const parts=k.split(':'),r=s.rows.indexOf(parts[2]),c=s.columns.indexOf(parts[3]);if(r>=0&&c>=0){rows=Math.max(rows,r+1);cols=Math.max(cols,c+1);}}return {s,rows,cols};};
  if(format==='csv'||format==='tsv'){const {s,rows,cols}=dims(active),data:string[][]=[];if(rows*cols>2_000_000)throw new Error('Delimited export exceeds two million displayed cells');for(let r=0;r<rows;r++){const row:string[]=[];for(let c=0;c<cols;c++){const value=calc.result(active,s.rows[r],s.columns[c]);row.push(String(value.error??value.value??''));}data.push(row);}return {name:filename(fields.title,format),bytes:new TextEncoder().encode(writeDelimited(data,format==='csv'?',':'\t',true)),mime:'text/'+(format==='csv'?'csv':'tab-separated-values')+';charset=utf-8',warnings:['This is a values-only export of the active sheet. Formula-looking text is escaped for safer opening in external spreadsheet software.']};}
  const parts:Record<string,string|Uint8Array>={};
  if(format==='xlsx'){
    parts['[Content_Types].xml']=DECLARATION+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${ids.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
    parts['_rels/.rels']=DECLARATION+`<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    parts['xl/workbook.xml']=DECLARATION+`<workbook xmlns="${SML}" xmlns:r="${REL}"><workbookPr date1904="${fields.dateSystem==='1904'?1:0}"/><sheets>${ids.map((sid,i)=>`<sheet name="${x(getSheet(fields,sid).name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`;
    parts['xl/_rels/workbook.xml.rels']=DECLARATION+`<Relationships xmlns="${PACKAGE_REL}">${ids.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
    parts['xl/styles.xml']=DECLARATION+`<styleSheet xmlns="${SML}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6">${[0,2,10,14,49,4].map(n=>`<xf numFmtId="${n}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    ids.forEach((sid,i)=>{const {s,rows,cols}=dims(sid),rowParts:string[]=[];if(rows*cols>2_000_000)throw new Error('Workbook export exceeds two million displayed cells per sheet');for(let r=0;r<rows;r++){const row:string[]=[];for(let c=0;c<cols;c++){const cell=getCell(fields,sid,s.rows[r],s.columns[c]);if(cell.raw===''&&!cell.ast)continue;const address=columnName(c)+(r+1),f=fields['f:'+cellKey(sid,s.rows[r],s.columns[c]).slice(2)] as {format?:string}|undefined,style=['general','number','percent','date','text','currency'].indexOf(f?.format||'general'),evaluated=calc.result(sid,s.rows[r],s.columns[c]);
        if(cell.unsupported){unsupported++;row.push(`<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${x(cell.raw)}</t></is></c>`);continue;}
        const value=evaluated.value,formula=cell.ast?`<f>${x(formulaText(fields,sid,cell.ast))}</f>`:'';
        if(evaluated.error)row.push(`<c r="${address}" s="${Math.max(0,style)}" t="e">${formula}<v>${x(['#REF!','#VALUE!','#DIV/0!','#NUM!','#N/A'].includes(evaluated.error)?evaluated.error:'#VALUE!')}</v></c>`);
        else if(typeof value==='number')row.push(`<c r="${address}" s="${Math.max(0,style)}">${formula}<v>${value}</v></c>`);
        else if(typeof value==='boolean')row.push(`<c r="${address}" t="b">${formula}<v>${value?1:0}</v></c>`);
        else if(formula)row.push(`<c r="${address}" t="str">${formula}<v>${x(value)}</v></c>`);
        else row.push(`<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${x(value)}</t></is></c>`);
      }if(row.length)rowParts.push(`<row r="${r+1}">${row.join('')}</row>`);}parts[`xl/worksheets/sheet${i+1}.xml`]=DECLARATION+`<worksheet xmlns="${SML}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rowParts.join('')}</sheetData></worksheet>`;});
  }else{
    parts.mimetype='application/vnd.oasis.opendocument.spreadsheet';
    const tables=ids.map(sid=>{const {s,rows,cols}=dims(sid);if(rows*cols>2_000_000)throw new Error('Workbook export exceeds two million displayed cells per sheet');const body:string[]=[];for(let r=0;r<rows;r++){const row:string[]=[];for(let c=0;c<cols;c++){const cell=getCell(fields,sid,s.rows[r],s.columns[c]);if(cell.raw===''&&!cell.ast){row.push('<table:table-cell/>');continue;}const evaluated=calc.result(sid,s.rows[r],s.columns[c]);let formula=cell.ast?` table:formula="${x(odfFormula(fields,sid,cell))}"`:'';let value=evaluated.value;if(cell.unsupported){unsupported++;formula='';value=cell.raw;}else if(evaluated.error){formula='';value=evaluated.error;warnings.push('A formula error was exported as text in ODS; the native backup retains its formula.');}const attr=typeof value==='number'?`office:value-type="float" office:value="${value}"`:typeof value==='boolean'?`office:value-type="boolean" office:boolean-value="${value}"`:'office:value-type="string"';row.push(`<table:table-cell ${attr}${formula}><text:p>${x(value)}</text:p></table:table-cell>`);}body.push('<table:table-row>'+row.join('')+'</table:table-row>');}return `<table:table table:name="${x(s.name)}">${body.join('')}</table:table>`;});
    parts['content.xml']=DECLARATION+`<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:spreadsheet><table:calculation-settings><table:null-date table:date-value="${fields.dateSystem==='1904'?'1904-01-01':'1899-12-30'}"/></table:calculation-settings>${tables.join('')}</office:spreadsheet></office:body></office:document-content>`;
    parts['META-INF/manifest.xml']=DECLARATION+'<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>';
  }
  if(unsupported)warnings.push(`${unsupported} unsupported formulas were exported as inert text. They were not recalculated or executed.`);
  return {name:filename(fields.title,format),bytes:writeZip(parts),mime:format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.oasis.opendocument.spreadsheet',warnings:[...new Set(warnings)]};
}
