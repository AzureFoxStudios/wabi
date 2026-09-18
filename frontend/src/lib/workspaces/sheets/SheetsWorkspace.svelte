<script lang="ts">
    import {onMount,onDestroy} from 'svelte';
    import ArtifactShell from '../ArtifactShell.svelte';
    import ArtifactLibrary from '../ArtifactLibrary.svelte';
    import SheetsGrid from './SheetsGrid.svelte';
    import {ArtifactSession,createArtifact,openArtifact,download,from64,Y} from '../session';
    import {captureScope,targets,type Scope,type Target} from '../bridge';
    import {initialize,snapshot,addSheet,axes} from './model';
    import {parseFormula,type CellVersion} from './formula';
    import {SheetWorker} from './workerClient';
    import type {ImportedWorkbook} from './engine.worker';
    import '../workspace.css';
    let scope=$state<Scope|null>(null),active=$state<ArtifactSession|null>(null),busy=$state(false),error=$state('');
    let format=$state('xlsx'),importData=$state<ImportedWorkbook|null>(null),importFile=$state<File|null>(null),delimiter=$state(',');
    let dialog=$state<HTMLDialogElement>(),selectionAnchor=$state<string|null>(null),focusAnchor=$state<string|null>(null),activeSheetId=$state('');
    let previousTarget:unknown,stopped=false,generation=0,unsubscribe=()=>{};const worker=new SheetWorker();
    const current=(own:number,owner:Scope)=>!stopped&&own===generation&&owner.isCurrent();
    async function run(fn:(owner:Scope,own:number)=>Promise<void>){
        const owner=scope;if(!owner)return;const own=++generation;error='';busy=true;
        try{await fn(owner,own);}catch(e){if(current(own,owner))error=e instanceof Error?e.message:String(e);}finally{if(current(own,owner))busy=false;}
    }
    async function use(candidate:ArtifactSession,own:number,owner:Scope){
        if(!current(own,owner)){await candidate.close();return;}
        if(candidate===active){await candidate.close();return;}
        const previous=active;if(previous&&!(await previous.close())){await candidate.close();throw new Error('Save or export recovery before closing the current spreadsheet.');}
        if(!current(own,owner)){await candidate.close();return;}active=candidate;selectionAnchor=null;activeSheetId='';
    }
    async function create(){await run(async(owner,own)=>{focusAnchor=null;await use(await createArtifact(owner,'sheets','Untitled spreadsheet',doc=>initialize(doc.getMap('data'))),own,owner);});}
    async function open(id:string){await run(async(owner,own)=>{focusAnchor=null;await use(await openArtifact(owner,id,'sheets'),own,owner);});}
    async function library(){await run(async(owner,own)=>{if(active&&!(await active.close()))throw new Error('Local save failed. Export recovery before leaving.');if(current(own,owner)){active=null;selectionAnchor=null;focusAnchor=null;}});}
    async function target(input:Target){if(input.id)await run(async(owner,own)=>{focusAnchor=input.anchor||null;await use(await openArtifact(owner,input.id!,'sheets'),own,owner);});}
    async function loadFile(file:File){await run(async(owner,own)=>{
        if(file.size>(file.name.endsWith('.wabi.json')?24:12)*1024*1024)throw new Error('File exceeds the supported import size.');
        if(file.name.endsWith('.wabi.json')){
            const value=JSON.parse(await file.text());if(!current(own,owner))return;
            if(value.schema!==1||value.kind!=='sheets'||typeof value.update!=='string')throw new Error('Not a Wabi spreadsheet backup.');
            const source=new Y.Doc();try{
                Y.applyUpdate(source,from64(value.update));const data=source.getMap('data');if(data.get('schema')!==1||!(data.get('sheets') instanceof Y.Map))throw new Error('Unsupported workbook schema.');
                // Source data stays separate until the new local transaction commits.
                await use(await createArtifact(owner,'sheets',source.getText('title').toString(),doc=>{const destination=doc.getMap('data');for(const[key,item]of data)destination.set(key,item instanceof Y.Map||item instanceof Y.Array||item instanceof Y.Text?item.clone():item);},'native',undefined,{name:file.name,type:file.type,blob:file}),own,owner);
            }finally{source.destroy();}return;
        }
        const buffer=await file.arrayBuffer();if(!current(own,owner))return;
        const parsed=await worker.run<ImportedWorkbook>('import',{buffer,name:file.name,delimiter:file.name.toLowerCase().endsWith('.tsv')?'\t':delimiter});
        if(!current(own,owner))return;importFile=file;importData=parsed;dialog?.showModal();worker.close();
    });}
    async function confirmImport(){await run(async(owner,own)=>{
        if(!importData||!importFile)return;const data=importData,file=importFile;
        const candidate=await createArtifact(owner,'sheets',file.name,doc=>{
            const root=doc.getMap('data');root.set('schema',1);root.set('sheets',new Y.Map());
            const created=data.sheets.map(sheet=>addSheet(root,sheet.name,sheet.rows,sheet.columns)),book=snapshot(root);
            doc.transact(()=>{data.sheets.forEach((source,index)=>{
                const target=created[index],rows=axes(target.sheet,'rows'),columns=axes(target.sheet,'columns'),ops=target.sheet.get('ops') as Y.Map<CellVersion>;
                for(const cell of source.cells){
                    if(!rows[cell.r]||!columns[cell.c]||cell.input.length>8192)throw new Error('Imported cell exceeds the supported target or text limits.');
                    const id=crypto.randomUUID(),version:CellVersion={id,cell:`${rows[cell.r].id}|${columns[cell.c].id}`,input:cell.input,parents:[],imported:true,...(cell.literal!==undefined?{literal:cell.literal}:{}),...(cell.cached!==undefined?{cached:cell.cached}:{})};
                    if(cell.input.startsWith('=')&&cell.literal===undefined){try{version.expression=parseFormula(cell.input,book,target.id);}catch(e){version.parseError=e instanceof Error?e.message:'#UNSUPPORTED!';}}ops.set(id,version);
                }
            });});
        },'native',undefined,{name:file.name,type:file.type,blob:file});
        await use(candidate,own,owner);if(current(own,owner)){importData=null;importFile=null;dialog?.close();}worker.close();
    });}
    async function exportFile(){await run(async(owner,own)=>{
        const source=active;if(!source)return;await source.flush();if(!current(own,owner))return;
        const book=snapshot(source.data),activeId=book.sheets.some(sheet=>sheet.id===activeSheetId)?activeSheetId:book.sheets[0]?.id;if(!activeId)throw new Error('Workbook is empty.');
        const result=await worker.run<{bytes:ArrayBuffer;type:string}>('export',{book,format,activeId});
        if(current(own,owner))download(`${source.title}.${format}`,new Blob([result.bytes],{type:result.type}));worker.close();
    });}
    async function useCopy(copy:ArtifactSession){const owner=scope;if(!owner){await copy.close();return;}focusAnchor=null;await use(copy,++generation,owner);}
    function cancelFile(){worker.close();generation++;busy=false;importData=null;importFile=null;dialog?.close();}
    onMount(()=>{void captureScope().then(owner=>{if(stopped||!owner.isCurrent())return;scope=owner;unsubscribe=targets.subscribe(value=>{if(value.sheets&&value.sheets!==previousTarget){previousTarget=value.sheets;void target(value.sheets);}});}).catch(e=>{if(!stopped)error=e.message;});});
    onDestroy(()=>{stopped=true;generation++;unsubscribe();worker.close();if(active)void active.close();});
