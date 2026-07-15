use crate::error::Result;
use crate::projections::handler::{DispatchTable, Projection};
use std::sync::Arc;

/// Registration for a single projection handler.
///
/// Each registration corresponds to one `Projection` implementation.
/// A single handler can serve multiple event types (e.g. MessagesProjection
/// handles message_created, message_edited, message_deleted).
pub struct ProjectionRegistration {
    /// The event types this handler processes (must match `handler.event_types()`).
    pub event_types: &'static [&'static str],
    /// The handler instance.
    pub handler: Arc<dyn Projection>,
    /// The SkipMap index name this handler writes to.
    pub index_name: &'static str,
    /// The Rust type name of the stored record (for diagnostics and Phase 1b).
    pub record_type_name: &'static str,
}

/// Canonical registry of all projection types.
///
/// Replaces the manual `build_dispatch_table()` function with a
/// declarative list. Serves as the single source of truth for:
/// - Which handlers exist and what event types they serve
/// - Which index stores each projection's data
/// - Which record type each projection stores
///
/// Built once at engine startup.
pub struct TypeRegistry {
    entries: Vec<ProjectionRegistration>,
    dispatch_table: Arc<DispatchTable>,
}

impl TypeRegistry {
    /// Build the registry from a list of projection registrations.
    ///
    /// Returns an error if any event_type is registered by multiple handlers.
    pub fn new(entries: Vec<ProjectionRegistration>) -> Result<Self> {
        let handlers: Vec<Arc<dyn Projection>> =
            entries.iter().map(|e| e.handler.clone()).collect();
        let dispatch_table = Arc::new(DispatchTable::new(handlers)?);
        Ok(Self {
            entries,
            dispatch_table,
        })
    }

    pub fn dispatch_table(&self) -> &Arc<DispatchTable> {
        &self.dispatch_table
    }

    pub fn entries(&self) -> &[ProjectionRegistration] {
        &self.entries
    }

    /// Find the registration whose handler handles the given event type.
    pub fn find_by_event_type(&self, event_type: &str) -> Option<&ProjectionRegistration> {
        self.entries.iter().find(|e| e.event_types.contains(&event_type))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
