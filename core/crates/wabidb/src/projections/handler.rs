//! Projection handler trait and dispatch table.
//!
//! Per the kanban card body (wabidb-23):
//! - A `Projection` trait: handles a `DurableEvent`, mutates projection state.
//! - One impl per event_type.
//! - Dispatch table at startup.
//!
//! ## Architecture
//!
//! The projection engine consumes `DispatchItem`s from the
//! `ProjectionDispatcher` (engine::locks). For each `DispatchItem`, the
//! engine looks up the handler in a `DispatchTable` keyed by `event_type`,
//! and invokes it with the event payload. The handler mutates the
//! `ProjectionState` (which holds the per-index `SkipMap`s).
//!
//! Handlers are sync (no async). The dispatcher awaits on the mpsc receive,
//! then runs the handler synchronously, then sends the next watermark
//! update. This is per the lock-ordering rule "no holding projection locks
//! across .await points" in engine::locks.
//!
//! ## What this card does NOT do
//!
//! - The specific event handlers (messages, reactions, dm_messages, etc.)
//!   are added in later cards (wabidb-24 through wabidb-29).
//! - The full event payload format (DurableEvent schema) is defined by
//!   the sequencer (wabidb-15 / wabidb-16).
//! - Idempotency, retries, or DLQ behavior on handler failure is the
//!   dispatcher's concern, not the trait's.

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use std::collections::HashMap;
use std::sync::Arc;

/// A `DurableEvent` is a single event that the sequencer has committed
/// to the commit log and the dispatcher has pulled from the dispatch
/// channel. The `Projection` trait consumes these.
///
/// The payload is the post-encryption wire format. Handlers are expected
/// to decrypt it using the `StreamKeyRegistry` before applying. (Decryption
/// may happen here, or in a preceding handler stage — for v1, handlers
/// decrypt inline.)
pub struct DurableEvent {
    /// The `commit_seq` of this event.
    pub commit_seq: u64,
    /// The stream id (e.g. `"ch_01H..."`).
    pub stream_id: String,
    /// The event type (e.g. `"message_created"`, `"channel_member_added"`).
    /// Used as the dispatch key.
    pub event_type: String,
    /// The encrypted payload. Handlers decrypt this with the stream's key.
    pub payload: Vec<u8>,
}

/// A projection handler applies a `DurableEvent` to the projection state.
///
/// Handlers are sync because the projection state is in-memory; an async
/// handler would need a separate task per event, which defeats the
/// batching the dispatcher does. If a handler truly needs async work
/// (e.g., to fetch something from a remote service), it should spawn a
/// task and return immediately — the projection state update happens
/// synchronously, the async work is fire-and-forget.
pub trait Projection: Send + Sync {
    /// The event type this handler matches. Used by the `DispatchTable`
    /// to route events to handlers. Must be unique across all handlers
    /// in a given engine.
    fn event_type(&self) -> &str;

    /// All event types this handler matches. Defaults to `[event_type()]`.
    /// Override to handle multiple related events from the same domain.
    fn event_types(&self) -> Vec<&str> {
        vec![self.event_type()]
    }

    /// Apply the event to the projection state. Called by the dispatcher
    /// after the event is durable.
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()>;
}

/// A dispatch table that routes events to their handlers.
///
/// The table is built at startup from a list of handlers (typically one
/// per event type). At runtime, the dispatcher looks up the handler by
/// `event_type` and invokes it.
pub struct DispatchTable {
    handlers: HashMap<String, Arc<dyn Projection>>,
}

impl std::fmt::Debug for DispatchTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchTable")
            .field("handlers", &self.event_types())
            .finish()
    }
}

impl DispatchTable {
    /// Build a dispatch table from a list of handlers. The constructor
    /// enforces that all event_types are unique across all handlers — a duplicate
    /// is a configuration error and is caught at startup, not at runtime.
    pub fn new(handlers: Vec<Arc<dyn Projection>>) -> Result<Self> {
        let mut map = HashMap::new();
        for h in handlers {
            for key in h.event_types() {
                let key = key.to_string();
                if map.insert(key.clone(), h.clone()).is_some() {
                    return Err(crate::error::WabiError::InternalInvariantViolated {
                        invariant: format!("duplicate projection handler for {key}"),
                    });
                }
            }
        }
        Ok(Self { handlers: map })
    }

    /// Look up the handler for a given event type. Returns `None` if no
    /// handler is registered. The dispatcher can choose to ignore unknown
    /// events (forward-compatible) or fail; the convention here is to
    /// return `None` and let the caller decide.
    pub fn get(&self, event_type: &str) -> Option<&Arc<dyn Projection>> {
        self.handlers.get(event_type)
    }

