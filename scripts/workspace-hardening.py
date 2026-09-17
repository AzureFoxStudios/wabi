"""Targeted implementation hardening. Every edit is committed on the task branch before checks."""
from pathlib import Path

def edit(path,before,after):
    p=Path(path);text=p.read_text()
    if after in text:return
    if text.count(before)!=1:raise RuntimeError(f'Hardening anchor missing/ambiguous: {path}: {before[:90]}')
    p.write_text(text.replace(before,after,1))

session='frontend/src/lib/workspaces/session.ts'
edit(session,'    private added:Record<string,Uint8Array>={};','    private localEpoch=0;private persistedEpoch=0;private persistedMeta="";\n    private added:Record<string,Uint8Array>={};')
edit(session,"        this.show();if(record.meta)this.startPolling();","        this.persistedMeta=JSON.stringify(record.meta);this.show();if(record.meta)this.startPolling();")
edit(session,"private changed=(update:Uint8Array,origin:unknown)=>{if(this.closed)return;","private changed=(update:Uint8Array,origin:unknown)=>{if(this.closed)return;if(origin!=='storage')this.localEpoch++;")
edit(session,"tick:v.tick+1,meta:this.record.meta,reviews:this.record.reviews,error,status:","tick:v.tick,meta:this.record.meta,reviews:this.record.reviews,error,status:")
edit(session,"const action=async()=>{const added={...this.added},ack=[...this.acked];const input=", "const action=async()=>{const added={...this.added},ack=[...this.acked];const epoch=this.localEpoch;const metadata=JSON.stringify(this.record.meta);if(epoch===this.persistedEpoch&&!Object.keys(added).length&&!ack.length&&metadata===this.persistedMeta){if(get(this.state).error)this.show();return;}const input=")
edit(session,"try{const saved=await persist(input,added,ack);for(const id", "try{const saved=await persist(input,added,ack);this.persistedEpoch=epoch;this.persistedMeta=JSON.stringify(saved.meta);for(const id")
# A current metadata update need not force grid recalculation; actual Y.Doc changes advance tick.
# Storage permission changes still replace the reactive metadata object.

model='frontend/src/lib/workspaces/sheets/model.ts'
edit(model,"prepared?:{expression?:Expr;literal?:Scalar;cached?:Scalar;imported?:boolean}){", "prepared?:{expression?:Expr;literal?:Scalar;cached?:Scalar;imported?:boolean},expectedParents?:string[]){")
edit(model,"parents:old.map(v=>v.id),", "parents:expectedParents??old.map(v=>v.id),")

grid='frontend/src/lib/workspaces/sheets/SheetsGrid.svelte'
edit(grid,"let draft=$state('');let editing=$state(false);", "let draft=$state('');let editing=$state(false);let editingTarget:{sheet:string;row:string;column:string;parents:string[]}|null=null;")
edit(grid,"function choose(row:string,column:string,extend=false){if(editing)commit();", "function choose(row:string,column:string,extend=false){if(editing&&!commit())return;")
edit(grid,"function commit(){if(!editing||!current||!editable)return;attempt(()=>{setCell(session.data,current.id,selectedRow,selectedColumn,draft,session.origin);editing=false;});}", "function commit():boolean{if(!editing)return true;if(!editingTarget||!editable){error='Editing permission changed. Copy the unsent cell text before leaving.';return false;}try{const target=editingTarget;setCell(session.data,target.sheet,target.row,target.column,draft,session.origin,undefined,target.parents);editing=false;editingTarget=null;error='';return true;}catch(e){error=e instanceof Error?e.message:String(e);return false;}}")
edit(grid,"function startEdit(){if(!editable)return;editing=true;formulaInput?.focus();formulaInput?.select();}", "function beginEdit(){if(!editable||!current)return;if(!editingTarget)editingTarget={sheet:current.id,row:selectedRow,column:selectedColumn,parents:selectedVersions.map(v=>v.id)};editing=true;}\n    function startEdit(){if(!editable)return;beginEdit();formulaInput?.focus();formulaInput?.select();}")
edit(grid,"onfocus={()=>editing=true}","onfocus={beginEdit}")
edit(grid,"event.preventDefault();draft=event.key;editing=true;formulaInput.focus();", "event.preventDefault();beginEdit();draft=event.key;formulaInput.focus();")
edit(grid,"if(event.key==='Escape'){editing=false;draft=", "if(event.key==='Escape'){editing=false;editingTarget=null;draft=")
edit(grid,"commit();sheetId=event.currentTarget.value;", "if(!commit()){event.currentTarget.value=current?.id||'';return;}sheetId=event.currentTarget.value;")
edit(grid,"if(extend){endRow=row;endColumn=column;}", "grid?.focus();if(extend){endRow=row;endColumn=column;}")
edit(grid,"recoverRemoved,cellKey,heads,inputOf", "recoverRemoved,cachedResultIsStale,cellKey,heads,inputOf")
edit(grid,"`${String(v[0].cached??'')} †`", "`${String(v[0].cached??'')} ${cachedResultIsStale(session.data)?'STALE':'†'}`")
edit(grid,"† Imported cached result, not a fresh calculation", "† Imported cached result; STALE means the workbook changed and that result must not be trusted")
# Bound aggregate functions without argument-spread stack growth.
formula='frontend/src/lib/workspaces/sheets/formula.ts'
edit(formula,"Math.min(...nums)","nums.reduce((a,b)=>Math.min(a,b))")
edit(formula,"Math.max(...nums)","nums.reduce((a,b)=>Math.max(a,b))")

# Stop giving ended sessions new copies of audience slides. Already downloaded copies cannot be revoked.
p='core/crates/wabi-server/src/api/workspace_present.rs'
edit(p,"\"slides\":if edition==Some(p.edition.as_str()){None}else{Some(&p.slides)}", "\"slides\":if p.ended{Some(Vec::<Slide>::new())}else if edition==Some(p.edition.as_str()){None}else{Some(p.slides.clone())}")
print('Idle-save, scalar-intent, stale-cache, and ended-audience hardening applied.')
