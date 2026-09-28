//! Runtime operation admission for coordinated checkpoints. This gate is a
//! temporary local pause, never a durable writer fence or promotion verdict.
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock},
    task::JoinHandle,
};

#[derive(Clone, Default)]
pub struct InstanceOperations {
    gate: Arc<RwLock<()>>,
    waiting: Arc<AtomicUsize>,
    interrupted: Arc<AtomicBool>,
}
struct Lease {
    gate: Arc<RwLock<()>>,
    _reader: OwnedRwLockReadGuard<()>,
}
struct Waiting<'a>(&'a AtomicUsize);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Completion {
    // Keep admission until after the interruption flag is published on drop.
    // A waiting pause must not acquire the writer before seeing this flag.
    _lease: Arc<Lease>,
    interrupted: Arc<AtomicBool>,
    completed: bool,
}
impl Drop for Completion {
    fn drop(&mut self) {
        if !self.completed {
            self.interrupted.store(true, Ordering::Release);
        }
    }
}
tokio::task_local! { static OPERATION: Arc<Lease>; }

#[derive(Debug)]
pub struct Quiescent {
    _writer: OwnedRwLockWriteGuard<()>,
}
#[derive(Debug, thiserror::Error)]
pub enum PauseError {
    #[error("cannot pause an instance from inside its admitted operation")]
    FromOperation,
    #[error(
        "an admitted operation was interrupted; checkpoint safety requires restart and recovery"
    )]
    InterruptedOperation,
}

impl InstanceOperations {
    fn inherited(&self) -> Option<Arc<Lease>> {
        OPERATION
            .try_with(Arc::clone)
            .ok()
            .filter(|lease| Arc::ptr_eq(&lease.gate, &self.gate))
    }
    async fn lease(&self) -> Arc<Lease> {
        if let Some(lease) = self.inherited() {
            return lease;
        }
        self.waiting.fetch_add(1, Ordering::AcqRel);
        let _waiting = Waiting(&self.waiting);
        Arc::new(Lease {
            gate: Arc::clone(&self.gate),
            _reader: Arc::clone(&self.gate).read_owned().await,
        })
    }
    /// Local entry backlog, not a completeness or promotion certificate.
    pub fn waiting_operations(&self) -> usize {
        self.waiting.load(Ordering::Acquire)
    }
    /// A local interruption veto, not proof that every writer participates.
    /// It cannot be reset while this instance is running.
    pub fn healthy_for_checkpoint(&self) -> bool {
        !self.interrupted.load(Ordering::Acquire)
    }
    async fn complete<F: Future>(&self, lease: Arc<Lease>, future: F) -> F::Output {
        let mut completion = Completion {
            _lease: Arc::clone(&lease),
            interrupted: Arc::clone(&self.interrupted),
            completed: false,
        };
        let result = OPERATION.scope(lease, future).await;
        completion.completed = true;
        result
    }
    /// Nested work shares its instance's admitted lease. It must not queue a
    /// second reader behind a waiting checkpoint writer while holding the first.
    pub async fn run<F: Future>(&self, future: F) -> F::Output {
        self.complete(self.lease().await, future).await
    }
    /// Capture the current lease before spawning. An owned publication worker
    /// can outlive a cancelled caller without leaving the checkpoint drain.
    pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let inherited = self.inherited();
        let operations = self.clone();
        tokio::spawn(async move {
            let lease = match inherited {
                Some(lease) => lease,
                None => operations.lease().await,
            };
            operations.complete(lease, future).await
        })
    }
    /// Drain participating operations and hold new ones until the guard drops.
    /// Cancellation removes a queued pause; dropping the guard resumes admission.
    /// This alone says nothing about unregistered writers or copied state.
    pub async fn quiesce(&self) -> Result<Quiescent, PauseError> {
        if self.inherited().is_some() {
            return Err(PauseError::FromOperation);
        }
        let paused = Quiescent {
            _writer: Arc::clone(&self.gate).write_owned().await,
        };
        if !self.healthy_for_checkpoint() {
            return Err(PauseError::InterruptedOperation);
        }
        Ok(paused)
    }
}

