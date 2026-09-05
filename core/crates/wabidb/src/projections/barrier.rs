//! Projection write barrier: linearizability between sequencer writes and reads.
//!
//! Per Council Review #1 §2.3 and the endstate doc §15.4 invariant 4 ("Clients
//! deduplicate by event ID and recover by snapshot/resume"), a read that
//! follows a successful write MUST see the write. Ordinary concurrent reads
//! are not snapshot-isolated and may observe a later commit during application.
//!
//! A read at commit_seq N blocks until the projection dispatcher has applied
//! the whole command at N and every earlier committed command.
//!
//! ## Components
//!
//! - `LinearizabilityBarrier`: a wrapper around the projection state's
//!   `applied_commit_seq` watermark. Exposes `wait_for(seq, timeout)` to
//!   block until the watermark reaches `seq`.
//!
//! ## Design
//!
//! Uses `tokio::sync::watch` for the watermark channel. `watch` is a
//! single-producer multi-consumer channel that broadcasts value changes.
//! The dispatcher (the sole writer) updates the watch on every advance;
//! readers call `wait_for` which subscribes to the watch and resolves when
//! the value reaches their target seq.
//!
//! `watch` is the right tool because:
//! - The dispatcher is the single producer.
//! - Many readers can subscribe without coordination cost.
//! - A reader that subscribes after the watermark has already advanced
//!   immediately sees the new value (no waiting for the next update).
//! - Updates are coalesced (rapid updates don't queue up).

use crate::engine::locks::ProjectionState;
use crate::error::{ErrorCategory, Result, WabiError};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// Default timeout for `wait_for` calls. The endstate doc says the
/// "Backpressure timeout" is 5s (per wabidb-97). Reads that block longer
/// than this are likely waiting on a stuck dispatcher; the caller
/// should re-try or fall back to a snapshot.
pub const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// The linearizability barrier between the commit sequencer and readers.
///
/// The barrier is the read-side companion to the sequencer's
/// durability-await (Council Review #1 §2.3). A read at commit_seq N
/// calls `wait_for(N)` which blocks until the projection dispatcher has
/// applied at least N. Once `wait_for` returns, the read is guaranteed
/// to see all events with `commit_seq <= N`.
///
/// The barrier is constructed from a `ProjectionState` (the source of
/// the watermark) and a watch channel (the notification mechanism).
#[derive(Debug)]
pub struct LinearizabilityBarrier {
    /// The projection state owns both the watermark and its notifications.
    state: Arc<ProjectionState>,
}

impl LinearizabilityBarrier {
    /// Create a new barrier bound to the given projection state.
    pub fn new(state: Arc<ProjectionState>) -> Self {
        Self { state }
    }

    /// The current applied_commit_seq watermark. Cheap; no await.
    pub fn current(&self) -> u64 {
        self.state.applied_commit_seq()
    }

    /// Update the watermark. Called by the projection dispatcher after
    /// each successful apply. Coalesces: rapid calls only the latest
    /// value is observed by readers.
    ///
    /// ProjectionState owns one watch-backed watermark, shared by all barriers.
    /// Live advancement belongs to the dispatcher; replay may advance after
    /// rebuilding the complete committed prefix. Never advance on log fsync.
    pub fn advance(&self, new_watermark: u64) -> Result<()> {
        self.state.set_applied_commit_seq(new_watermark);
        Ok(())
    }

