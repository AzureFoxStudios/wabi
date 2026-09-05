use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{mpsc, Mutex};

use crate::commands::idempotency::{CommandIdempotencyRecord, CommandIdempotencyTable};
use crate::error::{Result, WabiError};
use crate::sequencer::types::{CommandCommit, CommandOutcome};

/// Handle to the commit sequencer for submitting commands.
///
/// Wraps the mpsc sender to the sequencer task and the idempotency table.
/// Callers use [`run_command`] to submit a command and await its durable
/// and applied outcome.
#[derive(Debug)]
pub struct CommitSequencer {
    cmd_tx: mpsc::Sender<CommandCommit>,
    idempotency_table: Mutex<CommandIdempotencyTable>,
}

impl CommitSequencer {
    /// Create a new handle from the sequencer's mpsc sender.
    pub fn new(cmd_tx: mpsc::Sender<CommandCommit>) -> Self {
        Self {
            cmd_tx,
            idempotency_table: Mutex::new(CommandIdempotencyTable::new()),
        }
    }

    /// The mpsc sender to the sequencer task.
    pub fn sender(&self) -> &mpsc::Sender<CommandCommit> {
        &self.cmd_tx
    }

    /// The idempotency table (for introspection / debugging).
    pub fn idempotency_table(&self) -> &Mutex<CommandIdempotencyTable> {
        &self.idempotency_table
    }
}

