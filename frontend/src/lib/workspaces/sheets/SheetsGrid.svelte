<script lang="ts">
    import {onDestroy} from 'svelte';
    import {download,Y,type ArtifactSession,type PrivateDraft} from '../session';
    import {request,type Meta,type ProtectedRange} from '../bridge';
    import {parseAnchor,rangeAnchor} from '../anchors';
    import {orderedSheets,snapshot,sheets,setCell,setCells,setStyle,styleOf,formatValue,addSheet,renameSheet,reorderSheet,removeSheet,restoreSheet,insertAxis,removeAxis,reorderRows,columnWidth,setColumnWidth,fill,recoverRemoved,cachedResultIsStale,cellKey,heads,inputOf,type CellStyle,type CellTarget} from './model';
    import {columnName,type Calculation} from './formula';
    import {SheetWorker} from './workerClient';
    let {session,onselection,onactivesheet,focusAnchor}:{session:ArtifactSession;onselection?:(anchor:string|null)=>void;onactivesheet?:(id:string)=>void;focusAnchor?:string|null}=$props();
    const sessionState=session.state;
    let sheetId=$state(''),selectedRow=$state(''),selectedColumn=$state(''),endRow=$state(''),endColumn=$state('');
    let filter=$state(''),sort=$state<'none'|'asc'|'desc'>('none'),scrollTop=$state(0),viewportHeight=$state(600);
    let grid:HTMLDivElement,formulaInput:HTMLInputElement;
    let draft=$state(''),editing=$state(false),error=$state(''),notice=$state(''),chart=$state<'none'|'bar'|'line'|'pie'>('none');
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
    const rowHeight=$derived.by(()=>{dataEpoch;const styles=ysheet?.get('styles');return styles instanceof Y.Map&&Array.from(styles.values()).some(style=>(style as CellStyle).wrap)?72:32;});
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
        return formatValue(calculations.values[key]??(versions[0]?.literal??null),styleOf(ysheet,row,column));
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
        try{await navigator.clipboard.writeText(text);notice='Selected values copied as a text-safe snapshot. No hidden cells or formulas were included.';}catch{error='Clipboard access was denied. Use export instead.';}
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
        let row=rows.findIndex(item=>item.id===selectedRow),column=current.columns.findIndex(item=>item.id===selectedColumn);const direction:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],Tab:[0,event.shiftKey?-1:1]};
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
            if(disposed)return;session.record.meta=response.meta;await session.flush();notice='Range protection saved on the server.';
        }catch(e){if(!disposed)error=e instanceof Error?e.message:String(e);}finally{if(!disposed)protectBusy=false;}
    }
    const chartData=$derived.by(()=>{if(!current)return[];const rs=[...new Set(selection.map(cell=>cell.row))].slice(0,30),cs=[...new Set(selection.map(cell=>cell.column))];if(cs.length<2)return[];return rs.map(row=>({label:value(row,cs[0]),value:calculations.values[`${current.id}/${cellKey(row,cs[1])}`]})).filter((item):item is{label:string;value:number}=>typeof item.value==='number'&&Number.isFinite(item.value));});
    const minimum=$derived(Math.min(0,...chartData.map(item=>item.value))),maximum=$derived(Math.max(1,...chartData.map(item=>item.value)));
    const chartY=(value:number)=>260-(value-minimum)/(maximum-minimum)*220;
    function piePath(index:number){const positive=chartData.map(item=>Math.max(0,item.value)),total=positive.reduce((a,b)=>a+b,0);if(!total)return'';const begin=positive.slice(0,index).reduce((a,b)=>a+b,0)/total*Math.PI*2-Math.PI/2,span=positive[index]/total*Math.PI*2,end=begin+Math.min(span,Math.PI*2-.00001);const x=(angle:number)=>200+110*Math.cos(angle),y=(angle:number)=>140+110*Math.sin(angle);return`M200 140 L${x(begin)} ${y(begin)} A110 110 0 ${end-begin>Math.PI?1:0} 1 ${x(end)} ${y(end)} Z`;}
