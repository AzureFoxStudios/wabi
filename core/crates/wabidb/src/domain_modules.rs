//! Domain modules: projections and events supplied by a crate outside the
//! engine.
//!
//! A domain module is a named, versioned projection over its own event
//! types. The host passes its modules to
//! [`WabiDbEngine::open_with_modules`](crate::engine::WabiDbEngine::open_with_modules);
//! nothing in the engine names any particular module.
//!
//! What the engine guarantees a module:
//!
//! - **Its own namespace.** Event types are `<id>.<name>`, stream ids start
//!   with `<id>.`, and its indexes are stored as `domain.<id>.<index>`. A
//!   module cannot name a core event type or index.
//! - **Indexes that match the log.** The snapshot records which modules, at
//!   which version, its indexes were built by. A module that is new to the
//!   directory, was absent while its events were written, or changed its
//!   `version` has its indexes dropped and rebuilt from the whole log at
//!   open. Bump `version` whenever `apply` would produce different indexes
//!   from the same events.
//! - **The same durability as core events.** A module's events go through
//!   the single writer and are applied before the write returns.
//!
//! What it does not have yet: SQL tables (indexes are ordered byte maps held
//! in memory and saved in the snapshot), admission checks inside the writer,
//! gap-free number series, and command ids that survive a restart.
//!
//! An engine opened without a module still accepts and keeps that module's
//! events already in the log; it simply does not project them.

use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

/// Prefix of every domain index name in the projection state.
pub(crate) const INDEX_PREFIX: &str = "domain.";

/// The projection of one domain module. Called once per event, in commit
/// order, live and on replay alike; it must depend on nothing but the event
/// and what it reads back through `indexes`.
pub trait DomainProjection: Send + Sync {
    fn apply(&self, event: &DurableEvent, indexes: &DomainIndexes<'_>) -> Result<()>;
}

/// A domain module as registered with the engine.
#[derive(Clone)]
pub struct DomainModule {
    /// Lower-case identifier: a letter, then up to 31 letters, digits or `_`.
    pub id: &'static str,
    /// Version of the projection logic. A change rebuilds this module's
    /// indexes from the log at the next open.
    pub version: u32,
    /// Every event type the module writes, each starting with `<id>.`.
    pub event_types: &'static [&'static str],
    pub projection: Arc<dyn DomainProjection>,
}

impl std::fmt::Debug for DomainModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DomainModule")
            .field("id", &self.id)
            .field("version", &self.version)
            .field("event_types", &self.event_types)
            .finish()
    }
}

fn invalid(reason: String) -> WabiError {
    WabiError::Validation { command: "register_domain_module".into(), reason }
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && id.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.')
}

/// Check a set of modules before anything is opened.
pub(crate) fn validate(modules: &[DomainModule]) -> Result<()> {
    let mut ids = HashSet::new();
    for module in modules {
        if !valid_id(module.id) {
            return Err(invalid(format!(
                "domain id {:?} must be a lower-case letter followed by up to 31 lower-case \
                 letters, digits or underscores",
                module.id
            )));
        }
        if !ids.insert(module.id) {
            return Err(invalid(format!("domain {:?} is registered twice", module.id)));
        }
        if module.event_types.is_empty() {
            return Err(invalid(format!("domain {:?} registers no event types", module.id)));
        }
        for event_type in module.event_types {
            if !owns(module.id, event_type) {
                return Err(invalid(format!(
                    "event type {event_type:?} of domain {:?} must be \"{}.<name>\" in lower-case \
                     letters, digits, underscores and dots",
                    module.id, module.id
                )));
            }
        }
    }
    Ok(())
}

/// Whether `name` (an event type or a stream id) belongs to domain `id`.
fn owns(id: &str, name: &str) -> bool {
    name.strip_prefix(id).and_then(|rest| rest.strip_prefix('.')).is_some_and(valid_name)
}

/// The name under which a domain's index is stored.
fn index_name(id: &str, index: &str) -> String {
    format!("{INDEX_PREFIX}{id}.{index}")
}

/// The prefix of every stored index name of domain `id`.
pub(crate) fn index_prefix_of(id: &str) -> String {
    format!("{INDEX_PREFIX}{id}.")
}

