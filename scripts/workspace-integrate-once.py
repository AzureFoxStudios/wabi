"""Temporary, idempotent branch-integration helper. Remove after the implementation lands."""
from pathlib import Path

def replace(path, before, after):
    p=Path(path); text=p.read_text()
    if after in text: return
    if text.count(before)!=1: raise RuntimeError(f'Expected exactly one integration anchor: {path}: {before[:80]}')
    p.write_text(text.replace(before,after,1))

def append(path, line):
    p=Path(path); text=p.read_text()
    if line not in text: p.write_text(text+'\n'+line+'\n')

append('core/crates/wabidb/src/projections/mod.rs','pub mod workspace;')
append('core/crates/wabi-server/src/adapter/mod.rs','pub(crate) mod workspace;')
append('core/crates/wabi-server/src/api/mod.rs','pub mod workspace;\nmod workspace_crdt;\nmod workspace_present;')
replace('core/crates/wabidb/src/engine/mod.rs',
'''        ProjectionRegistration {
            event_types: &[crate::projections::game_profiles::EVENT],''',
'''        ProjectionRegistration {
            event_types: &[crate::projections::workspace::EVENT, crate::projections::workspace::DELTA_EVENT],
            handler: Arc::new(crate::projections::workspace::WorkspaceProjection),
            index_name: crate::projections::workspace::INDEX,
            record_type_name: "wabidb::projections::workspace::WorkspaceRecord",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::game_profiles::EVENT],''')
replace('core/crates/wabi-server/src/api/routes.rs',
'.nest("/wiki", wiki::routes(state.clone()))',
'.nest("/wiki", wiki::routes(state.clone()))\n        .nest("/workspace", super::workspace::routes(state.clone()))')
replace('core/crates/wabi-server/Cargo.toml','[dependencies]',
'[dependencies]\nyrs = { version = "=0.27.4", features = ["small-client", "sync"] }')
# Adapt the versioned record implementation to the existing WabiDB projection API.
p=Path('core/crates/wabidb/src/projections/workspace.rs'); text=p.read_text()
text=text.replace('use crate::error::{Error, Result};\nuse crate::projections::{Projection, ProjectionState};\nuse crate::storage::record::PlainRecord;',
'use crate::{engine::locks::ProjectionState, error::{Result, WabiError}, projections::handler::{DurableEvent, Projection}};')
text=text.replace('fn invalid() -> Error { Error::InvalidArgument("Invalid workspace record".into()) }',
'fn invalid() -> WabiError { WabiError::Corrupt { location: INDEX.into(), detail: "Invalid workspace record".into() } }')
text=text.replace('impl Projection for WorkspaceProjection {\n    fn apply(&self, record: &PlainRecord, state: &ProjectionState)',
'impl Projection for WorkspaceProjection {\n    fn event_type(&self) -> &str { EVENT }\n    fn apply(&self, record: &DurableEvent, state: &ProjectionState)')
text=text.replace('record.plaintext','record.payload').replace('state.insert(INDEX, row.key.as_bytes(), &bytes, record.commit_seq);','state.insert(INDEX, row.key.as_bytes().to_vec(), bytes, record.commit_seq);')
p.write_text(text)
print('Workspace backend integrations applied; existing public APIs untouched.')
