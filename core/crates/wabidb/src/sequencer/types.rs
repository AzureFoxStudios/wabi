//! Types for the commit sequencer (wabidb-15).
//!
//! Defines the input (`CommandCommit`), output (`CommandOutcome`), and the
//! per-event write descriptor (`EventToWrite`) that flows through the sequencer.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::format::record::RecordKind;
use tokio::sync::oneshot;

/// One event that the sequencer must encrypt and write to a stream segment.
///
/// Each event becomes one record in the target stream's segment file.
/// The sequencer encrypts the plaintext with the stream's AES-256-GCM key,
/// writes the ciphertext to the segment, and records a `StreamRef` for the
/// commit index.
pub struct EventToWrite {
    /// The stream ID (e.g. `"ch_01J..."`, `"dm_01J..."`).
    pub stream_id: String,
    /// The event type name (e.g. `"message_created"`, `"reaction_added"`).
    pub event_type: String,
    /// Numeric stream kind (1=channel, 2=dm, 3=whiteboard, 4=place, 5=kanban, 6=other).
    pub stream_kind: u8,
    /// What kind of record this is (Event, Snapshot, Tombstone, Checkpoint).
    pub record_kind: RecordKind,
    /// The plaintext payload to encrypt and write.
    pub plaintext: Vec<u8>,
}

/// A command that the sequencer should commit.
///
/// The caller constructs a `CommandCommit` with the events to persist, sends
/// it through the sequencer's mpsc channel, and awaits the `response_tx`
/// oneshot for the result.
pub struct CommandCommit {
    /// The caller's user ID (`0` for system callers).
    pub caller_user_id: u64,
    /// The caller's device ID (ULID string).
    pub caller_device_id: String,
    /// The command name (e.g. `"send_message"`).
    pub command_name: String,
    /// Optional idempotency key for replay detection.
    pub idempotency_key: Option<String>,
    /// The events to write as part of this commit.
    pub events: Vec<EventToWrite>,
    /// Whether this is an essential command (`send_message`, `set_presence`).
    /// Non-essential commands are rejected with `EngineBusy` when the
    /// projection dispatcher's mpsc channel is full.
    pub essential: bool,
    /// Channel to send the outcome (or error) back to the caller.
    pub response_tx: oneshot::Sender<Result<CommandOutcome>>,
}

/// The outcome of a successful commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutcome {
    /// The globally monotonic commit sequence number assigned to this commit.
    pub commit_seq: u64,
    /// Server timestamp in microseconds since Unix epoch.
    pub timestamp_micros: i64,
}

/// Envelope wrapping the event payload before encryption.
///
/// During event log replay, the decrypted payload is deserialized as a
/// `ReplayEnvelope` to recover `event_type` and `stream_id` — metadata
/// that is not stored in the `RecordHeader`. This struct is serialized
/// to JSON and encrypted as the on-disk record payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayEnvelope {
    pub event_type: String,
    pub stream_id: String,
    /// The original event payload (plaintext).
    pub payload: Vec<u8>,
}

/// An event as written to a stream segment, post-encryption.
///
/// This is the serializable record of what was actually persisted on disk.
/// It can be serialized/deserialized for commit index entries, backup
/// manifests, and cross-node replication.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DurableEvent {
    /// The globally monotonic commit sequence number.
    pub commit_seq: u64,
    /// The stream ID this event belongs to.
    pub stream_id: String,
    /// The event type name (e.g. `"message_created"`).
    pub event_type: String,
    /// The encrypted payload (AES-256-GCM ciphertext).
    pub ciphertext: Vec<u8>,
    /// The complete serialized record bytes (header + ciphertext).
    pub record_bytes: Vec<u8>,
}