/// Submit a command and await both durability and projection application.
///
/// This is the public entry point for all write operations. It:
///
/// 1. Checks the idempotency table: if a record with the same
///    `(caller_user_id, idempotency_key)` exists and has not expired,
///    returns [`WabiError::IdempotentReplay`] with the original `commit_seq`.
///
/// 2. Sends the command through the mpsc channel to the sequencer task.
///
/// 3. Awaits the oneshot response (the sequencer sends back the
///    [`CommandOutcome`] once the commit is durable and fully applied).
///
/// # Errors
///
/// - [`WabiError::IdempotentReplay`] if the command was already processed.
/// - [`WabiError::InternalInvariantViolated`] if the sequencer channel is closed.
/// - Any error the sequencer returns (engine busy, validation, auth, etc.).
pub async fn run_command(
    command: CommandCommit,
    sequencer: &CommitSequencer,
) -> Result<CommandOutcome> {
    let caller_user_id = command.caller_user_id;
    let idempotency_key = command.idempotency_key.clone();
    let command_name = command.command_name.clone();

    // 1. Idempotency check: if a record exists and hasn't expired, it's a replay.
    if let Some(ref key) = idempotency_key {
        let table = sequencer.idempotency_table.lock().await;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if let Some(existing) = table.lookup(caller_user_id, key) {
            if existing.expires_at >= now {
                return Err(WabiError::IdempotentReplay {
                    commit_seq: existing.commit_seq(),
                });
            }
        }
    }

    // 2. Create a fresh oneshot channel for the response.
    let (tx, rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        response_tx: tx,
        ..command
    };

    // 3. Send to the sequencer task.
    if cmd.essential {
        sequencer
            .cmd_tx
            .send(cmd)
            .await
            .map_err(|_| WabiError::InternalInvariantViolated {
                invariant: "sequencer command channel closed".into(),
            })?;
    } else {
        sequencer.cmd_tx.try_send(cmd).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => WabiError::EngineBusy {
                retry_after_ms: 100,
            },
            mpsc::error::TrySendError::Closed(_) => WabiError::InternalInvariantViolated {
                invariant: "sequencer command channel closed".into(),
            },
        })?;
    }

    // 4. Await the sequencer's response.
    let outcome = rx.await.map_err(|_| WabiError::InternalInvariantViolated {
        invariant:
            "sequencer stopped before acknowledgment; command may be durable, do not blindly retry"
                .into(),
    })?;

    // 5. On success, record the idempotency entry.
    if let Ok(ref outcome) = outcome {
        if let Some(ref key) = idempotency_key {
            let mut table = sequencer.idempotency_table.lock().await;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let record = CommandIdempotencyRecord {
                caller_user_id,
                client_request_id: key.clone(),
                command_name,
                result_blob: outcome.commit_seq.to_le_bytes().to_vec(),
                created_at: now,
                expires_at: now + 86400,
            };
            table.insert(record);
        }
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_cmd(
        user_id: u64,
        key: Option<&str>,
    ) -> (
        CommandCommit,
        tokio::sync::oneshot::Receiver<Result<CommandOutcome>>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let cmd = CommandCommit {
            caller_user_id: user_id,
            caller_device_id: "dev_test".into(),
            command_name: "test_cmd".into(),
            idempotency_key: key.map(|s| s.to_string()),
            events: vec![],
            essential: true,
            response_tx: tx,
        };
        (cmd, rx)
    }

    #[tokio::test]
    async fn happy_path() {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<CommandCommit>(16);
        let sequencer = CommitSequencer::new(cmd_tx);

        // Spawn a trivial sequencer mock that just responds.
        let handle = tokio::spawn(async move {
            if let Some(cmd) = cmd_rx.recv().await {
                let outcome = CommandOutcome {
                    commit_seq: 42,
                    timestamp_micros: 1_000_000,
                };
                let _ = cmd.response_tx.send(Ok(outcome));
            }
        });

        let (cmd, _rx) = dummy_cmd(1, None);
        let result = run_command(cmd, &sequencer).await;
        assert!(result.is_ok(), "expected Ok, got {result:?}");
        assert_eq!(result.unwrap().commit_seq, 42);

        handle.await.unwrap();
    }

    #[tokio::test]
    async fn optional_work_is_rejected_at_admission_before_it_can_be_written() {
        let (tx, mut rx) = mpsc::channel(1);
        let sequencer = CommitSequencer::new(tx);
        let (filler, _) = dummy_cmd(1, None);
        sequencer.sender().try_send(filler).unwrap();
        let (mut command, _) = dummy_cmd(2, None);
        command.essential = false;
        assert!(matches!(
            run_command(command, &sequencer).await,
            Err(WabiError::EngineBusy { .. })
        ));
        assert_eq!(rx.recv().await.unwrap().caller_user_id, 1);
        assert!(matches!(
            rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn idempotent_replay_detected() {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<CommandCommit>(16);
        let sequencer = CommitSequencer::new(cmd_tx);

        // Spawn a sequencer mock that responds with Ok(seq=1) for the first cmd then drops.
        let handle = tokio::spawn(async move {
            if let Some(cmd) = cmd_rx.recv().await {
                let outcome = CommandOutcome {
                    commit_seq: 1,
                    timestamp_micros: 1_000_000,
                };
                let _ = cmd.response_tx.send(Ok(outcome));
            }
        });

        // First call succeeds and records idempotency.
        let (cmd1, _rx1) = dummy_cmd(1, Some("req-1"));
        let r1 = run_command(cmd1, &sequencer).await;
        assert!(r1.is_ok(), "expected Ok, got {r1:?}");

        // Second call with same key detects replay.
        let (cmd2, _rx2) = dummy_cmd(1, Some("req-1"));
        let r2 = run_command(cmd2, &sequencer).await;
        match r2 {
            Err(WabiError::IdempotentReplay { commit_seq }) => {
                assert_eq!(commit_seq, 1, "expected original commit_seq");
            }
            _ => panic!("expected IdempotentReplay, got {r2:?}"),
        }

        handle.await.unwrap();
    }

    #[tokio::test]
    async fn sequencer_busy_closed_channel() {
        // Channel with capacity 0 — send fails immediately if no receiver.
        let (cmd_tx, _cmd_rx) = mpsc::channel::<CommandCommit>(1);
        // Drop receiver so sends fail.
        drop(_cmd_rx);
        let sequencer = CommitSequencer::new(cmd_tx);

        let (cmd, _rx) = dummy_cmd(1, None);
        let result = run_command(cmd, &sequencer).await;
        assert!(
            matches!(result, Err(WabiError::InternalInvariantViolated { .. })),
            "expected channel closed error, got {result:?}"
        );
    }
}
