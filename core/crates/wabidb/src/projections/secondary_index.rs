//! Secondary index framework for projections.
//!
//! A [`SecondaryIndex`] extracts zero or more index keys from a `DurableEvent`
//! and writes them into a dedicated `SkipMap` in the `ProjectionState`. This
//! lets projections answer queries (e.g. "all messages in a channel", "all
//! messages by an author") without a full prefix scan over the primary index.
//!
//! The trait is intentionally small and mirrors the existing `Projection`
//! conventions: sync, no async, one index per implementation. Indexes are
//! maintained as part of the same `apply` path used by both the live
//! dispatcher and `replay_projections`, so a rebuild naturally repopulates
//! them.

use crate::projections::handler::DurableEvent;
use crossbeam_skiplist::SkipMap;

/// A secondary index maintained alongside a projection's primary index.
///
/// Implementations must be `Send + Sync` because they are shared across the
/// projection dispatcher task and (potentially) read paths.
pub trait SecondaryIndex: Send + Sync {
    /// The index name — the `SkipMap` key in `ProjectionState`. Must be
    /// unique across all indexes and distinct from any primary index name.
    fn name(&self) -> &str;

    /// Extract the index keys this event contributes. An empty return value
    /// means the event is not indexed (e.g. an event type the index does not
    /// care about). The extracted keys are written verbatim as keys in the
    /// index `SkipMap`; the value is chosen by [`SecondaryIndex::apply`].
    fn extract_keys(&self, event: &DurableEvent) -> Vec<Vec<u8>>;

    /// Apply the event to the index's `SkipMap`. The default implementation
    /// inserts each extracted key with the event payload as the value;
    /// override to customize the value or to support deletions.
    fn apply(&self, index: &SkipMap<Vec<u8>, Vec<u8>>, event: &DurableEvent) {
        for key in self.extract_keys(event) {
            index.insert(key, event.payload.clone());
        }
    }
}
