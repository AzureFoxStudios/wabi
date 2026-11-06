//! No-op projection handler for event types that have no persisted state.
//!
//! These handlers exist so the dispatch table can route the event during
//! replay without failing. Each handler simply logs the event and returns
//! `Ok(())`. The events are still discoverable via the generic "events"
//! index for subscription delivery and audit purposes.
//!
//! The event types below have no projection state because their
//! effects are purely ephemeral (presence, renames).
//! They are kept for wire-format compatibility with WDB-era events.
//! (`reaction_removed` is NOT here: `ReactionsProjection` applies it.)

use crate::error::Result;
use crate::projections::handler::{DurableEvent, Projection};

pub struct NoopProjection;

impl Projection for NoopProjection {
    fn event_type(&self) -> &str {
        "member_joined"
    }

    fn event_types(&self) -> Vec<&str> {
        vec![
            "member_joined",
            "member_left",
            "channel_renamed",
        ]
    }

    fn apply(
        &self,
        _event: &DurableEvent,
        _state: &crate::engine::locks::ProjectionState,
    ) -> Result<()> {
        Ok(())
    }
}
