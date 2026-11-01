<script lang="ts">
    import {onDestroy,tick} from 'svelte';
    import Icon from '$lib/components/ui/Icon.svelte';
    import Menu from '$lib/components/ui/Menu.svelte';
    import Notice from '$lib/components/ui/Notice.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type {IconName} from '$lib/components/ui/icons';
    import type {MenuEntry} from '$lib/components/context-menu/ContextMenu.svelte';
    import {toast} from '$lib/toast';
    import {_} from '$lib/i18n';
    import './sheets.css';
    import {download,Y,type ArtifactSession,type PrivateDraft} from '../session';
    import {request,type Meta,type ProtectedRange} from '../bridge';
    import {parseAnchor,rangeAnchor} from '../anchors';
    import {orderedSheets,snapshot,sheets,setCell,setCells,setStyle,styleOf,formatValue,addSheet,renameSheet,reorderSheet,removeSheet,restoreSheet,insertAxis,removeAxis,reorderRows,columnWidth,setColumnWidth,fill,recoverRemoved,cachedResultIsStale,cellKey,heads,inputOf,type CellStyle,type CellTarget} from './model';
    import {columnName,literal,type Calculation,type CellVersion,type Scalar} from './formula';
    import {SheetWorker} from './workerClient';
    let {session,onselection,onactivesheet,focusAnchor}:{session:ArtifactSession;onselection?:(anchor:string|null)=>void;onactivesheet?:(id:string)=>void;focusAnchor?:string|null}=$props();
    const sessionState=session.state;
    let sheetId=$state(''),selectedRow=$state(''),selectedColumn=$state(''),endRow=$state(''),endColumn=$state('');
    let filter=$state(''),sort=$state<'none'|'asc'|'desc'>('none'),scrollTop=$state(0),viewportHeight=$state(600);
    let grid:HTMLDivElement,formulaInput:HTMLInputElement;
    let draft=$state(''),editing=$state(false),error=$state(''),chart=$state<'none'|'bar'|'line'|'pie'>('none');
    let editingTarget:{sheet:string;row:string;column:string;parents:string[]}|null=null;
    let bufferId='cell:'+crypto.randomUUID();
    let protectionOpen=$state(false),protectBusy=$state(false),recoveryOpen=$state(false),freeze=$state(true);
    let calculations=$state<Calculation>({values:{},errors:{}}),calculating=$state(false),dataEpoch=$state(0);
    let calculationId=0,calculationTimer:ReturnType<typeof setTimeout>|undefined,disposed=false;
    let lastAnchor:string|null=null,lastFocused:string|null|undefined,lastSheet='';
    const changed=()=>dataEpoch++;
    session.doc.on('update',changed);
    const engine=new SheetWorker();
    const available=$derived.by(()=>{dataEpoch;return orderedSheets(session.data);});
    const book=$derived.by(()=>{dataEpoch;return snapshot(session.data);});
    const current=$derived(book.sheets.find(sheet=>sheet.id===sheetId)||book.sheets[0]);
    const ysheet=$derived(current?sheets(session.data).get(current.id):undefined);
    const editable=$derived.by(()=>{$sessionState.meta;return session.editable;});
    const protections=$derived($sessionState.meta?.protectedRanges||[]);
    const cellDrafts=$derived(Object.entries($sessionState.drafts).filter(([,entry])=>entry.kind==='cell'));
    const removedSheets=$derived.by(()=>{
        dataEpoch;
        const entries=Array.from(sheets(session.data),([id,sheet])=>({id,name:String(sheet.get('name')),removed:sheet.get('removed')}));
        return entries.filter(sheet=>sheet.removed);
    });
    // Rows are 28px (40 on touch screens, so a finger can pick one).
    const baseRow=typeof window!=='undefined'&&window.matchMedia?.('(pointer: coarse)').matches?40:28;
    const rowHeight=$derived.by(()=>{dataEpoch;const styles=ysheet?.get('styles');return styles instanceof Y.Map&&Array.from(styles.values()).some(style=>(style as CellStyle).wrap)?72:baseRow;});
    const rows=$derived.by(()=>{
        if(!current)return[];let result=current.rows;
        if(filter){const query=filter.toLocaleLowerCase();result=result.filter(row=>current.columns.some(column=>value(row.id,column.id).toLocaleLowerCase().includes(query)));}
        if(sort!=='none'&&selectedColumn)result=[...result].sort((a,b)=>value(a.id,selectedColumn).localeCompare(value(b.id,selectedColumn),undefined,{numeric:true})*(sort==='asc'?1:-1));return result;
    });
    const first=$derived(Math.max(0,Math.floor(scrollTop/rowHeight)-5));
    const last=$derived(Math.min(rows.length,first+Math.ceil(viewportHeight/rowHeight)+12));
    const visible=$derived(rows.slice(first,last));
    const selectedVersions=$derived(current?heads(current.cells[cellKey(selectedRow,selectedColumn)]||[]):[]);
    const selection=$derived.by(()=>{
        if(!current)return[];
        const a=rows.findIndex(row=>row.id===selectedRow),b=rows.findIndex(row=>row.id===(endRow||selectedRow));
        const c=current.columns.findIndex(column=>column.id===selectedColumn),d=current.columns.findIndex(column=>column.id===(endColumn||selectedColumn));
        if(Math.min(a,b,c,d)<0)return[];const result:CellTarget[]=[];
        for(let r=Math.min(a,b);r<=Math.max(a,b);r++)for(let x=Math.min(c,d);x<=Math.max(c,d);x++)result.push({row:rows[r].id,column:current.columns[x].id});return result;
    });
    const selectedSet=$derived(new Set(selection.map(cell=>cellKey(cell.row,cell.column))));
    const selectionProtected=$derived(selection.some(cell=>isProtected(cell.row,cell.column)));
    const selectedStyle=$derived.by(()=>{dataEpoch;return ysheet?styleOf(ysheet,selectedRow,selectedColumn):{} as CellStyle;});
    const allowSelected=$derived(editable&&!selectionProtected);
    function isProtected(row:string,column:string){return $sessionState.meta?.role!=='owner'&&protections.some(range=>range.sheetId===current?.id&&range.rows.includes(row)&&range.columns.includes(column));}
    function permitted(cells:CellTarget[]){if(!editable)throw new Error('This workbook is read-only.');if(cells.some(cell=>isProtected(cell.row,cell.column)))throw new Error('This selection includes an owner-protected cell. Make a private copy or ask the owner to remove protection.');}
    function attempt(fn:()=>void){error='';try{fn();}catch(e){error=e instanceof Error?e.message:String(e);}}
    $effect(()=>{if(current&&!current.rows.some(row=>row.id===selectedRow)){selectedRow=current.rows[0]?.id||'';endRow='';}if(current&&!current.columns.some(column=>column.id===selectedColumn)){selectedColumn=current.columns[0]?.id||'';endColumn='';}});
    $effect(()=>{if(!editing&&current)draft=selectedVersions.length===1?inputOf(selectedVersions[0],book,current.id):'';});
    $effect(()=>{
        const source=book,id=++calculationId;if(calculationTimer)clearTimeout(calculationTimer);calculating=true;
        calculationTimer=setTimeout(()=>{void engine.run<Calculation>('calculate',source).then(result=>{if(!disposed&&id===calculationId){calculations=result;calculating=false;}}).catch(e=>{if(!disposed&&id===calculationId){error=e.message;calculating=false;}});},180);
    });
    $effect(()=>{
        let anchor:string|null=null;
        if(current&&selection.length){const rs=[...new Set(selection.map(cell=>cell.row))],cs=[...new Set(selection.map(cell=>cell.column))];if(rs.length<=40&&cs.length<=40){try{anchor=rangeAnchor(current.id,rs,cs,`${current.name}: ${columnName(current.columns.findIndex(column=>column.id===cs[0]))}${current.rows.findIndex(row=>row.id===rs[0])+1}`);}catch{/* Large ranges still support ordinary editing. */}}}
        if(anchor!==lastAnchor){lastAnchor=anchor;onselection?.(anchor);}if(current&&lastSheet!==current.id){lastSheet=current.id;onactivesheet?.(current.id);}
    });
    $effect(()=>{
        const raw=focusAnchor;if(!raw||raw===lastFocused)return;const anchor=parseAnchor(raw);if(anchor?.kind!=='range')return;lastFocused=raw;
        if(!commit())return;filter='';sort='none';sheetId=anchor.sheetId;selectedRow=anchor.rows[0];selectedColumn=anchor.columns[0];endRow=anchor.rows.at(-1)||'';endColumn=anchor.columns.at(-1)||'';
        const target=book.sheets.find(sheet=>sheet.id===anchor.sheetId),index=target?.rows.findIndex(row=>row.id===selectedRow)??-1;if(index>=0&&grid){grid.scrollTop=index*rowHeight;scrollTop=grid.scrollTop;grid.focus();}
    });
    onDestroy(()=>{disposed=true;session.doc.off('update',changed);calculationId++;if(calculationTimer)clearTimeout(calculationTimer);engine.close();});
    function value(row:string,column:string):string{
        if(!current||!ysheet)return'';const key=`${current.id}/${cellKey(row,column)}`,versions=heads(current.cells[cellKey(row,column)]||[]);
        if(versions.length>1)return'#CONFLICT!';if(calculations.errors[key])return versions[0]?.cached!==undefined?`${String(versions[0].cached??'')} ${cachedResultIsStale(session.data)?'STALE':'†'}`:calculations.errors[key];
        return formatValue(calculations.values[key]??typed(versions[0]),styleOf(ysheet,row,column));
    }
    /** A typed (non-formula) value shows at once, before the calculator answers or if it cannot. */
    function typed(version:CellVersion|undefined):Scalar{
        if(!version)return null;if(version.literal!==undefined)return version.literal;
        return version.input.startsWith('=')?null:literal(version.input);
    }
    function beginEdit(){if(!editable||!current||isProtected(selectedRow,selectedColumn))return;if(!editingTarget){editingTarget={sheet:current.id,row:selectedRow,column:selectedColumn,parents:selectedVersions.map(version=>version.id)};bufferId='cell:'+crypto.randomUUID();}editing=true;}
    function stage(value:string){draft=value;if(!editingTarget)beginEdit();if(!editingTarget)return;const target=editingTarget;attempt(()=>session.stageDraft(bufferId,{kind:'cell',text:value,context:{...target},updatedAt:Date.now()}));}
    function commit():boolean{
        if(!editing)return true;if(!editingTarget)return false;const target=editingTarget;
        try{
            if(!editable)throw new Error('Editing permission changed. The unsubmitted cell draft is retained privately.');
            if($sessionState.meta?.role!=='owner'&&protections.some(range=>range.sheetId===target.sheet&&range.rows.includes(target.row)&&range.columns.includes(target.column)))throw new Error('This cell is now protected. The draft is retained privately.');
            setCell(session.data,target.sheet,target.row,target.column,draft,session.origin,undefined,target.parents);
            session.stageDraft(bufferId,null);editing=false;editingTarget=null;error='';return true;
        }catch(e){error=e instanceof Error?e.message:String(e);return false;}
    }
    function cancelEdit(){if(!editingTarget)return;attempt(()=>{session.stageDraft(bufferId,null);editing=false;editingTarget=null;draft=selectedVersions.length===1&&current?inputOf(selectedVersions[0],book,current.id):'';grid?.focus();});}
    function choose(row:string,column:string,extend=false){if(!commit())return;grid?.focus();if(extend){endRow=row;endColumn=column;}else{selectedRow=row;selectedColumn=column;endRow='';endColumn='';}}
    function startEdit(){if(!allowSelected)return;beginEdit();formulaInput?.focus();formulaInput?.select();}
    function style(patch:CellStyle){if(!current)return;attempt(()=>{permitted(selection);setStyle(session.data,current!.id,selection,patch,session.origin);});}
    function restoreBuffer(id:string,entry:PrivateDraft){
        if(editing){error='Apply or cancel the current cell edit before restoring another draft.';return;}
        const target=entry.context;if(typeof target.sheet!=='string'||typeof target.row!=='string'||typeof target.column!=='string'||!Array.isArray(target.parents)||!target.parents.every(parent=>typeof parent==='string')){error='This draft needs recovery export; its cell reference is invalid.';return;}
        const original=book.sheets.find(sheet=>sheet.id===target.sheet);if(!original||!original.rows.some(row=>row.id===target.row)||!original.columns.some(column=>column.id===target.column)){error='The original cell was removed. The draft remains available in recovery export; it will not be placed in a different cell.';return;}
        sheetId=target.sheet;selectedRow=target.row;selectedColumn=target.column;endRow='';endColumn='';filter='';sort='none';bufferId=id;
        editingTarget={sheet:target.sheet,row:target.row,column:target.column,parents:target.parents as string[]};draft=entry.text;editing=true;recoveryOpen=false;formulaInput?.focus();
    }
    async function copy(){
        if(!current)return;const rowIds=[...new Set(selection.map(cell=>cell.row))],columnIds=[...new Set(selection.map(cell=>cell.column))];
        const escape=(text:string)=>/[\t\r\n"]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
        const text=rowIds.map(row=>columnIds.map(column=>{const output=value(row,column),raw=calculations.values[`${current!.id}/${cellKey(row,column)}`];return escape(typeof raw!=='number'&&/^[=+@-]/.test(output)?"'"+output:output);}).join('\t')).join('\n');
        try{await navigator.clipboard.writeText(text);toast('Selected values copied as a text-safe snapshot. No hidden cells or formulas were included.',{tone:'info'});}catch{error='Clipboard access was denied. Use export instead.';}
    }
    function parseTsv(text:string){const result:string[][]=[[]];let field='',quoted=false;for(let index=0;index<text.length;index++){const c=text[index];if(c==='"'&&(quoted||field==='')){if(quoted&&text[index+1]==='"'){field+='"';index++;}else quoted=!quoted;}else if(!quoted&&(c==='\t'||c==='\n')){result.at(-1)!.push(field.replace(/\r$/,''));field='';if(c==='\n')result.push([]);}else field+=c;}result.at(-1)!.push(field.replace(/\r$/,''));if(result.length>1&&result.at(-1)!.length===1&&result.at(-1)![0]==='')result.pop();if(quoted)throw new Error('Pasted table has an unclosed quote.');return result;}
    function paste(event:ClipboardEvent){
        if(!editable||!current||event.target===formulaInput)return;event.preventDefault();attempt(()=>{
            if(!commit())throw new Error('Resolve the current cell edit before pasting.');const text=event.clipboardData?.getData('text/plain')||'';if(text.length>2*1024*1024)throw new Error('Paste exceeds 2 MB; use file import.');
            const cells=parseTsv(text);if(cells.reduce((total,row)=>total+row.length,0)>2000)throw new Error('Paste up to 2,000 cells at once.');
            const ri=rows.findIndex(row=>row.id===selectedRow),ci=current!.columns.findIndex(column=>column.id===selectedColumn);
            if(ri<0||ci<0||ri+cells.length>rows.length||cells.some(row=>ci+row.length>current!.columns.length))throw new Error('Add rows or columns before pasting. Nothing was changed.');
            const changes=cells.flatMap((row,r)=>row.map((input,c)=>({row:rows[ri+r].id,column:current!.columns[ci+c].id,input})));permitted(changes);setCells(session.data,current!.id,changes,session.origin);
        });
    }
    function clearSelection(){if(!current)return;attempt(()=>{permitted(selection);if(selection.length>2000)throw new Error('Clear up to 2,000 cells at once.');setCells(session.data,current!.id,selection.map(cell=>({...cell,input:''})),session.origin);});}
    function keydown(event:KeyboardEvent){
        if(event.target===formulaInput||event.isComposing)return;
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){event.preventDefault();void copy();return;}
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();if(current&&rows.length){selectedRow=rows[0].id;selectedColumn=current.columns[0].id;endRow=rows.at(-1)!.id;endColumn=current.columns.at(-1)!.id;}return;}
        if(event.key==='F2'||event.key==='Enter'){event.preventDefault();startEdit();return;}if(!current)return;
        // Shift extends the range from its far corner, so the selection can grow past one cell.
        const extending=event.shiftKey&&event.key!=='Tab';
        let row=rows.findIndex(item=>item.id===(extending?(endRow||selectedRow):selectedRow)),column=current.columns.findIndex(item=>item.id===(extending?(endColumn||selectedColumn):selectedColumn));const direction:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],Tab:[0,event.shiftKey?-1:1]};
        if(direction[event.key]){event.preventDefault();row=Math.max(0,Math.min(rows.length-1,row+direction[event.key][0]));column=Math.max(0,Math.min(current.columns.length-1,column+direction[event.key][1]));if(rows[row])choose(rows[row].id,current.columns[column].id,event.shiftKey&&event.key!=='Tab');if(row*rowHeight<grid.scrollTop)grid.scrollTop=row*rowHeight;else if(row*rowHeight>grid.scrollTop+grid.clientHeight-96)grid.scrollTop=row*rowHeight-grid.clientHeight+96;return;}
        if(allowSelected&&(event.key==='Delete'||event.key==='Backspace')){event.preventDefault();clearSelection();return;}
        if(allowSelected&&event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();beginEdit();stage(event.key);formulaInput.focus();}
    }
    function axis(kind:'rows'|'columns',remove=false){if(!current)return;attempt(()=>{
        if(!commit())throw new Error('Resolve the current cell edit first.');permitted([]);const id=kind==='rows'?selectedRow:selectedColumn;
        if(remove&&$sessionState.meta?.role!=='owner'&&protections.some(range=>range.sheetId===current!.id&&(kind==='rows'?range.rows:range.columns).includes(id)))throw new Error('This axis contains protected cells.');
        if(remove)removeAxis(session.data,current!.id,kind,id,session.origin);else insertAxis(session.data,current!.id,kind,(kind==='rows'?current!.rows:current!.columns).findIndex(item=>item.id===id)+1,session.origin);
    });}
    function fillDown(){if(!current)return;attempt(()=>{const row=current!.rows.findIndex(item=>item.id===selectedRow),column=current!.columns.findIndex(item=>item.id===selectedColumn);if(row>=current!.rows.length-1)throw new Error('Add a row before filling down.');permitted([{row:current!.rows[row+1].id,column:selectedColumn}]);fill(session.data,current!.id,{r:row,c:column},{r:row+1,c:column},session.origin);});}
    async function protect(removeId?:string){
        if(!current||!session.record.meta||session.record.meta.role!=='owner'||protectBusy)return;protectBusy=true;error='';
        try{
            await session.sync();const ranges:ProtectedRange[]=removeId?protections.filter(range=>range.id!==removeId):[...protections,{id:crypto.randomUUID(),sheetId:current.id,rows:[...new Set(selection.map(cell=>cell.row))],columns:[...new Set(selection.map(cell=>cell.column))],label:`${current.name}: protected selection`}];
            const response=await request<{meta:Meta}>(session.scope,`/artifacts/${session.id}/protection`,{expectedRevision:session.record.meta!.revision,ranges});
            if(disposed)return;session.record.meta=response.meta;await session.flush();toast('Range protection saved on the server.',{tone:'info'});
        }catch(e){if(!disposed)error=e instanceof Error?e.message:String(e);}finally{if(!disposed)protectBusy=false;}
    }
    const chartData=$derived.by(()=>{if(!current)return[];const rs=[...new Set(selection.map(cell=>cell.row))].slice(0,30),cs=[...new Set(selection.map(cell=>cell.column))];if(cs.length<2)return[];return rs.map(row=>({label:value(row,cs[0]),value:raw(row,cs[1])})).filter((item):item is{label:string;value:number}=>typeof item.value==='number'&&Number.isFinite(item.value));});
    const minimum=$derived(Math.min(0,...chartData.map(item=>item.value))),maximum=$derived(Math.max(1,...chartData.map(item=>item.value)));
    const chartY=(value:number)=>260-(value-minimum)/(maximum-minimum)*220;
    function piePath(index:number){const positive=chartData.map(item=>Math.max(0,item.value)),total=positive.reduce((a,b)=>a+b,0);if(!total)return'';const begin=positive.slice(0,index).reduce((a,b)=>a+b,0)/total*Math.PI*2-Math.PI/2,span=positive[index]/total*Math.PI*2,end=begin+Math.min(span,Math.PI*2-.00001);const x=(angle:number)=>200+110*Math.cos(angle),y=(angle:number)=>140+110*Math.sin(angle);return`M200 140 L${x(begin)} ${y(begin)} A110 110 0 ${end-begin>Math.PI?1:0} 1 ${x(end)} ${y(end)} Z`;}

    // ---- the editor's chrome (design contract §8.8 Sheets) ----
    let toolbar=$state<HTMLDivElement|null>(null);
    let formatOpen=$state(false),chartOpen=$state(true);
    let renamingSheet=$state<string|null>(null);
    let tabMenuAnchor=$state<HTMLElement|null>(null),tabMenuOpen=$state(false),tabMenuSheet=$state('');
    const gridId='sheet-grid-'+crypto.randomUUID();
    const sheetName=(item:{value:Y.Map<unknown>})=>String(item.value.get('name'));
    const cellName=$derived(current&&selectedColumn&&selectedRow?`${columnName(current.columns.findIndex(column=>column.id===selectedColumn))}${current.rows.findIndex(row=>row.id===selectedRow)+1}`:'');
    const rowIndex=$derived(new Map(rows.map((row,index)=>[row.id,index])));
    const colIndex=$derived(new Map((current?.columns||[]).map((column,index)=>[column.id,index])));
    /** The selected range's edges (row and column indexes), for its 1px accent perimeter. */
    const bounds=$derived.by(()=>{
        const a=rowIndex.get(selectedRow),b=rowIndex.get(endRow||selectedRow),c=colIndex.get(selectedColumn),d=colIndex.get(endColumn||selectedColumn);
        if(a===undefined||b===undefined||c===undefined||d===undefined)return null;
        return{r0:Math.min(a,b),r1:Math.max(a,b),c0:Math.min(c,d),c1:Math.max(c,d)};
    });
    const selectedColumns=$derived(new Set(selection.map(cell=>cell.column)));
    const selectedRows=$derived(new Set(selection.map(cell=>cell.row)));
    /** The cell's own value (calculated, else its literal) for the footer and number alignment. */
    function raw(row:string,column:string):unknown{
        if(!current)return undefined;const key=`${current.id}/${cellKey(row,column)}`;
        return calculations.values[key]??typed(heads(current.cells[cellKey(row,column)]||[])[0]);
    }
    const numeric=(row:string,column:string)=>typeof raw(row,column)==='number';
    /** Sum, average and count of the selection: numbers sum and average; count is filled cells. */
    const stats=$derived.by(()=>{
        if(!current||selection.length<2)return null;let sum=0,numbers=0,count=0;
        for(const cell of selection){const value=raw(cell.row,cell.column);if(value===undefined||value===null||value==='')continue;count++;if(typeof value==='number'&&Number.isFinite(value)){sum+=value;numbers++;}}
        return{count,numbers,sum,average:numbers?sum/numbers:null};
    });
    const number=(value:number)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:4}).format(value);
    /** A cached result from an imported file (Wabi cannot recalculate its formula): say so where it is read. */
    const activeCached=$derived.by(()=>{
        if(!current)return null;const key=`${current.id}/${cellKey(selectedRow,selectedColumn)}`;
        if(!calculations.errors[key]||selectedVersions[0]?.cached===undefined)return null;
        return cachedResultIsStale(session.data)?'stale':'cached';
    });

    function switchSheet(id:string){if(id===current?.id)return;if(!commit())return;sheetId=id;scrollTop=0;filter='';sort='none';}
    function newSheet(){attempt(()=>{if(!commit())return;session.doc.transact(()=>{sheetId=addSheet(session.data,`Sheet ${available.length+1}`).id;},session.origin);});}
    async function startRename(id:string){if(!editable)return;renamingSheet=id;await tick();toolbar?.closest('.sheets-editor')?.querySelector<HTMLInputElement>('.sheet-tab__rename')?.select();}
    function finishRename(id:string,value:string){renamingSheet=null;const name=value.trim();if(name)attempt(()=>renameSheet(session.data,id,name,session.origin));}
    function removeSheetById(id:string){attempt(()=>{if($sessionState.meta?.role!=='owner'&&protections.some(range=>range.sheetId===id))throw new Error('This sheet contains protected cells.');if(commit())removeSheet(session.data,id,session.origin);});}
    function openTabMenu(event:MouseEvent,id:string){event.preventDefault();tabMenuSheet=id;tabMenuAnchor=event.currentTarget as HTMLElement;tabMenuOpen=true;}
    const tabMenuItems=$derived<MenuEntry[]>([
        {id:'rename',label:'Rename sheet',icon:'pencil',disabled:!editable,onSelect:()=>void startRename(tabMenuSheet)},
        {id:'left',label:'Move left',icon:'arrowLeft',disabled:!editable,onSelect:()=>attempt(()=>reorderSheet(session.data,tabMenuSheet,-1,session.origin))},
        {id:'right',label:'Move right',icon:'arrowRight',disabled:!editable,onSelect:()=>attempt(()=>reorderSheet(session.data,tabMenuSheet,1,session.origin))},
        {id:'sep',type:'separator',label:''},
        {id:'remove',label:'Remove sheet',icon:'trash',danger:true,disabled:!editable||available.length<2,hint:'Kept for recovery',onSelect:()=>removeSheetById(tabMenuSheet)}
    ]);

    const FORMATS:{value:NonNullable<CellStyle['format']>;label:string}[]=[{value:'general',label:'General'},{value:'number',label:'Number'},{value:'currency',label:'Currency'},{value:'percent',label:'Percent'},{value:'date',label:'Date (native serial)'},{value:'text',label:'Text'}];
    const formatLabel=$derived(FORMATS.find(item=>item.value===(selectedStyle.format||'general'))?.label??'General');
    const formatItems=$derived<MenuEntry[]>(FORMATS.map(item=>({id:`format-${item.value}`,label:item.label,role:'menuitemradio',checked:(selectedStyle.format||'general')===item.value,disabled:!allowSelected,onSelect:()=>style({format:item.value})})));
    const CURRENCIES=['USD','THB','EUR','GBP','JPY'];
    const currencyItems=$derived<MenuEntry[]>(CURRENCIES.map(code=>({id:`currency-${code}`,label:code,keepCase:true,role:'menuitemradio',checked:(selectedStyle.currency||'USD')===code,disabled:!allowSelected,onSelect:()=>style({currency:code})})));
    const SORTS:{value:'none'|'asc'|'desc';label:string}[]=[{value:'none',label:'Original row order'},{value:'asc',label:'Selected column: ascending'},{value:'desc',label:'Selected column: descending'}];
    const sortItems=$derived<MenuEntry[]>(SORTS.map(item=>({id:`sort-${item.value}`,label:item.label,role:'menuitemradio',checked:sort===item.value,hint:item.value==='none'?undefined:'Your view only',onSelect:()=>{sort=item.value;}})));
    const CHARTS:{value:'none'|'bar'|'line'|'pie';label:string}[]=[{value:'none',label:'No chart'},{value:'bar',label:'Bar chart'},{value:'line',label:'Line chart'},{value:'pie',label:'Pie chart'}];
    const chartItems=$derived<MenuEntry[]>(CHARTS.map(item=>({id:`chart-${item.value}`,label:item.label,role:'menuitemradio',checked:chart===item.value,onSelect:()=>{chart=item.value;chartOpen=true;}})));
    const ALIGNS:{value:'left'|'center'|'right';label:string;icon:IconName}[]=[{value:'left',label:'Align left',icon:'alignLeft'},{value:'center',label:'Align center',icon:'alignCenter'},{value:'right',label:'Align right',icon:'alignRight'}];
    /** Everything the one toolbar has no room for (design contract §8.8): ⋯ Spreadsheet tools. */
    const moreItems=$derived.by(():MenuEntry[]=>{
        const items:MenuEntry[]=[
            {id:'k-cells',type:'kicker',label:'Cells'},
            {id:'wrap',label:'Wrap text',icon:'wrapText',role:'menuitemcheckbox',checked:!!selectedStyle.wrap,disabled:!allowSelected,onSelect:()=>style({wrap:!selectedStyle.wrap})},
            {id:'plain',label:'Clear formatting',icon:'x',disabled:!allowSelected,onSelect:()=>style({bold:false,italic:false,fill:'',border:false,wrap:false,format:'general'})},
            {id:'details',label:'Decimals and column width…',icon:'sliders',onSelect:()=>{formatOpen=true;}},
            {id:'fill-down',label:'Fill down',icon:'arrowRight',disabled:!editable,onSelect:fillDown},
            {id:'copy',label:'Copy range',icon:'copy',shortcut:'Ctrl C',onSelect:()=>void copy()},
            {id:'sep-1',type:'separator',label:''},
            {id:'k-rows',type:'kicker',label:'Rows and columns'},
            {id:'delete-row',label:'Delete row',icon:'trash',disabled:!editable,onSelect:()=>axis('rows',true)},
            {id:'delete-column',label:'Delete column',icon:'trash',disabled:!editable,onSelect:()=>axis('columns',true)},
            {id:'freeze',label:'Freeze headers',icon:'pin',role:'menuitemcheckbox',checked:freeze,onSelect:()=>{freeze=!freeze;}},
            {id:'sep-2',type:'separator',label:''},
            {id:'k-shared',type:'kicker',label:'For everyone'},
            {id:'apply-order',label:$_('office.sheets.apply_row_order'),icon:'users',disabled:!editable||!!filter||sort==='none',hint:sort==='none'?'Sort your view first':filter?'Clear the filter first':'Reorders the rows for everyone',onSelect:()=>attempt(()=>{if(commit()){reorderRows(session.data,current!.id,rows.map(row=>row.id),session.origin);sort='none';}})},
            {id:'protect',label:protections.length?`Protected ranges (${protections.length})`:'Protected ranges…',icon:'lock',seal:true,onSelect:()=>{protectionOpen=true;}}
        ];
        if(cellDrafts.length||(ysheet&&recoverRemoved(ysheet).length)||removedSheets.length)items.push({id:'sep-3',type:'separator',label:''},{id:'k-recover',type:'kicker',label:'Recovery'});
        if(cellDrafts.length)items.push({id:'drafts',label:`Recover cell drafts (${cellDrafts.length})`,icon:'history',onSelect:()=>{recoveryOpen=true;}});
        if(ysheet&&recoverRemoved(ysheet).length)items.push({id:'removed',label:'Export removed content',icon:'download',hint:'Removed rows and columns',onSelect:()=>download('removed-sheet-content.json',JSON.stringify(recoverRemoved(ysheet!),null,2))});
        for(const item of removedSheets)items.push({id:`restore-${item.id}`,label:`Restore ${item.name}`,keepCase:true,icon:'undo',disabled:!editable,onSelect:()=>attempt(()=>restoreSheet(session.data,item.id,session.origin))});
        return items;
    });

    // The toolbar is one tab stop (design contract §10): arrow keys move between its controls,
    // Tab moves on to the formula bar and the grid. The filter field keeps its own stop.
    function roving(){return toolbar?Array.from(toolbar.querySelectorAll<HTMLElement>('[data-rove]')).filter(element=>!(element as HTMLButtonElement).disabled):[];}
    function settleRoving(focused?:HTMLElement){
        const items=roving();if(!items.length)return;const keep=focused&&items.includes(focused)?focused:items.find(item=>item.tabIndex===0)||items[0];
        for(const item of items)item.tabIndex=item===keep?0:-1;
    }
    function toolbarKeydown(event:KeyboardEvent){
        const target=event.target as HTMLElement;if(!target.hasAttribute('data-rove'))return;
        const items=roving(),index=items.indexOf(target);if(index<0)return;
        let next=-1;if(event.key==='ArrowRight')next=(index+1)%items.length;else if(event.key==='ArrowLeft')next=(index-1+items.length)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;
        if(next<0)return;event.preventDefault();settleRoving(items[next]);items[next].focus();
    }
    $effect(()=>{allowSelected;editable;sort;filter;void tick().then(()=>settleRoving());});
    const PIE=['var(--w-accent)','var(--w-seal)','var(--w-online)','var(--w-sig)','color-mix(in srgb, var(--w-accent) 50%, var(--w-bg))','color-mix(in srgb, var(--w-seal) 50%, var(--w-bg))','color-mix(in srgb, var(--w-online) 50%, var(--w-bg))','color-mix(in srgb, var(--w-sig) 50%, var(--w-bg))'];
