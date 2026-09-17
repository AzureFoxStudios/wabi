"""Temporary, idempotent branch-integration helper. Remove after integration."""
from pathlib import Path
import re

def append(path,line):
    p=Path(path);text=p.read_text()
    if line not in text:p.write_text(text+'\n'+line+'\n')

append('core/crates/wabidb/src/projections/mod.rs','pub mod workspace;')
append('core/crates/wabi-server/src/adapter/mod.rs','pub(crate) mod workspace;')
for line in ['pub mod workspace;','mod workspace_crdt;','mod workspace_present;']:
    append('core/crates/wabi-server/src/api/mod.rs',line)
p=Path('core/crates/wabidb/src/engine/mod.rs');text=p.read_text()
if 'Arc::new(crate::projections::workspace::WorkspaceProjection)' not in text:
    pattern=r'(?m)^([ \t]*)ProjectionRegistration \{\s*\n[ \t]*event_types: &\[crate::projections::game_profiles::EVENT\],'
    matches=list(re.finditer(pattern,text))
    if len(matches)!=1:raise RuntimeError('Workspace registry anchor is absent or ambiguous')
    match=matches[0];indent=match.group(1)
    entry='\n'.join(indent+line for line in ['ProjectionRegistration {','    event_types: &[crate::projections::workspace::EVENT, crate::projections::workspace::DELTA_EVENT],','    handler: Arc::new(crate::projections::workspace::WorkspaceProjection),','    index_name: crate::projections::workspace::INDEX,','    record_type_name: "wabidb::projections::workspace::WorkspaceRecord",','},'])+'\n'
    p.write_text(text[:match.start()]+entry+text[match.start():])
p=Path('core/crates/wabi-server/src/api/routes.rs');text=p.read_text()
if 'super::workspace::routes(' not in text:
    # API generations differ in whether wiki::routes takes a state argument.
    pattern=r'(?m)^([ \t]*)\.nest\("/wiki",[^\n]+$'
    matches=list(re.finditer(pattern,text))
    if len(matches)!=1:raise RuntimeError('Wiki router integration anchor is absent or ambiguous')
    m=matches[0];addition='\n'+m.group(1)+'.nest("/workspace", super::workspace::routes(state.clone()))'
    p.write_text(text[:m.end()]+addition+text[m.end():])
p=Path('core/crates/wabi-server/Cargo.toml');text=p.read_text()
if not re.search(r'(?m)^yrs\s*=',text):
    if text.count('[dependencies]')!=1:raise RuntimeError('Missing server dependencies table')
    p.write_text(text.replace('[dependencies]','[dependencies]\nyrs = { version = "=0.27.4", features = ["small-client", "sync"] }',1))
p=Path('core/crates/wabidb/src/projections/workspace.rs');text=p.read_text()
text=text.replace('use crate::error::{Error, Result};\nuse crate::projections::{Projection, ProjectionState};\nuse crate::storage::record::PlainRecord;','use crate::{engine::locks::ProjectionState, error::{Result, WabiError}, projections::handler::{DurableEvent, Projection}};')
text=text.replace('fn invalid() -> Error { Error::InvalidArgument("Invalid workspace record".into()) }','fn invalid() -> WabiError { WabiError::Corrupt { location: INDEX.into(), detail: "Invalid workspace record".into() } }')
text=text.replace('impl Projection for WorkspaceProjection {\n    fn apply(&self, record: &PlainRecord, state: &ProjectionState)','impl Projection for WorkspaceProjection {\n    fn event_type(&self) -> &str { EVENT }\n    fn apply(&self, record: &DurableEvent, state: &ProjectionState)')
text=text.replace('record.plaintext','record.payload').replace('state.insert(INDEX, row.key.as_bytes(), &bytes, record.commit_seq);','state.insert(INDEX, row.key.as_bytes().to_vec(), bytes, record.commit_seq);')
p.write_text(text)
print('Workspace module integration applied without replacing existing APIs.')