    /// Get a clone of the watch receiver. The caller can `borrow_and_update`
    /// to wait for changes without holding the borrow.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.state.subscribe_applied()
    }

    /// Block until the projection's `applied_commit_seq` is at least `seq`,
    /// or until `timeout` elapses.
    ///
    /// Returns `Ok(())` once the watermark reaches `seq`. Returns
    /// `WabiError::SubscriptionTimeout` if the timeout elapses first
    /// (the dispatcher is stuck or the seq is impossibly large).
    ///
    /// This is the function readers call before showing data they expect
    /// to see post-write. The function is the linearizability primitive.
    pub async fn wait_for(&self, seq: u64, timeout: Duration) -> Result<()> {
        // Fast path: the watermark is already at or beyond seq.
        let current = self.state.applied_commit_seq();
        if current >= seq {
            return Ok(());
        }

        // Slow path: subscribe to the watch and wait for the value to
        // change. watch::Receiver::changed() awaits the next value change;
        // we loop because a changed() call may return a value that's
        // still < seq (e.g., the watermark advanced from N to N+2 in
        // one step, and we needed N+5).
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // current is re-checked each iteration in case the watermark
            // moved between subscribe() and changed().
            if *rx.borrow() >= seq {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(WabiError::SubscriptionTimeout {
                    subscription_id: format!("barrier.wait_for({seq})"),
                });
            }
            // changed() returns Err if the sender is dropped; treat that
            // as a hard error.
            tokio::select! {
                result = rx.changed() => {
                    match result {
                        Ok(()) => continue,
                        Err(e) => return Err(WabiError::InternalInvariantViolated {
                            invariant: format!("barrier watch closed during wait: {e}"),
                        }),
                    }
                }
                _ = tokio::time::sleep(remaining) => {
                    return Err(WabiError::SubscriptionTimeout {
                        subscription_id: format!("barrier.wait_for({seq}) (timed out at watermark {})", *rx.borrow()),
                    });
                }
            }
        }
    }

    /// Subscribe and wait for `seq` with the default timeout.
    pub async fn wait_for_default(&self, seq: u64) -> Result<()> {
        self.wait_for(seq, DEFAULT_WAIT_TIMEOUT).await
    }

    /// A cloneable handle for advancing the watermark. Useful for tests
    /// and for the projection dispatcher (which may run in a different
    /// task than the barrier itself).
    pub fn advance_handle(&self) -> BarrierAdvanceHandle {
        BarrierAdvanceHandle {
            state: Arc::clone(&self.state),
        }
    }
}

/// A cloneable handle to a `LinearizabilityBarrier` that can only advance
/// the watermark. Use this when the dispatcher runs in a separate task
/// from the barrier, or when handing a "can advance but cannot read" handle
/// to test code.
#[derive(Clone)]
pub struct BarrierAdvanceHandle {
    state: Arc<ProjectionState>,
}

impl BarrierAdvanceHandle {
    /// Advance the watermark. Same semantics as `LinearizabilityBarrier::advance`.
    /// Uses the same watch-backed state as every reader and waiter.
    pub fn advance(&self, new_watermark: u64) -> Result<()> {
        self.state.set_applied_commit_seq(new_watermark);
        Ok(())
    }
}

