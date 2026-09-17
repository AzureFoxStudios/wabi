"""Temporary source repairs, committed only on the isolated implementation branch."""
from pathlib import Path
import re,runpy

def rewrite(path,fn):
    p=Path(path);before=p.read_text();after=fn(before)
    if after!=before:p.write_text(after)

rewrite('scripts/workspace-ui-integrate.py',lambda s:s.replace('isModelTabActive','isModelViewportTabActive').replace('workspaceToolFromTab(activeTabId)','workspaceToolFromTab($activeTabId)'))
rewrite('frontend/src/lib/components/MainLayout.svelte',lambda s:s.replace('workspaceToolFromTab(activeTabId)','workspaceToolFromTab($activeTabId)'))
rewrite('frontend/src/lib/workspaces/ArtifactShell.svelte',lambda s:s.replace('{#else}','{:else}').replace(
    'const editable=$derived(($sessionState.tick,session.editable));',
    'const editable=$derived(!$sessionState.meta||["owner","editor"].includes($sessionState.meta.role));\n    const title=$derived.by(()=>{$sessionState.tick;return session.title;});'
).replace('value={($sessionState.tick,session.title)}','value={title}'))
rewrite('frontend/src/lib/workspaces/present/files.ts',lambda s:s.replace('isEvalSupported:false,','enableXfa:false,useWasm:false,'))
rewrite('frontend/src/lib/workspaces/AudienceWorkspace.svelte',lambda s:re.sub(r'(?<!\$)\bstate\b','presentationState',s))
rewrite('frontend/src/lib/workspaces/present/PresentWorkspace.svelte',lambda s:s.replace(
    "const slides=$derived((tick,active?readSlides(active.data):[]));const current=$derived(slides.find(s=>s.id===selectedId)||slides[0]||null);const aspect=$derived((tick,active?Number(active.data.get('aspect')||16/9):16/9));const editable=$derived((tick,active?.editable||false));const liveTitle=$derived((tick,active?.title||''));",
    "const slides=$derived.by(()=>{tick;return active?readSlides(active.data):[];});const current=$derived(slides.find(s=>s.id===selectedId)||slides[0]||null);const aspect=$derived.by(()=>{tick;return active?Number(active.data.get('aspect')||16/9):16/9;});const editable=$derived.by(()=>{tick;return active?.editable||false;});const liveTitle=$derived.by(()=>{tick;return active?.title||'';});"
).replace('let notes:Record<string,string>={};','let notes=$state<Record<string,string>>({});'))
rewrite('core/crates/wabi-server/tests/workspace_contract.rs',lambda s:s.replace(
    'fn document()->Doc{let doc=empty();{let mut tx=doc.transact_mut();doc.get_or_insert_text("title").insert(&mut tx,0,"Shared lesson");doc.get_or_insert_text("body").insert(&mut tx,0,"Original คน 🙂");}doc}',
    'fn document()->Doc{let doc=empty();let title=doc.get_or_insert_text("title");let body=doc.get_or_insert_text("body");{let mut tx=doc.transact_mut();title.insert(&mut tx,0,"Shared lesson");body.insert(&mut tx,0,"Original คน 🙂");}doc}'
))
rewrite('core/crates/wabi-server/src/api/workspace_crdt.rs',lambda s:s.replace('format!("{:x}",Sha256::digest(text.as_bytes()))','Sha256::digest(text.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>()').replace('format!("{:x}",Sha256::digest(current.as_bytes()))','Sha256::digest(current.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>()'))
if Path('scripts/workspace-hardening.py').exists():runpy.run_path('scripts/workspace-hardening.py',run_name='__main__')
print('Compiler repairs applied; no diagnostics or test assertions disabled.')