</script>
<div class="sheets-editor">
    <div class="workspace-toolbar sheet-tools"><select aria-label="Active sheet" value={current?.id} onchange={event=>{if(!commit()){event.currentTarget.value=current?.id||'';return;}sheetId=event.currentTarget.value;scrollTop=0;filter='';sort='none';}}>{#each available as item(item.id)}<option value={item.id}>{String(item.value.get('name'))}</option>{/each}</select>
        <button disabled={!editable} onclick={()=>attempt(()=>{if(!commit())return;session.doc.transact(()=>{sheetId=addSheet(session.data,`Sheet ${available.length+1}`).id;},session.origin);})}>+ Sheet</button>
        {#if ysheet}<input aria-label="Sheet name" value={String(ysheet.get('name'))} disabled={!editable} maxlength="100" onchange={event=>attempt(()=>renameSheet(session.data,current!.id,event.currentTarget.value,session.origin))}/>{/if}
        <button disabled={!editable} onclick={()=>attempt(()=>reorderSheet(session.data,current!.id,-1,session.origin))}>Move sheet left</button><button disabled={!editable} onclick={()=>attempt(()=>reorderSheet(session.data,current!.id,1,session.origin))}>Move sheet right</button>
        <button disabled={!editable||available.length<2} onclick={()=>attempt(()=>{if($sessionState.meta?.role!=='owner'&&protections.some(range=>range.sheetId===current?.id))throw new Error('This sheet contains protected cells.');if(commit())removeSheet(session.data,current!.id,session.origin);})}>Remove sheet</button>
        <button disabled={!allowSelected} onclick={()=>style({bold:!selectedStyle.bold})}>Bold</button><button disabled={!allowSelected} onclick={()=>style({italic:!selectedStyle.italic})}>Italic</button><button disabled={!allowSelected} onclick={()=>style({bold:false,italic:false,fill:'',border:false,wrap:false,format:'general'})}>Plain</button>
        <select aria-label="Cell number format" value={selectedStyle.format||'general'} disabled={!allowSelected} onchange={event=>style({format:event.currentTarget.value as CellStyle['format']})}><option value="general">General</option><option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option><option value="date">Date (native serial)</option><option value="text">Text</option></select>
        <select aria-label="Currency" value={selectedStyle.currency||'USD'} disabled={!allowSelected} onchange={event=>style({currency:event.currentTarget.value})}><option>USD</option><option>THB</option><option>EUR</option><option>GBP</option><option>JPY</option></select>
        <input aria-label="Decimal precision" type="number" min="0" max="10" value={selectedStyle.precision??2} disabled={!allowSelected} onchange={event=>style({precision:Number(event.currentTarget.value)})}/>
        <select aria-label="Cell alignment" value={selectedStyle.align||'left'} disabled={!allowSelected} onchange={event=>style({align:event.currentTarget.value as CellStyle['align']})}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
        <input aria-label="Cell fill color" type="color" value={selectedStyle.fill||'#30364a'} disabled={!allowSelected} oninput={event=>style({fill:event.currentTarget.value})}/>
        <button disabled={!allowSelected} onclick={()=>style({wrap:!selectedStyle.wrap})}>Wrap</button><button disabled={!allowSelected} onclick={()=>style({border:!selectedStyle.border})}>Borders</button>
        {#if ysheet}<input aria-label="Column width" type="number" min="60" max="600" value={columnWidth(ysheet,selectedColumn)} disabled={!editable} onchange={event=>attempt(()=>setColumnWidth(session.data,current!.id,selectedColumn,Number(event.currentTarget.value),session.origin))}/>{/if}
    </div>
    <div class="workspace-toolbar sheet-tools">
        <button disabled={!editable} onclick={()=>axis('rows')}>Insert row</button><button disabled={!editable} onclick={()=>axis('columns')}>Insert column</button><button disabled={!editable} onclick={()=>axis('rows',true)}>Delete row</button><button disabled={!editable} onclick={()=>axis('columns',true)}>Delete column</button><button disabled={!editable} onclick={fillDown}>Fill down</button><button onclick={()=>void copy()}>Copy range</button>
        <input aria-label="Filter my view" placeholder="Filter my view…" bind:value={filter}/><select aria-label="Sort my view by selected column" bind:value={sort}><option value="none">Original row order</option><option value="asc">Selected column: ascending</option><option value="desc">Selected column: descending</option></select>
        <button disabled={!editable||!!filter||sort==='none'} onclick={()=>attempt(()=>{if(commit()){reorderRows(session.data,current!.id,rows.map(row=>row.id),session.origin);sort='none';}})}>Apply row order to everyone</button>
        <button onclick={()=>freeze=!freeze}>{freeze?'Unfreeze headers':'Freeze headers'}</button><button onclick={()=>protectionOpen=!protectionOpen}>Protected ranges {protections.length||''}</button>
        <select aria-label="Chart selected range" bind:value={chart}><option value="none">No chart</option><option value="bar">Bar chart</option><option value="line">Line chart</option><option value="pie">Pie chart</option></select>
        {#if cellDrafts.length}<button onclick={()=>recoveryOpen=!recoveryOpen}>Recover cell drafts {cellDrafts.length}</button>{/if}
        <span>{selection.length} selected · {calculating?'Calculating…':'Calculated'} · † source-cached result; STALE means the workbook changed.</span>
    </div>
    {#if protectionOpen}<section class="sheet-tools" aria-label="Protected ranges"><p>Protected cells remain readable. Only the owner can edit their values or remove protection.</p>
        {#if $sessionState.meta?.role==='owner'}<button disabled={protectBusy||!selection.length} onclick={()=>void protect()}>Protect selected range</button>{:else if !$sessionState.meta}<p>Share this workbook before configuring server-enforced range protection.</p>{/if}
        {#each protections as range(range.id)}<p>{range.label} · {range.rows.length} × {range.columns.length}{#if $sessionState.meta?.role==='owner'} <button disabled={protectBusy} onclick={()=>void protect(range.id)}>Remove protection</button>{/if}</p>{/each}
    </section>{/if}
    {#if recoveryOpen}<section class="sheet-tools" aria-label="Cell draft recovery">{#each cellDrafts as[id,entry](id)}<p>{entry.text.slice(0,120)||'(empty cell draft)'} <button onclick={()=>restoreBuffer(id,entry)}>Restore cell draft</button></p>{/each}<button onclick={()=>download('spreadsheet-recovery.wabi.json',session.recovery())}>Export all recovery data</button></section>{/if}
    <form class="formula-bar" onsubmit={event=>{event.preventDefault();if(commit())grid?.focus();}}><span>{current?`${columnName(current.columns.findIndex(column=>column.id===selectedColumn))}${current.rows.findIndex(row=>row.id===selectedRow)+1}`:''}</span><input aria-label="Cell value or formula" bind:this={formulaInput} value={draft} maxlength="8192" disabled={!editable||(!editing&&selectionProtected)} onfocus={beginEdit} oninput={event=>stage(event.currentTarget.value)} onblur={()=>commit()} onkeydown={event=>{if(event.key==='Escape'){event.preventDefault();cancelEdit();}}}/><button disabled={!editable}>Apply</button>{#if editing}<button type="button" onpointerdown={event=>event.preventDefault()} onclick={cancelEdit}>Cancel cell edit</button>{/if}</form>
    {#if error}<p class="workspace-notice" role="alert">{error}</p>{/if}{#if notice}<p class="sheet-tools" role="status">{notice}</p>{/if}
    {#if selectedVersions.length>1}<div class="workspace-notice" role="alert"><span>This cell has competing edits. Choose one or enter a replacement; alternatives remain in saved history.</span>{#each selectedVersions as version(version.id)}<button disabled={!allowSelected} onclick={()=>attempt(()=>{if(current){permitted([{row:selectedRow,column:selectedColumn}]);setCell(session.data,current.id,selectedRow,selectedColumn,version.input,session.origin,version.expression?{expression:version.expression}:undefined);}})}>{version.input||'(empty)'}</button>{/each}</div>{/if}
    {#if chart!=='none'}<section class="sheet-chart" aria-label="Selected range chart">{#if chartData.length}<svg viewBox="0 0 600 300" role="img" aria-label={`${chart} chart of the selected two-column range`}>
        {#if chart==='bar'}<line x1="25" y1={chartY(0)} x2="580" y2={chartY(0)} stroke="currentColor"/>{#each chartData as item,index}<rect x={30+index*540/chartData.length} y={Math.min(chartY(0),chartY(item.value))} width={Math.max(2,450/chartData.length)} height={Math.abs(chartY(0)-chartY(item.value))} fill="currentColor"><title>{item.label}: {item.value}</title></rect>{/each}
        {:else if chart==='line'}<polyline points={chartData.map((item,index)=>`${30+index*540/Math.max(1,chartData.length-1)},${chartY(item.value)}`).join(' ')} fill="none" stroke="currentColor" stroke-width="3"/>
        {:else}{#each chartData as item,index}<path d={piePath(index)} fill={`hsl(${index*61} 55% 55%)`} stroke="var(--surface-base,#161826)"><title>{item.label}: {item.value}</title></path>{/each}{/if}
    </svg><div>{#if chart==='pie'}<small>Pie slices use positive values only.</small>{/if}{#each chartData as item}<span>{item.label}: {item.value}</span>{/each}</div>{:else}<p>Select a label column and a numeric column, then choose a chart.</p>{/if}</section>{/if}
    <div class="sheet-grid" class:freeze bind:this={grid} tabindex="0" role="region" aria-label="Spreadsheet grid" aria-busy={calculating} onkeydown={keydown} onpaste={paste} onscroll={()=>{scrollTop=grid.scrollTop;viewportHeight=grid.clientHeight;}}>
        {#if current}<table role="grid" aria-rowcount={rows.length+1} aria-colcount={current.columns.length+1}><colgroup><col style:width="52px"/>{#each current.columns as column(column.id)}<col style:width={`${ysheet?columnWidth(ysheet,column.id):140}px`}/>{/each}</colgroup><thead><tr><th class="row-label">#</th>{#each current.columns as column,index(column.id)}<th scope="col" style:width={`${ysheet?columnWidth(ysheet,column.id):140}px`}>{columnName(index)}</th>{/each}</tr></thead><tbody>
            {#if first>0}<tr aria-hidden="true"><td colspan={current.columns.length+1} style:height={`${first*rowHeight}px`} class="spacer"></td></tr>{/if}
            {#each visible as row(row.id)}<tr aria-rowindex={rows.findIndex(item=>item.id===row.id)+2} style:height={`${rowHeight}px`}><th class="row-label" scope="row">{current.rows.findIndex(item=>item.id===row.id)+1}</th>{#each current.columns as column(column.id)}{@const cellStyle=ysheet?styleOf(ysheet,row.id,column.id):{}}<td role="gridcell" aria-readonly={!editable||isProtected(row.id,column.id)} aria-selected={selectedSet.has(cellKey(row.id,column.id))} class:selected={selectedSet.has(cellKey(row.id,column.id))} class:active={row.id===selectedRow&&column.id===selectedColumn} class:protected={isProtected(row.id,column.id)} class:bordered={cellStyle.border} style:font-weight={cellStyle.bold?'700':'400'} style:font-style={cellStyle.italic?'italic':'normal'} style:text-align={cellStyle.align||'left'} style:background-color={cellStyle.fill||undefined} style:white-space={cellStyle.wrap?'normal':'nowrap'} style:width={`${ysheet?columnWidth(ysheet,column.id):140}px`} style:max-width={`${ysheet?columnWidth(ysheet,column.id):140}px`} title={value(row.id,column.id)} onclick={event=>choose(row.id,column.id,event.shiftKey)} ondblclick={()=>{choose(row.id,column.id);startEdit();}}><span style:max-height={`${rowHeight-8}px`}>{value(row.id,column.id)||'\u00a0'}</span></td>{/each}</tr>{/each}
            {#if last<rows.length}<tr aria-hidden="true"><td colspan={current.columns.length+1} style:height={`${(rows.length-last)*rowHeight}px`} class="spacer"></td></tr>{/if}
        </tbody></table>{/if}
    </div>
    {#if ysheet&&recoverRemoved(ysheet).length}<div class="sheet-tools"><span>Content in removed rows or columns remains recoverable.</span><button onclick={()=>download('removed-sheet-content.json',JSON.stringify(recoverRemoved(ysheet!),null,2))}>Export removed content</button></div>{/if}
    {#if removedSheets.length}<details class="sheet-tools"><summary>Removed sheets retained for recovery</summary>{#each removedSheets as item(item.id)}<button disabled={!editable} onclick={()=>attempt(()=>restoreSheet(session.data,item.id,session.origin))}>Restore {item.name}</button>{/each}</details>{/if}
</div>
<style>
.sheets-editor{height:100%;display:flex;flex-direction:column;min-height:0}.sheet-tools{padding:.5rem;border-bottom:1px solid var(--border-subtle,#35384c);font-size:.8rem}.sheet-tools input{max-width:160px}.sheet-tools input[type=number]{width:80px}.sheet-tools input[type=color]{width:42px}.sheet-tools span{color:var(--text-secondary,#b5bad0)}.formula-bar{display:flex;align-items:center;gap:.5rem;padding:.5rem}.formula-bar span{min-width:64px;text-align:center;font-variant-numeric:tabular-nums}.formula-bar input{flex:1;min-width:0;font-family:monospace}.sheet-grid{overflow:auto;flex:1;min-height:260px;background:var(--surface-base,#161826);outline:none}.sheet-grid:focus-visible{outline:2px solid var(--accent-primary,#aaa4ff);outline-offset:-2px}table{border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:13px;font-variant-numeric:tabular-nums}th,td{box-sizing:border-box;min-width:60px;height:32px;padding:3px 7px;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--border-subtle,#35384c);border-bottom:1px solid var(--border-subtle,#35384c)}td span{display:block;overflow:hidden;overflow-wrap:anywhere}thead th{background:var(--surface-raised,#25293f)}.row-label{min-width:52px;max-width:52px;width:52px;background:var(--surface-raised,#25293f)}.freeze thead th{position:sticky;top:0;z-index:3}.freeze .row-label{position:sticky;left:0;z-index:2}.freeze thead .row-label{z-index:4}.selected{box-shadow:inset 0 0 0 999px color-mix(in srgb,var(--accent-primary,#8d80dc) 20%,transparent)}.active{outline:2px solid var(--accent-primary,#aa9ff6);outline-offset:-2px}.protected{background-image:repeating-linear-gradient(135deg,transparent 0 8px,#8881 8px 10px)}.bordered{border:1px solid var(--text-secondary,#aab)}.spacer{padding:0;border:0}.sheet-chart{height:220px;min-height:220px;display:flex;overflow:auto;padding:.5rem;color:var(--accent-primary,#9e96eb)}.sheet-chart svg{height:100%;min-width:350px}.sheet-chart div{display:flex;flex-direction:column;color:var(--text-secondary,#b5bad0);font-size:.8rem}
</style>