/// The error category for any future barrier-related errors.
///
/// Exists so the `ErrorCategory` enum is reachable from this module
/// without a dead-code warning during transitional stub work.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Subscription
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::locks::DispatchItem;
    use tokio::time::timeout;

    #[tokio::test]
    async fn current_returns_zero_for_new_barrier() {
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(state);
        assert_eq!(barrier.current(), 0);
    }

    #[tokio::test]
    async fn advance_updates_current() {
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(Arc::clone(&state));
        barrier.advance(5).unwrap();
        assert_eq!(barrier.current(), 5);
        // The projection state itself also reflects the advance
        // (advance() updates the state, not just the watch).
        assert_eq!(state.applied_commit_seq(), 5);
    }

    #[tokio::test]
    async fn wait_for_returns_immediately_when_already_at_target() {
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(state);
        barrier.advance(10).unwrap();
        // Already past; should return Ok immediately.
        let result = barrier.wait_for(5, Duration::from_millis(100)).await;
        assert!(result.is_ok(), "got {result:?}");
    }

    #[tokio::test]
    async fn wait_for_resolves_when_advance_happens() {
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(Arc::clone(&state));

        // Spawn an advancer that increments after a short delay.
        let advancer = barrier.advance_handle();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            advancer.advance(7).unwrap();
        });

        // Wait for seq 5; should resolve when the advancer hits 7.
        let result = timeout(
            Duration::from_millis(500),
            barrier.wait_for(5, Duration::from_millis(500)),
        )
        .await;
        let result = result.expect("wait_for did not resolve in time");
        assert!(result.is_ok(), "got {result:?}");
        assert!(barrier.current() >= 5);
    }

    #[tokio::test]
    async fn wait_for_times_out_when_advance_never_happens() {
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(state);
        // Don't advance. wait_for(5, 50ms) should time out.
        let result = barrier.wait_for(5, Duration::from_millis(50)).await;
        assert!(
            matches!(result, Err(WabiError::SubscriptionTimeout { .. })),
            "expected timeout, got {result:?}"
        );
    }

    #[tokio::test]
    async fn wait_for_handles_rapid_advances() {
        // The watermark can advance past `seq` in a single step (e.g.,
        // the dispatcher catches up to seq 10, but a read wants seq 5).
        // wait_for(5) should return immediately.
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(Arc::clone(&state));
        barrier.advance(10).unwrap();
        let result = barrier.wait_for(5, Duration::from_millis(100)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn advance_to_higher_value_unblocks_lower_target() {
        // Verifies the linearizability guarantee: a write at commit_seq 10
        // makes all reads at commit_seq <= 10 see the write.
        let state = Arc::new(ProjectionState::new());
        let barrier = LinearizabilityBarrier::new(Arc::clone(&state));

        let advancer = barrier.advance_handle();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            advancer.advance(10).unwrap();
        });

        // A read at commit_seq 5 should resolve quickly when 10 is the
        // current watermark.
        timeout(
            Duration::from_millis(500),
            barrier.wait_for(5, Duration::from_millis(500)),
        )
        .await
        .expect("wait_for did not resolve")
        .expect("wait_for returned error");
    }

    #[tokio::test]
    async fn multiple_waiters_all_resolve() {
        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(Arc::clone(&state)));

        // Spawn 5 waiters, all looking for seq 5.
        let mut waiters = Vec::new();
        for _ in 0..5 {
            let b = Arc::clone(&barrier);
            waiters.push(tokio::spawn(async move {
                b.wait_for(5, Duration::from_millis(500)).await
            }));
        }

        // Advance the watermark.
        tokio::time::sleep(Duration::from_millis(20)).await;
        barrier.advance(7).unwrap();

        // All 5 waiters should resolve.
        for w in waiters {
            let result = w.await.expect("waiter panicked");
            assert!(result.is_ok(), "got {result:?}");
        }
    }

    // Smoke test that the watch channel is wired correctly: send a
    // dispatch item to a channel and verify the barrier can be advanced
    // from a different task via the dispatcher pattern.
    #[tokio::test]
    async fn barrier_integrates_with_dispatcher_pattern() {
        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(Arc::clone(&state)));
        let table = Arc::new(crate::projections::handler::DispatchTable::new(vec![]).unwrap());
        let handle = crate::engine::locks::spawn_projection_dispatcher(
            Arc::clone(&state),
            table,
            Some(16),
            None,
            None,
        )
        .unwrap();

        for i in 1..=5u64 {
            handle
                .sender
                .send(
                    DispatchItem {
                        commit_seq: i,
                        event_type: "test".into(),
                        stream_id: format!("stream_{i}").into(),
                        payload: vec![],
                    }
                    .into(),
                )
                .await
                .unwrap();
        }
        barrier.wait_for_default(5).await.unwrap();
        drop(handle.sender);

        // Wait for the dispatcher to catch up.
        let _ = tokio::time::timeout(Duration::from_secs(1), handle.handle.unwrap()).await;

        // The watermark should be at 5.
        assert_eq!(barrier.current(), 5);
    }
}
