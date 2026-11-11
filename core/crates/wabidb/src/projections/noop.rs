//! No-op projection handler for event types that keep no read-model state.
//!
//! `build_type_registry` registers `member_joined`, `member_left` and
//! `channel_renamed` to this handler so the dispatch table routes them (test:
//! `projections::handler::tests::dispatch_routes_by_event_type` covers routing
//! in general). `apply` returns `Ok(())` without touching state and without
//! logging. No projection reads these three event types today. No test targets
//! this handler specifically (no test covers it).
//!
//! `reaction_removed` is NOT here: `ReactionsProjection` applies it (tests:
//! `projections::reactions::tests::reaction_removed_deletes_only_its_composite_key`,
//! `engine::message_admission_tests::removed_reaction_stays_removed_after_reopen_and_replay`).

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