/// A module's view of the projection state: its own indexes and nothing
/// else. Index names are lower-case letters, digits and underscores; an
/// invalid name panics, since it is a constant in the module's code.
pub struct DomainIndexes<'a> {
    state: &'a ProjectionState,
    id: &'a str,
    commit_seq: u64,
}

impl DomainIndexes<'_> {
    fn name(&self, index: &str) -> String {
        assert!(
            !index.is_empty() && index.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "invalid domain index name {index:?}"
        );
        index_name(self.id, index)
    }

    pub fn put(&self, index: &str, key: Vec<u8>, value: Vec<u8>) {
        self.state.insert(&self.name(index), key, value, self.commit_seq);
    }

    /// Returns whether the key was present.
    pub fn delete(&self, index: &str, key: &[u8]) -> bool {
        self.state.remove(&self.name(index), key)
    }

    pub fn get(&self, index: &str, key: &[u8]) -> Option<Vec<u8>> {
        self.state.get(&self.name(index), key)
    }

    /// Every entry whose key starts with `prefix`, in key order.
    pub fn scan_prefix(&self, index: &str, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut out = Vec::new();
        self.state.prefix_scan(&self.name(index), prefix, |k, v| out.push((k.to_vec(), v.to_vec())));
        out
    }
}

/// Read access to one module's indexes from outside the projection, for
/// request handlers. A write made through [`DomainWriter`] is visible here
/// as soon as the write returns.
#[derive(Clone)]
pub struct DomainReader {
    pub(crate) state: Arc<ProjectionState>,
    pub(crate) id: &'static str,
}

impl DomainReader {
    fn view(&self) -> DomainIndexes<'_> {
        DomainIndexes { state: &self.state, id: self.id, commit_seq: 0 }
    }

    pub fn get(&self, index: &str, key: &[u8]) -> Option<Vec<u8>> {
        self.view().get(index, key)
    }

    /// Every entry whose key starts with `prefix`, in key order.
    pub fn scan_prefix(&self, index: &str, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
        self.view().scan_prefix(index, prefix)
    }
}

/// One event a module asks the engine to write.
#[derive(Debug, Clone)]
pub struct DomainEvent {
    /// Must start with `<id>.`. A command may write at most one event per
    /// stream.
    pub stream_id: String,
    /// One of the module's registered event types.
    pub event_type: String,
    /// The event body. The engine encrypts it at rest and does not read it.
    pub payload: Vec<u8>,
}

/// Check that `events` may be written by domain `id`.
pub(crate) fn check_events(id: &str, registered: &[&str], events: &[DomainEvent]) -> Result<()> {
    let refuse = |reason: String| WabiError::Validation { command: format!("{id}.write"), reason };
    if events.is_empty() {
        return Err(refuse("a command must write at least one event".into()));
    }
    let mut streams = HashSet::new();
    for event in events {
        if !registered.contains(&event.event_type.as_str()) {
            return Err(refuse(format!("event type {:?} is not registered by this domain", event.event_type)));
        }
        if !owns(id, &event.stream_id) || !crate::stream_identity::is_safe_stream_id(&event.stream_id) {
            return Err(refuse(format!(
                "stream id {:?} must be \"{id}.<name>\" in lower-case letters, digits, underscores and dots",
                event.stream_id
            )));
        }
        if !streams.insert(event.stream_id.as_str()) {
            return Err(refuse(format!("two events for stream {:?} in one command", event.stream_id)));
        }
    }
    Ok(())
}

/// The engine-side handler wrapping a module's projection.
pub(crate) struct DomainHandler {
    module: DomainModule,
}

impl DomainHandler {
    pub(crate) fn new(module: DomainModule) -> Self {
        Self { module }
    }
}

impl Projection for DomainHandler {
    fn event_type(&self) -> &str {
        self.module.event_types[0]
    }

    fn event_types(&self) -> Vec<&str> {
        self.module.event_types.to_vec()
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let indexes = DomainIndexes { state, id: self.module.id, commit_seq: event.commit_seq };
        self.module.projection.apply(event, &indexes)
    }
}

/// `id → version` of a set of modules, as recorded in the snapshot.
pub(crate) fn versions(modules: &[DomainModule]) -> BTreeMap<String, u32> {
    modules.iter().map(|m| (m.id.to_string(), m.version)).collect()
}