    /// Number of registered handlers.
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    /// Whether the table has no registered handlers.
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }

    /// All registered event types. Useful for diagnostics.
    pub fn event_types(&self) -> Vec<String> {
        let mut v: Vec<String> = self.handlers.keys().cloned().collect();
        v.sort();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::locks::DispatchItem;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A test handler that records every event it sees.
    struct Recorder {
        event_type: String,
        seen: Arc<AtomicU64>,
    }

    impl Projection for Recorder {
        fn event_type(&self) -> &str {
            &self.event_type
        }
        fn apply(&self, event: &DurableEvent, _state: &ProjectionState) -> Result<()> {
            assert_eq!(event.event_type, self.event_type);
            self.seen.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// A handler that always errors.
    struct Erroring;

    impl Projection for Erroring {
        fn event_type(&self) -> &str { "bad" }
        fn apply(&self, _event: &DurableEvent, _state: &ProjectionState) -> Result<()> {
            Err(crate::error::WabiError::Validation {
                command: "test".into(),
                reason: "intentional".into(),
            })
        }
    }

    fn make_event(event_type: &str, commit_seq: u64) -> DurableEvent {
        DurableEvent {
            commit_seq,
            stream_id: "ch_01H".into(),
            event_type: event_type.into(),
            payload: vec![],
        }
    }

    #[test]
    fn dispatch_routes_by_event_type() {
        let state = ProjectionState::new();
        let seen_a = Arc::new(AtomicU64::new(0));
        let seen_b = Arc::new(AtomicU64::new(0));
        let a: Arc<dyn Projection> = Arc::new(Recorder {
            event_type: "a".into(),
            seen: Arc::clone(&seen_a),
        });
        let b: Arc<dyn Projection> = Arc::new(Recorder {
            event_type: "b".into(),
            seen: Arc::clone(&seen_b),
        });
        let table = DispatchTable::new(vec![Arc::clone(&a), Arc::clone(&b)]).unwrap();

        // Dispatch an "a" event.
        let h = table.get("a").unwrap();
        h.apply(&make_event("a", 1), &state).unwrap();
        // Dispatch a "b" event.
        let h = table.get("b").unwrap();
        h.apply(&make_event("b", 2), &state).unwrap();

        assert_eq!(seen_a.load(Ordering::SeqCst), 1);
        assert_eq!(seen_b.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dispatch_returns_none_for_unknown() {
        let table = DispatchTable::new(vec![]).unwrap();
        assert!(table.get("nothing").is_none());
    }

    #[test]
    fn duplicate_event_type_rejected_at_construction() {
        let a: Arc<dyn Projection> = Arc::new(Recorder {
            event_type: "dup".into(),
            seen: Arc::new(AtomicU64::new(0)),
        });
        let b: Arc<dyn Projection> = Arc::new(Recorder {
            event_type: "dup".into(),
            seen: Arc::new(AtomicU64::new(0)),
        });
        let err = DispatchTable::new(vec![a, b]).unwrap_err();
        assert!(
            matches!(err, crate::error::WabiError::InternalInvariantViolated { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn empty_table_reports_zero() {
        let table = DispatchTable::new(vec![]).unwrap();
        assert!(table.is_empty());
        assert_eq!(table.len(), 0);
        assert!(table.event_types().is_empty());
    }

    #[test]
    fn event_types_returns_sorted() {
        let table = DispatchTable::new(vec![
            Arc::new(Recorder { event_type: "c".into(), seen: Arc::new(AtomicU64::new(0)) }),
            Arc::new(Recorder { event_type: "a".into(), seen: Arc::new(AtomicU64::new(0)) }),
            Arc::new(Recorder { event_type: "b".into(), seen: Arc::new(AtomicU64::new(0)) }),
        ]).unwrap();
        assert_eq!(table.event_types(), vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn erroring_handler_propagates_error() {
        let state = ProjectionState::new();
        let table = DispatchTable::new(vec![Arc::new(Erroring)]).unwrap();
        let h = table.get("bad").unwrap();
        let result = h.apply(&make_event("bad", 1), &state);
        assert!(result.is_err());
    }

    // Integration smoke test: a DispatchTable can be used with the
    // ProjectionDispatcher's DispatchItem flow. The dispatcher would
    // call `table.get(item.event_type)` and then `handler.apply(&event, &state)`.
    #[test]
    fn integrates_with_dispatch_item_event_type() {
        let state = ProjectionState::new();
        let seen = Arc::new(AtomicU64::new(0));
        let h: Arc<dyn Projection> = Arc::new(Recorder {
            event_type: "msg".into(),
            seen: Arc::clone(&seen),
        });
        let table = DispatchTable::new(vec![h]).unwrap();

        // Simulate what ProjectionDispatcher::run_dispatcher does.
        let item = DispatchItem {
            commit_seq: 1,
            event_type: "msg".into(),
            stream_id: "test_stream".into(),
            payload: vec![],
        };
        let event = DurableEvent {
            commit_seq: item.commit_seq,
            stream_id: "x".into(),
            event_type: item.event_type.clone(),
            payload: item.payload.clone(),
        };
        if let Some(handler) = table.get(&item.event_type) {
            handler.apply(&event, &state).unwrap();
        }
        assert_eq!(seen.load(Ordering::SeqCst), 1);
    }
}