</script>
{#if scope&&active}{#key active.id}<ArtifactShell session={active} onlibrary={library} {selectionAnchor} onanchor={anchor=>focusAnchor=anchor} oncopy={useCopy}>
    <div class="workspace-toolbar exports"><select aria-label="Spreadsheet export format" bind:value={format}><option value="xlsx">XLSX supported subset</option><option value="ods">ODS supported subset</option><option value="csv">CSV — active sheet</option><option value="tsv">TSV — active sheet</option></select><button disabled={busy} onclick={()=>void exportFile()}>Export spreadsheet</button><small>Portable values and supported formulas; advanced Office layout is not a lossless round trip. Native backup retains Wabi formatting and history.</small></div>
    <div class="grid-host"><SheetsGrid session={active} onselection={anchor=>selectionAnchor=anchor} onactivesheet={id=>activeSheetId=id} {focusAnchor}/></div>
</ArtifactShell>{/key}
{:else if scope}<section class="wabi-workspace"><ArtifactLibrary {scope} kind="sheets" label="Sheets" onopen={open} onnew={create} onimport={loadFile} accept=".csv,.tsv,.xlsx,.ods,.wabi.json"/><label class="workspace-home-note">CSV delimiter <select aria-label="CSV delimiter" bind:value={delimiter}><option value=",">Comma</option><option value=";">Semicolon</option><option value="\t">Tab</option></select></label></section>{/if}
{#if busy}<div class="workspace-home-note" role="status">Working on this device… <button onclick={cancelFile}>Cancel file operation</button></div>{/if}
{#if error}<div class="workspace-home-note" role="alert">{error}{#if active}<button onclick={()=>download(`${active!.title}.wabi.json`,active!.recovery())}>Export recovery</button>{/if}</div>{/if}
<dialog class="workspace-dialog" bind:this={dialog} aria-label="Spreadsheet import preview"><h2>Import preview</h2><p>The original is retained. Confirming creates a private editable Wabi copy; it does not upload the file.</p>
    {#if importData}{#each importData.warnings as warning}<p>{warning}</p>{/each}{#each importData.sheets as sheet}<h3>{sheet.name}</h3><p>{sheet.rows} rows · {sheet.columns} columns · {sheet.cells.length} populated cells</p><table><tbody>{#each [0,1,2,3,4] as r}<tr>{#each [0,1,2,3,4] as c}<td>{sheet.cells.find(cell=>cell.r===r&&cell.c===c)?.input||''}</td>{/each}</tr>{/each}</tbody></table>{/each}{/if}
    <div class="workspace-toolbar"><button disabled={busy} onclick={cancelFile}>Cancel</button><button class="primary" disabled={busy} onclick={()=>void confirmImport()}>Create private spreadsheet</button></div>{#if error}<p role="alert">{error}</p>{/if}
</dialog>
<style>.exports{padding:.5rem;font-size:.8rem}.exports small{color:var(--text-secondary,#b5bad0)}.grid-host{height:calc(100% - 52px);min-height:300px}dialog table{border-collapse:collapse;max-width:100%}dialog td{border:1px solid var(--border-subtle,#444);padding:.3rem;max-width:90px;overflow:hidden;white-space:nowrap}</style>
