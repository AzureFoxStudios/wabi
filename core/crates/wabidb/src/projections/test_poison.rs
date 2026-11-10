//! Test-only projection whose handler fails or panics on a chosen payload
//! (Task 3.2). Compiled only under `cfg(test)`; never registered in a build
//! that ships.

use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};

pub(crate) const EVENT_TYPE: &str = "test_poison";
pub(crate) const INDEX: &str = "test_poison";
/// The handler returns an error for this payload.
pub(crate) const FAIL: &[u8] = b"fail";
/// The handler panics on this payload.
pub(crate) const PANIC: &[u8] = b"panic";

/// Stores every other payload in [`INDEX`], keyed by its commit_seq.
pub(crate) struct PoisonProjection;

impl Projection for PoisonProjection {
    fn event_type(&self) -> &str {
        EVENT_TYPE
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.payload == FAIL {
            return Err(WabiError::Validation {
                command: EVENT_TYPE.into(),
                reason: "test handler rejects this payload".into(),
            });
        }
        if event.payload == PANIC {
            panic!("test handler panics on this payload");
        }
        state.insert(
            INDEX,
            event.commit_seq.to_be_bytes().to_vec(),
            event.payload.clone(),
            event.commit_seq,
        );
        Ok(())
    }
}
