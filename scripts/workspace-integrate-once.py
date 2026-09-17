"""Temporary, idempotent branch-integration helper. Remove after integration."""
from pathlib import Path
import re

def replace(path,before,after):
    p=Path(path);text=p.read_text()
    if after in text:return
    if text.count(before)!=1:raise RuntimeError(f'Expected one anchor in {path}: {before[:80]}')
    p.write_text(text.replace(before,after,1))

def append(path,line):
    p=Path(path);text=p.read_text()
    if line not in text:p.write_text(text+'\n'+line+'\n')

append('core/crates/wabidb/src/projections/mod.rs','pub mod workspace;')
append('core/crates/wabi-server/src/adapter/mod.rs','pub(crate) mod workspace;')
append('core/crates/wabi-server/src/api/mod.rs','pub mod workspace;\nmod workspace_crdt;\nmod workspace_present;')
p=Path('core/crates/wabidb/src/engine/mod.rs');text=p.read_text()
if 'Arc::new(crate::projections::workspace::WorkspaceProjection)' not in text:
    pattern=r'(?m)^([ \t]*)ProjectionRegistration \{\s*\n[ \t]*event_types: &\[crate::projections::game_profiles::EVENT\],'
    matches=list(re.finditer(pattern,text))
    if len(matches)!=1:raise RuntimeError('Workspace registry anchor is absent or ambiguous')
    match=matches[0];indent=match.group(1)
    entry='\n'.join(indent+line for line in [
      'ProjectionRegistration {',
      '    event_types: &[crate::projections::workspace::EVENT, crate::projections::workspace::DELTA_EVENT],',
      '    handler: Arc::new(crate::projections::workspace::WorkspaceProjection),',
      '    index_name: crate::projections::workspace::INDEX,',
      '    record_type_name: "wabidb::projections::workspace::WorkspaceRecord",',
      '},'])+'\n'
    p.write_text(text[:match.start()]+entry+text[match.start():])
p=Path('core/crates/wabi-server/src/api/routes.rs');text=p.read_text()
if '.nest("/workspace",' not in text:
    replace(str(p),'.nest("/wiki", wiki::routes(state.clone()))','.nest("/wiki", wiki::routes(state.clone()))\n        .nest("/workspace", super::workspace::routes(state.clone()))')
p=Path('core/crates/wabi-server/Cargo.toml')
if not re.search(r'(?m)^yrs\s*=',p.read_text()):
    replace(str(p),'[dependencies]','[dependencies]\nyrs = { version = "=0.27.4", features = ["small-client", "sync"] }')
p=Path('core/crates/wabidb/src/projections/workspace.rs');text=p.read_text()
text=text.replace('use crate::error::{Error, Result};\nuse crate::projections::{Projection, ProjectionState};\nuse crate::storage::record::PlainRecord;','use crate::{engine::locks::ProjectionState, error::{Result, WabiError}, projections::handler::{DurableEvent, Projection}};')
text=text.replace('fn invalid() -> Error { Error::InvalidArgument("Invalid workspace record".into()) }','fn invalid() -> WabiError { WabiError::Corrupt { location: INDEX.into(), detail: "Invalid workspace record".into() } }')
text=text.replace('impl Projection for WorkspaceProjection {\n    fn apply(&self, record: &PlainRecord, state: &ProjectionState)','impl Projection for WorkspaceProjection {\n    fn event_type(&self) -> &str { EVENT }\n    fn apply(&self, record: &DurableEvent, state: &ProjectionState)')
text=text.replace('record.plaintext','record.payload').replace('state.insert(INDEX, row.key.as_bytes(), &bytes, record.commit_seq);','state.insert(INDEX, row.key.as_bytes().to_vec(), bytes, record.commit_seq);')
p.write_text(text)
print('Workspace module integration applied without replacing existing APIs.')