/// Own an admitted callback to completion even if its dispatcher disappears.
/// Otherwise a cancelled handler could drop admission while its submitted
/// sequencer command continues committing without a checkpoint participant.
pub async fn scoped<F>(operations: InstanceOperations, future: F) -> F::Output
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    operations
        .spawn(future)
        .await
        .expect("admitted callback failed")
}

pub async fn middleware(
    axum::extract::State(state): axum::extract::State<Arc<crate::state::AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    match state.instance_operations.spawn(next.run(request)).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "admitted HTTP handler failed");
            axum::response::IntoResponse::into_response((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Request could not complete",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot};

    async fn waiting_pause(operations: &InstanceOperations) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while operations.gate.try_read().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn pause_drains_admitted_work_and_holds_new_work_until_release() {
        let operations = InstanceOperations::default();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let task = operations.spawn(async move {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
        });
        entered_rx.await.unwrap();
        let pause_gate = operations.clone();
        let pause = tokio::spawn(async move { pause_gate.quiesce().await.unwrap() });
        waiting_pause(&operations).await;
        assert!(!pause.is_finished());
        release_tx.send(()).unwrap();
        task.await.unwrap();
        let paused = pause.await.unwrap();
        let (next_tx, mut next_rx) = oneshot::channel();
        let next = operations.spawn(async move {
            next_tx.send(()).unwrap();
        });
        tokio::task::yield_now().await;
        assert!(matches!(
            next_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        drop(paused);
        next_rx.await.unwrap();
        next.await.unwrap();
    }

    #[tokio::test]
    async fn nested_operations_finish_even_with_a_checkpoint_waiting() {
        let operations = InstanceOperations::default();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (nested_tx, nested_rx) = oneshot::channel();
        let nested_gate = operations.clone();
        let active = operations.spawn(async move {
            entered_tx.send(()).unwrap();
            nested_rx.await.unwrap();
            nested_gate.run(async {}).await;
        });
        entered_rx.await.unwrap();
        let pause_gate = operations.clone();
        let pause = tokio::spawn(async move { pause_gate.quiesce().await.unwrap() });
        waiting_pause(&operations).await;
        nested_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), active)
            .await
            .unwrap()
            .unwrap();
        drop(pause.await.unwrap());
    }

    #[tokio::test]
    async fn detached_worker_retains_the_admission_after_its_caller_is_cancelled() {
        let operations = InstanceOperations::default();
        let (worker_tx, mut worker_rx) = mpsc::channel(1);
        let (release_tx, release_rx) = oneshot::channel();
        let spawn_gate = operations.clone();
        let caller = operations.spawn(async move {
            let worker = spawn_gate.spawn(async move {
                release_rx.await.unwrap();
            });
            worker_tx.send(worker).await.unwrap();
            std::future::pending::<()>().await;
        });
        let worker = worker_rx.recv().await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        let pause_gate = operations.clone();
        let pause = tokio::spawn(async move { pause_gate.quiesce().await });
        waiting_pause(&operations).await;
        assert!(!pause.is_finished());
        release_tx.send(()).unwrap();
        worker.await.unwrap();
        assert!(matches!(
            pause.await.unwrap(),
            Err(PauseError::InterruptedOperation)
        ));
        assert!(!operations.healthy_for_checkpoint());
    }

    #[tokio::test]
    async fn cancelling_a_queued_pause_restores_admission() {
        let operations = InstanceOperations::default();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let active = operations.spawn(async move {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
        });
        entered_rx.await.unwrap();
        let pause_gate = operations.clone();
        let pause = tokio::spawn(async move { pause_gate.quiesce().await.unwrap() });
        waiting_pause(&operations).await;
        pause.abort();
        assert!(pause.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), operations.run(async {}))
            .await
            .unwrap();
        release_tx.send(()).unwrap();
        active.await.unwrap();
    }

    #[tokio::test]
    async fn pause_inside_an_operation_refuses_instead_of_deadlocking() {
        let operations = InstanceOperations::default();
        operations
            .run(async {
                assert!(operations.quiesce().await.is_err());
            })
            .await;
    }

    #[tokio::test]
    async fn another_instance_does_not_inherit_this_instances_lease() {
        let first = InstanceOperations::default();
        let second = InstanceOperations::default();
        let paused = second.quiesce().await.unwrap();
        first
            .run(async {
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), second.run(async {}))
                        .await
                        .is_err()
                );
                assert!(second.inherited().is_none());
            })
            .await;
        drop(paused);
        second.run(async {}).await;
    }

    #[tokio::test]
    async fn cancelling_queued_work_removes_it_from_the_backlog() {
        let operations = InstanceOperations::default();
        let paused = operations.quiesce().await.unwrap();
        let queued = operations.spawn(async {
            panic!("cancelled work must never run");
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while operations.waiting_operations() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        queued.abort();
        assert!(queued.await.unwrap_err().is_cancelled());
        assert_eq!(operations.waiting_operations(), 0);
        drop(paused);
        operations.run(async {}).await;
    }

    #[tokio::test]
    async fn a_panicking_admitted_worker_vetoes_later_checkpoints() {
        let operations = InstanceOperations::default();
        let failed = operations.spawn(async { panic!("fixture operation panic") });
        assert!(failed.await.unwrap_err().is_panic());
        assert!(!operations.healthy_for_checkpoint());
        assert!(matches!(
            operations.quiesce().await,
            Err(PauseError::InterruptedOperation)
        ));
        // Ordinary admission remains available; checkpoint certification is
        // vetoed until a new process reconstructs and validates the state.
        operations.run(async {}).await;
        assert!(!operations.healthy_for_checkpoint());
        assert!(InstanceOperations::default().healthy_for_checkpoint());
    }

    #[tokio::test]
    async fn cancelling_borrowed_work_vetoes_a_waiting_pause_before_releasing_admission() {
        let operations = InstanceOperations::default();
        let borrowed = operations.clone();
        let (entered_tx, entered_rx) = oneshot::channel();
        let active = tokio::spawn(async move {
            borrowed
                .run(async {
                    entered_tx.send(()).unwrap();
                    std::future::pending::<()>().await;
                })
                .await;
        });
        entered_rx.await.unwrap();
        let pause_gate = operations.clone();
        let pause = tokio::spawn(async move { pause_gate.quiesce().await });
        waiting_pause(&operations).await;
        active.abort();
        assert!(active.await.unwrap_err().is_cancelled());
        assert!(matches!(
            pause.await.unwrap(),
            Err(PauseError::InterruptedOperation)
        ));
    }

    #[tokio::test]
    async fn an_ordinary_error_result_does_not_mark_work_as_interrupted() {
        let operations = InstanceOperations::default();
        assert_eq!(
            operations
                .run(async { Err::<(), _>("validation refused") })
                .await,
            Err("validation refused")
        );
        assert!(operations.healthy_for_checkpoint());
        drop(operations.quiesce().await.unwrap());
    }

    #[tokio::test]
    async fn a_cancelled_callback_dispatcher_does_not_release_its_running_work() {
        let operations = InstanceOperations::default();
        let callback_gate = operations.clone();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let (finished_tx, finished_rx) = oneshot::channel();
        let dispatcher = tokio::spawn(scoped(callback_gate, async move {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            finished_tx.send(()).unwrap();
        }));
        entered_rx.await.unwrap();
        dispatcher.abort();
        assert!(dispatcher.await.unwrap_err().is_cancelled());
        let pause_gate = operations.clone();
        let pause = tokio::spawn(async move { pause_gate.quiesce().await.unwrap() });
        waiting_pause(&operations).await;
        assert!(!pause.is_finished());
        release_tx.send(()).unwrap();
        finished_rx.await.unwrap();
        drop(
            tokio::time::timeout(Duration::from_secs(2), pause)
                .await
                .unwrap()
                .unwrap(),
        );
    }
}