</script>

<div class="sheets-editor">
    <!-- One 44px toolbar (design contract §8.8); the rest is in ⋯ Spreadsheet tools. -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="sheet-toolbar" role="toolbar" aria-label="Spreadsheet tools" bind:this={toolbar} onkeydown={toolbarKeydown} onfocusin={event=>settleRoving(event.target as HTMLElement)}>
        <Menu class="w-btn w-btn--quiet sheet-toolbar__format" items={formatItems} label="Number format" heading="Number format" triggerLabel={`Number format: ${formatLabel}`} disabled={!allowSelected} data-rove>
            <span class="sheet-toolbar__format-words">{formatLabel}</span><Icon name="chevDown" size={16} />
        </Menu>
        {#if selectedStyle.format==='currency'}
            <Menu class="w-btn w-btn--quiet" items={currencyItems} label="Currency" heading="Currency" triggerLabel={`Currency: ${selectedStyle.currency||'USD'}`} disabled={!allowSelected} data-rove>
                {selectedStyle.currency||'USD'}<Icon name="chevDown" size={16} />
            </Menu>
        {/if}
        <span class="w-tool__sep" aria-hidden="true"></span>
        <Tooltip text="Bold" placement="bottom"><button type="button" class="w-ibtn" aria-label="Bold" aria-pressed={!!selectedStyle.bold} disabled={!allowSelected} data-rove onclick={()=>style({bold:!selectedStyle.bold})}><Icon name="bold" /></button></Tooltip>
        <Tooltip text="Italic" placement="bottom"><button type="button" class="w-ibtn" aria-label="Italic" aria-pressed={!!selectedStyle.italic} disabled={!allowSelected} data-rove onclick={()=>style({italic:!selectedStyle.italic})}><Icon name="italic" /></button></Tooltip>
        <span class="w-tool__sep" aria-hidden="true"></span>
        <span class="sheet-toolbar__group" role="group" aria-label="Alignment">
            {#each ALIGNS as align (align.value)}
                <Tooltip text={align.label} placement="bottom"><button type="button" class="w-ibtn" aria-label={align.label} aria-pressed={(selectedStyle.align||'left')===align.value} disabled={!allowSelected} data-rove onclick={()=>style({align:align.value})}><Icon name={align.icon} /></button></Tooltip>
            {/each}
        </span>
        <span class="w-tool__sep" aria-hidden="true"></span>
        <Tooltip text="Cell fill" placement="bottom">
            <label class="w-ibtn sheet-toolbar__fill" class:disabled={!allowSelected}>
                <Icon name="fill" /><span class="sheet-toolbar__swatch" style:background-color={selectedStyle.fill||'transparent'}></span>
                <input class="sheet-toolbar__color" aria-label="Cell fill color" type="color" value={selectedStyle.fill||'#fff3b0'} disabled={!allowSelected} data-rove oninput={event=>style({fill:event.currentTarget.value})} />
            </label>
        </Tooltip>
        <Tooltip text="Borders" placement="bottom"><button type="button" class="w-ibtn" aria-label="Borders" aria-pressed={!!selectedStyle.border} disabled={!allowSelected} data-rove onclick={()=>style({border:!selectedStyle.border})}><Icon name="borders" /></button></Tooltip>
        <span class="w-tool__sep" aria-hidden="true"></span>
        <Tooltip text="Insert row" placement="bottom"><button type="button" class="w-ibtn" aria-label="Insert row" disabled={!editable} data-rove onclick={()=>axis('rows')}><Icon name="rowAdd" /></button></Tooltip>
        <Tooltip text="Insert column" placement="bottom"><button type="button" class="w-ibtn" aria-label="Insert column" disabled={!editable} data-rove onclick={()=>axis('columns')}><Icon name="columnAdd" /></button></Tooltip>
        <span class="w-tool__sep" aria-hidden="true"></span>
        <label class="w-field sheet-toolbar__filter"><Icon name="filter" /><input aria-label={$_('office.sheets.filter_my_view')} placeholder={`${$_('office.sheets.filter_my_view')}…`} bind:value={filter} /></label>
        <Menu class="w-ibtn" items={sortItems} label="Sort my view" heading="Sort my view by the selected column" triggerLabel={sort==='none'?'Sort my view':`Sort my view: ${sort==='asc'?'ascending':'descending'}`} aria-pressed={sort!=='none'} data-rove>
            <Icon name="chevUpDown" />
        </Menu>
        <Menu class="w-ibtn" items={chartItems} label="Chart" heading="Chart the selected range" triggerLabel={chart==='none'?'Chart':`Chart: ${chart}`} aria-pressed={chart!=='none'} data-rove>
            <Icon name="chart" />
        </Menu>
        <span class="sheet-toolbar__spacer"></span>
        <Menu class="w-ibtn" items={moreItems} label="Spreadsheet tools" heading="Spreadsheet tools" triggerLabel="More spreadsheet tools" align="end" data-rove>
            <Icon name="more" />
        </Menu>
    </div>

    <!-- The 40px formula bar: name box, fx, the cell's input. Enter applies, Esc cancels. -->
    <form class="sheet-formula" onsubmit={event=>{event.preventDefault();if(commit())grid?.focus();}}>
        <output class="sheet-formula__name" aria-label="Selected cell">{cellName}</output>
        <span class="sheet-formula__fx" aria-hidden="true">fx</span>
        <input class="sheet-formula__input" aria-label="Cell value or formula" bind:this={formulaInput} value={draft} maxlength="8192" spellcheck="false" autocomplete="off" disabled={!editable||(!editing&&selectionProtected)} onfocus={beginEdit} oninput={event=>stage(event.currentTarget.value)} onblur={()=>commit()} onkeydown={event=>{if(event.key==='Escape'){event.preventDefault();cancelEdit();}}} />
        {#if activeCached}<span class="w-tag sheet-formula__tag" title={activeCached==='stale'?'The saved result from the original file. The workbook changed since, and Wabi cannot recalculate this formula.':'The saved result from the original file. Wabi cannot recalculate this formula.'}>{activeCached==='stale'?'Stale':'Cached'}</span>{/if}
        {#if selectionProtected}<span class="w-seal sheet-formula__protected"><Icon name="lock" />{$_('office.sheets.protected')}</span>{/if}
        {#if editing}<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Cancel cell edit" onpointerdown={event=>event.preventDefault()} onclick={cancelEdit}><Icon name="x" /></button>{/if}
    </form>

    {#if error}
        <div class="sheet-notice"><Notice title={error} text="Your spreadsheet is unchanged." ondismiss={()=>(error='')} /></div>
    {/if}
    {#if selectedVersions.length>1}
        <div class="sheet-notice">
            <Notice tone="warn" title="This cell has competing edits" text="Choose one or enter a replacement; the others stay in saved history.">
                {#snippet actions()}
                    {#each selectedVersions as version (version.id)}<button type="button" class="w-btn w-btn--sm" disabled={!allowSelected} onclick={()=>attempt(()=>{if(current){permitted([{row:selectedRow,column:selectedColumn}]);setCell(session.data,current.id,selectedRow,selectedColumn,version.input,session.origin,version.expression?{expression:version.expression}:undefined);}})}>{version.input||'(empty)'}</button>{/each}
                {/snippet}
            </Notice>
        </div>
    {/if}

    {#if formatOpen}
        <section class="sheet-panel" aria-label="Decimals and column width">
            <label class="sheet-panel__field"><span class="w-label">Decimals</span><input class="w-field" type="number" min="0" max="10" value={selectedStyle.precision??2} disabled={!allowSelected} onchange={event=>style({precision:Number(event.currentTarget.value)})} /></label>
            {#if ysheet}<label class="sheet-panel__field"><span class="w-label">Column width (px)</span><input class="w-field" type="number" min="60" max="600" value={columnWidth(ysheet,selectedColumn)} disabled={!editable} onchange={event=>attempt(()=>setColumnWidth(session.data,current!.id,selectedColumn,Number(event.currentTarget.value),session.origin))} /></label>{/if}
            <button type="button" class="w-ibtn w-ibtn--sm sheet-panel__close" aria-label="Close decimals and column width" onclick={()=>(formatOpen=false)}><Icon name="x" /></button>
        </section>
    {/if}
    {#if protectionOpen}
        <section class="sheet-panel sheet-panel--stack" aria-label="Protected ranges">
            <div class="sheet-panel__head"><h2 class="sheet-panel__title">Protected ranges</h2><button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close protected ranges" onclick={()=>(protectionOpen=false)}><Icon name="x" /></button></div>
            <p class="sheet-panel__text">Protected cells stay readable. Only the owner can edit their values or remove protection.</p>
            {#if $sessionState.meta?.role==='owner'}<div><button type="button" class="w-btn w-btn--sm" disabled={protectBusy||!selection.length} onclick={()=>void protect()}>Protect selected range</button></div>{:else if !$sessionState.meta}<p class="sheet-panel__text">Share this workbook before configuring server-enforced range protection.</p>{/if}
            {#each protections as range (range.id)}<p class="sheet-panel__row"><span class="w-seal"><Icon name="lock" />{$_('office.sheets.protected')}</span><span>{range.label} · {range.rows.length} × {range.columns.length}</span>{#if $sessionState.meta?.role==='owner'}<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={protectBusy} onclick={()=>void protect(range.id)}>Remove protection</button>{/if}</p>{/each}
        </section>
    {/if}
    {#if recoveryOpen}
        <section class="sheet-panel sheet-panel--stack" aria-label="Cell draft recovery">
            <div class="sheet-panel__head"><h2 class="sheet-panel__title">Unsubmitted cell drafts</h2><button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close cell draft recovery" onclick={()=>(recoveryOpen=false)}><Icon name="x" /></button></div>
            {#each cellDrafts as [id, entry] (id)}<p class="sheet-panel__row"><span class="sheet-panel__draft">{entry.text.slice(0,120)||'(empty cell draft)'}</span><button type="button" class="w-btn w-btn--sm" onclick={()=>restoreBuffer(id,entry)}>Restore cell draft</button></p>{/each}
            <div><button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={()=>download('spreadsheet-recovery.wabi.json',session.recovery())}>Export all recovery data</button></div>
        </section>
    {/if}

    <div class="sheet-grid" class:freeze id={gridId} bind:this={grid} tabindex="0" role="region" aria-label="Spreadsheet grid" aria-busy={calculating} onkeydown={keydown} onpaste={paste} onscroll={()=>{scrollTop=grid.scrollTop;viewportHeight=grid.clientHeight;}}>
        {#if current}<table role="grid" aria-label={current.name} aria-rowcount={rows.length+1} aria-colcount={current.columns.length+1} aria-multiselectable="true" style:--sheet-row={`${rowHeight}px`}><colgroup><col class="sheet-col-label"/>{#each current.columns as column(column.id)}<col style:width={`${ysheet?columnWidth(ysheet,column.id):140}px`}/>{/each}</colgroup><thead><tr><th class="row-label corner" scope="col"><span class="sr-only">Row</span></th>{#each current.columns as column,index(column.id)}<th scope="col" class:selected-head={selectedColumns.has(column.id)} style:width={`${ysheet?columnWidth(ysheet,column.id):140}px`}>{columnName(index)}</th>{/each}</tr></thead><tbody>
            {#if first>0}<tr aria-hidden="true"><td colspan={current.columns.length+1} style:height={`${first*rowHeight}px`} class="spacer"></td></tr>{/if}
            {#each visible as row(row.id)}{@const ri=rowIndex.get(row.id)??-1}<tr aria-rowindex={ri+2} style:height={`${rowHeight}px`}><th class="row-label" class:selected-head={selectedRows.has(row.id)} scope="row">{current.rows.findIndex(item=>item.id===row.id)+1}</th>{#each current.columns as column(column.id)}{@const cellStyle=ysheet?styleOf(ysheet,row.id,column.id):{}}{@const isNumber=numeric(row.id,column.id)}{@const ci=colIndex.get(column.id)??-1}<td role="gridcell" class:edge-t={bounds?.r0===ri} class:edge-b={bounds?.r1===ri} class:edge-l={bounds?.c0===ci} class:edge-r={bounds?.c1===ci} aria-readonly={!editable||isProtected(row.id,column.id)} aria-selected={selectedSet.has(cellKey(row.id,column.id))} class:selected={selectedSet.has(cellKey(row.id,column.id))} class:active={row.id===selectedRow&&column.id===selectedColumn} class:protected={isProtected(row.id,column.id)} class:bordered={cellStyle.border} class:num={isNumber} style:font-weight={cellStyle.bold?'700':undefined} style:font-style={cellStyle.italic?'italic':undefined} style:text-align={cellStyle.align||(isNumber?'right':undefined)} style:background-color={cellStyle.fill||undefined} style:white-space={cellStyle.wrap?'normal':undefined} style:width={`${ysheet?columnWidth(ysheet,column.id):140}px`} style:max-width={`${ysheet?columnWidth(ysheet,column.id):140}px`} title={value(row.id,column.id)} onclick={event=>choose(row.id,column.id,event.shiftKey)} ondblclick={()=>{choose(row.id,column.id);startEdit();}}><span style:max-height={`${rowHeight-8}px`}>{value(row.id,column.id)||' '}</span></td>{/each}</tr>{/each}
            {#if last<rows.length}<tr aria-hidden="true"><td colspan={current.columns.length+1} style:height={`${(rows.length-last)*rowHeight}px`} class="spacer"></td></tr>{/if}
        </tbody></table>{/if}
    </div>

    {#if chart!=='none'}
        <!-- The chart: a collapsible card below the grid, in the palette's series colours. -->
        <section class="sheet-chart" class:collapsed={!chartOpen} aria-label="Selected range chart">
            <div class="sheet-chart__head">
                <button type="button" class="w-btn w-btn--quiet w-btn--sm sheet-chart__toggle" aria-expanded={chartOpen} onclick={()=>(chartOpen=!chartOpen)}><Icon name={chartOpen?'chevDown':'chevRight'} size={16} />{CHARTS.find(item=>item.value===chart)?.label}</button>
                <span class="sheet-chart__note">{chartData.length?`${chartData.length} rows from the selection`:'Select a label column and a numeric column'}</span>
                <button type="button" class="w-ibtn w-ibtn--sm" aria-label="Remove chart" onclick={()=>(chart='none')}><Icon name="x" /></button>
            </div>
            {#if chartOpen}
                {#if chartData.length}
                    <div class="sheet-chart__body">
                        <svg viewBox="0 0 600 300" role="img" aria-label={`${chart} chart of the selected two-column range`}>
                            {#if chart==='bar'}<line x1="25" y1={chartY(0)} x2="580" y2={chartY(0)} class="sheet-chart__axis"/>{#each chartData as item,index}<rect x={30+index*540/chartData.length} y={Math.min(chartY(0),chartY(item.value))} width={Math.max(2,450/chartData.length)} height={Math.abs(chartY(0)-chartY(item.value))} style:fill={PIE[0]}><title>{item.label}: {item.value}</title></rect>{/each}
                            {:else if chart==='line'}<line x1="25" y1={chartY(0)} x2="580" y2={chartY(0)} class="sheet-chart__axis"/><polyline points={chartData.map((item,index)=>`${30+index*540/Math.max(1,chartData.length-1)},${chartY(item.value)}`).join(' ')} fill="none" style:stroke={PIE[0]} stroke-width="3"/>
                            {:else}{#each chartData as item,index}<path d={piePath(index)} style:fill={PIE[index%PIE.length]} style:stroke="var(--w-bg)"><title>{item.label}: {item.value}</title></path>{/each}{/if}
                        </svg>
                        <ul class="sheet-chart__legend">{#if chart==='pie'}<li class="sheet-chart__hint">Pie slices use positive values only.</li>{/if}{#each chartData as item,index}<li><span class="sheet-chart__key" style:background-color={chart==='pie'?PIE[index%PIE.length]:PIE[0]}></span>{item.label}<span class="sheet-chart__value">{number(item.value)}</span></li>{/each}</ul>
                    </div>
                {:else}
                    <p class="sheet-chart__empty">Select a label column and a numeric column, then choose a chart.</p>
                {/if}
            {/if}
        </section>
    {/if}

    <!-- 32px footer: sheet tabs (double-click renames, right-click for more) and the readout. -->
    <footer class="sheet-footer">
        <div class="sheet-tabs" role="tablist" aria-label="Sheets">
            {#each available as item (item.id)}
                {#if renamingSheet===item.id}
                    <input class="sheet-tab__rename" aria-label="Sheet name" value={sheetName(item)} maxlength="100" onkeydown={event=>{if(event.key==='Enter'){event.preventDefault();finishRename(item.id,event.currentTarget.value);grid?.focus();}else if(event.key==='Escape'){event.preventDefault();renamingSheet=null;grid?.focus();}}} onblur={event=>finishRename(item.id,event.currentTarget.value)} />
                {:else}
                    <button type="button" role="tab" class="sheet-tab" class:active={item.id===current?.id} aria-selected={item.id===current?.id} aria-controls={gridId} tabindex={item.id===current?.id?0:-1} onclick={()=>switchSheet(item.id)} ondblclick={()=>void startRename(item.id)} oncontextmenu={event=>openTabMenu(event,item.id)} onkeydown={event=>{if(event.key==='F2'){event.preventDefault();void startRename(item.id);}else if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();tabMenuSheet=item.id;tabMenuAnchor=event.currentTarget;tabMenuOpen=true;}}}>{sheetName(item)}</button>
                {/if}
            {/each}
            <Tooltip text="Add sheet" placement="top"><button type="button" class="w-ibtn w-ibtn--sm" aria-label="Add sheet" disabled={!editable} onclick={newSheet}><Icon name="plus" /></button></Tooltip>
        </div>
        <p class="sheet-stats" aria-live="polite">
            {#if calculating}<span>Calculating…</span>
            {:else if stats}{#if stats.numbers}<span>Sum {number(stats.sum)}</span><span>Avg {number(stats.average??0)}</span>{/if}<span>Count {stats.count}</span>
            {:else}<span>{selection.length===1?cellName:''}</span>{/if}
        </p>
    </footer>
</div>

{#if tabMenuAnchor}
    <Menu items={tabMenuItems} label="Sheet actions" anchor={tabMenuAnchor} bind:open={tabMenuOpen} heading={available.find(item=>item.id===tabMenuSheet)?sheetName(available.find(item=>item.id===tabMenuSheet)!):'Sheet'} />
{/if}
