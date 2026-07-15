//! Error types for WabiDB.
//!
//! The single `WabiError` enum covers every error category the engine can produce.
//! Category-specific enums (e.g. `StorageError`, `CommandError`) are used internally
//! by components and converted to `WabiError` at the API boundary.
//!
//! Design notes:
//! - `WabiError` implements `std::error::Error + Send + Sync`.
//! - Every variant has a `#[error("...")]` attribute so `Display` works.
//! - Variants are grouped by category; use the `category()` method to classify.
//! - `WabiError::is_retryable()` returns `true` for errors that may succeed on a
//!   second attempt (e.g., engine busy, transient I/O). It returns `false` for
//!   errors that are deterministic (e.g., validation failed, ACL denied).
//! - `From<std::io::Error>` and other common conversions are implemented.

use std::fmt;
use std::io;

/// The single error type returned by every WabiDB API.
///
/// The variant set is the public contract; internal components may use more
/// specific enums and convert at the boundary.
#[derive(Debug)]
pub enum WabiError {
    // --- Storage layer ---
    /// I/O error from the underlying filesystem.
    Io(io::Error),
    /// A record or file failed its CRC check.
    Corrupt {
        /// What was being checked (e.g. "stream segment", "commit index entry").
        location: String,
        /// A description of the corruption (e.g. "CRC mismatch at offset 1234").
        detail: String,
    },
    /// The on-disk format version is not supported by this engine build.
    UnsupportedFormatVersion {
        /// The format version that was found.
        found: u16,
        /// The set of versions this build supports.
        supported: Vec<u16>,
    },
    /// The magic bytes at the start of a file don't match.
    BadMagic {
        /// The expected magic (e.g. "WABI").
        expected: &'static str,
        /// What was found (hex).
        found: String,
    },
    /// A requested resource (blob, stream, etc.) was not found.
    NotFound {
        /// What was not found.
        what: String,
    },
    /// A stream segment was truncated and recovery could not find a valid prefix.
    SegmentUnrecoverable {
        /// The stream id.
        stream_id: String,
        /// Byte offset where recovery gave up.
        offset: u64,
    },

    // --- Encryption layer ---
    /// A stream key was not found in the registry.
    UnknownStreamKey {
        /// The key id that was looked up.
        key_id: String,
    },
    /// AES-GCM authentication tag verification failed.
    AuthTagMismatch {
        /// The stream id whose record failed authentication.
        stream_id: String,
        /// The commit_seq of the failed record.
        commit_seq: u64,
    },
    /// A key was used outside its allowed commit_seq range (per Council Review #1 §1.1).
    KeyRangeViolation {
        /// The key id.
        key_id: String,
        /// The key's minimum allowed commit_seq.
        min_commit_seq: u64,
        /// The commit_seq that was attempted.
        attempted_commit_seq: u64,
    },
    /// The engine was opened with the wrong root key (passphrase prompt failed).
    WrongRootKey,
    /// OS keychain integration was requested but is not available.
    KeychainUnavailable,

    // --- Commit sequencer ---
    /// The sequencer is in degraded mode (per `wabidb-15` backpressure).
    EngineBusy {
        /// Suggested time to wait before retrying, in milliseconds.
        retry_after_ms: u64,
    },
    /// The projection dispatcher channel is full and the commit cannot proceed.
    DispatcherBacklogFull {
        /// Current depth of the dispatcher channel.
        depth: usize,
        /// Configured maximum depth.
        capacity: usize,
    },
    /// A burned `commit_seq` was attempted to be reused (Council Review #1 §2.2).
    CommitSeqReuse {
        /// The `commit_seq` that was attempted.
        commit_seq: u64,
    },

    // --- Commands ---
    /// A command failed input validation.
    Validation {
        /// The name of the command that failed.
        command: String,
        /// A description of the validation failure.
        reason: String,
    },
    /// The caller is not authorized to run the command.
    Forbidden {
        /// The user that was denied.
        user_id: u64,
        /// The command that was denied.
        command: String,
    },
    /// A command required an idempotency key but none was provided.
    IdempotencyKeyRequired {
        /// The command that requires the key.
        command: String,
    },
    /// A command with the same `(caller, client_request_id)` was already processed
    /// and the cached result is available. This is not an error from the caller's
    /// perspective but a flag the engine returns.
    IdempotentReplay {
        /// The cached `commit_seq` of the original execution.
        commit_seq: u64,
    },
    /// A foreign key or reference was violated.
    ConstraintViolation {
        /// The constraint that was violated (e.g. "user_id not found").
        constraint: String,
    },

    // --- Subscriptions ---
    /// The caller is not authorized to subscribe to the topic.
    TopicAclDenied {
        /// The user that was denied.
        user_id: u64,
        /// The topic that was denied.
        topic: String,
    },
    /// The client's `resume_after` is older than the retention window. The client
    /// must request a fresh snapshot.
    SnapshotRequired,
    /// The client was removed from a topic (membership revoked) and the subscription
    /// was force-closed.
    SubscriptionRevoked {
        /// The topic from which the client was revoked.
        topic: String,
    },
    /// The per-subscriber data channel is full; client is too slow.
    Backpressure {
        /// Time the client has before the subscription is force-closed.
        timeout_ms: u64,
    },
    /// The subscription timed out (e.g. backpressure timeout elapsed).
    SubscriptionTimeout {
        /// The subscription id.
        subscription_id: String,
    },
    /// A WebSocket ticket failed validation.
    TicketInvalid {
        /// The reason the ticket was invalid (e.g. "expired", "used", "wrong").
        reason: &'static str,
    },

    // --- Crypto (X3DH + Double Ratchet) ---
    /// The prekey has already been consumed by another peer (atomic UPDATE failed).
    PrekeyAlreadyConsumed,
    /// The device whose prekey was requested is no longer active.
    DeviceRevoked,
    /// The signed prekey signature did not verify against the identity key.
    SignatureVerificationFailed,
    /// The Double Ratchet skipped-key cache is full.
    SkippedKeyCacheFull,

    // --- Retention / compaction ---
    /// A stream's key was destroyed (cryptographic deletion succeeded).
    StreamDestroyed {
        /// The stream that was destroyed.
        stream_id: String,
    },
    /// A blob reference exists in the database but the underlying file is missing.
    BlobMissing {
        /// The BLAKE3 hash of the missing blob.
        hash: String,
    },
    /// A blob is orphaned (ref_count = 0) and the GC will reap it.
    BlobOrphaned {
        /// The BLAKE3 hash of the orphaned blob.
        hash: String,
    },

    // --- Backup / restore ---
    /// The manifest's checksum did not match the data.
    BackupCorrupt {
        /// The file that failed verification.
        file: String,
    },
    /// The backup is missing a required file.
    BackupMissing {
        /// The file that is missing.
        file: String,
    },
    /// A restore was attempted but the engine is already running.
    AlreadyRunning,

    // --- Internal / programming errors ---
    /// An invariant was violated; the engine cannot continue safely.
    /// This is always a bug. Logs the panic info before returning.
    InternalInvariantViolated {
        /// A description of the invariant.
        invariant: String,
    },
    /// A feature is not yet implemented.
    Unimplemented {
        /// A description of what's missing.
        feature: String,
    },
}

impl fmt::Display for WabiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::Corrupt { location, detail } => {
                write!(f, "corrupt {location}: {detail}")
            }
            Self::UnsupportedFormatVersion { found, supported } => {
                write!(f, "unsupported format version {found}; supported: {supported:?}")
            }
            Self::BadMagic { expected, found } => {
                write!(f, "bad magic: expected {expected}, found {found}")
            }
            Self::NotFound { what } => write!(f, "not found: {what}"),
            Self::SegmentUnrecoverable { stream_id, offset } => {
                write!(f, "segment for stream {stream_id} unrecoverable at offset {offset}")
            }
            Self::UnknownStreamKey { key_id } => {
                write!(f, "unknown stream key: {key_id}")
            }
            Self::AuthTagMismatch { stream_id, commit_seq } => {
                write!(f, "AES-GCM auth tag mismatch on stream {stream_id} at commit_seq {commit_seq}")
            }
            Self::KeyRangeViolation { key_id, min_commit_seq, attempted_commit_seq } => {
                write!(
                    f,
                    "key {key_id} used outside allowed range: min={min_commit_seq}, attempted={attempted_commit_seq}"
                )
            }
            Self::WrongRootKey => write!(f, "wrong root key (passphrase mismatch)"),
            Self::KeychainUnavailable => write!(f, "OS keychain integration unavailable"),
            Self::EngineBusy { retry_after_ms } => {
                write!(f, "engine busy, retry after {retry_after_ms}ms")
            }
            Self::DispatcherBacklogFull { depth, capacity } => {
                write!(f, "dispatcher backlog full: {depth}/{capacity}")
            }
            Self::CommitSeqReuse { commit_seq } => {
                write!(f, "commit_seq {commit_seq} reuse attempted (invariant violation)")
            }
            Self::Validation { command, reason } => {
                write!(f, "validation failed for {command}: {reason}")
            }
            Self::Forbidden { user_id, command } => {
                write!(f, "user {user_id} forbidden from {command}")
            }
            Self::IdempotencyKeyRequired { command } => {
                write!(f, "{command} requires an idempotency key")
            }
            Self::IdempotentReplay { commit_seq } => {
                write!(f, "idempotent replay; original commit_seq {commit_seq}")
            }
            Self::ConstraintViolation { constraint } => {
                write!(f, "constraint violation: {constraint}")
            }
            Self::TopicAclDenied { user_id, topic } => {
                write!(f, "user {user_id} denied access to topic {topic}")
            }
            Self::SnapshotRequired => write!(f, "snapshot required (resume_after older than retention)"),
            Self::SubscriptionRevoked { topic } => {
                write!(f, "subscription revoked for topic {topic}")
            }
            Self::Backpressure { timeout_ms } => {
                write!(f, "backpressure: subscriber too slow, timeout in {timeout_ms}ms")
            }
            Self::SubscriptionTimeout { subscription_id } => {
                write!(f, "subscription {subscription_id} timed out")
            }
            Self::TicketInvalid { reason } => {
                write!(f, "WebSocket ticket invalid: {reason}")
            }
            Self::PrekeyAlreadyConsumed => {
                write!(f, "prekey already consumed (atomic UPDATE failed)")
            }
            Self::DeviceRevoked => write!(f, "device is revoked"),
            Self::SignatureVerificationFailed => {
                write!(f, "signed prekey signature verification failed")
            }
            Self::SkippedKeyCacheFull => {
                write!(f, "double ratchet skipped key cache full (max 1000)")
            }
            Self::StreamDestroyed { stream_id } => {
                write!(f, "stream {stream_id} destroyed (cryptographic deletion)")
            }
            Self::BlobMissing { hash } => {
                write!(f, "blob missing: {hash}")
            }
            Self::BlobOrphaned { hash } => {
                write!(f, "blob orphaned (ref_count=0): {hash}")
            }
            Self::BackupCorrupt { file } => {
                write!(f, "backup corrupt: {file}")
            }
            Self::BackupMissing { file } => {
                write!(f, "backup missing: {file}")
            }
            Self::AlreadyRunning => write!(f, "engine already running"),
            Self::InternalInvariantViolated { invariant } => {
                write!(f, "INTERNAL INVARIANT VIOLATED: {invariant}")
            }
            Self::Unimplemented { feature } => {
                write!(f, "unimplemented: {feature}")
            }
        }
    }
}

impl std::error::Error for WabiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

/// Category of a `WabiError`.
///
/// Used for metrics, structured logging, and engine-level decision making
/// (e.g., "should this error trigger degraded mode?").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    /// Storage layer (filesystem, format)
    Storage,
    /// Encryption / decryption
    Crypto,
    /// Commit sequencer (engine state)
    Sequencer,
    /// Command execution (validation, auth)
    Command,
    /// Subscription / WebSocket
    Subscription,
    /// Retention / blob GC
    Retention,
    /// Backup / restore
    Backup,
    /// Internal / invariant violation (always a bug)
    Internal,
}

impl WabiError {
    /// Classify this error into a category.
    pub fn category(&self) -> ErrorCategory {
        match self {
            Self::Io(_)
            | Self::NotFound { .. }
            | Self::Corrupt { .. }
            | Self::UnsupportedFormatVersion { .. }
            | Self::BadMagic { .. }
            | Self::SegmentUnrecoverable { .. } => ErrorCategory::Storage,
            Self::UnknownStreamKey { .. }
            | Self::AuthTagMismatch { .. }
            | Self::KeyRangeViolation { .. }
            | Self::WrongRootKey
            | Self::KeychainUnavailable
            | Self::PrekeyAlreadyConsumed
            | Self::DeviceRevoked
            | Self::SignatureVerificationFailed
            | Self::SkippedKeyCacheFull => ErrorCategory::Crypto,
            Self::EngineBusy { .. }
            | Self::DispatcherBacklogFull { .. }
            | Self::CommitSeqReuse { .. } => ErrorCategory::Sequencer,
            Self::Validation { .. }
            | Self::Forbidden { .. }
            | Self::IdempotencyKeyRequired { .. }
            | Self::IdempotentReplay { .. }
            | Self::ConstraintViolation { .. } => ErrorCategory::Command,
            Self::TopicAclDenied { .. }
            | Self::SnapshotRequired
            | Self::SubscriptionRevoked { .. }
            | Self::Backpressure { .. }
            | Self::SubscriptionTimeout { .. }
            | Self::TicketInvalid { .. } => ErrorCategory::Subscription,
            Self::StreamDestroyed { .. } | Self::BlobMissing { .. } | Self::BlobOrphaned { .. } => {
                ErrorCategory::Retention
            }
            Self::BackupCorrupt { .. }
            | Self::BackupMissing { .. }
            | Self::AlreadyRunning => ErrorCategory::Backup,
            Self::InternalInvariantViolated { .. } | Self::Unimplemented { .. } => {
                ErrorCategory::Internal
            }
        }
    }

    /// Whether this error may succeed on a second attempt.
    ///
    /// Retryable errors are typically transient (engine busy, I/O hiccup).
    /// Non-retryable errors are deterministic (validation failed, ACL denied,
    /// signature mismatch). The caller should not retry non-retryable errors.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Io(_) => true,
            Self::EngineBusy { .. } => true,
            Self::DispatcherBacklogFull { .. } => true,
            Self::Backpressure { .. } => true,
            _ => false,
        }
    }

    /// Whether this error indicates the engine is in a degraded state
    /// (e.g., should reject non-essential commands but accept essentials).
    pub fn is_degraded(&self) -> bool {
        match self {
            Self::EngineBusy { .. } | Self::DispatcherBacklogFull { .. } => true,
            _ => false,
        }
    }

    /// Whether this error is an `InternalInvariantViolated`.
    ///
    /// `Internal` errors always indicate a bug and should be logged with full
    /// backtrace. They should not be returned to clients.
    pub fn is_internal_bug(&self) -> bool {
        matches!(self, Self::InternalInvariantViolated { .. } | Self::Unimplemented { .. })
    }
}

// --- Common conversions ---

impl From<io::Error> for WabiError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<tokio::task::JoinError> for WabiError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self::InternalInvariantViolated {
            invariant: format!("tokio task join failed: {e}"),
        }
    }
}

/// Result alias for WabiDB operations.
pub type Result<T> = std::result::Result<T, WabiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_classification() {
        assert_eq!(
            WabiError::EngineBusy { retry_after_ms: 100 }.category(),
            ErrorCategory::Sequencer
        );
        assert_eq!(
            WabiError::Forbidden { user_id: 1, command: "send_message".into() }.category(),
            ErrorCategory::Command
        );
        assert_eq!(
            WabiError::AuthTagMismatch { stream_id: "x".into(), commit_seq: 1 }.category(),
            ErrorCategory::Crypto
        );
        assert_eq!(
            WabiError::InternalInvariantViolated { invariant: "x".into() }.category(),
            ErrorCategory::Internal
        );
    }

    #[test]
    fn retryable_classification() {
        assert!(WabiError::EngineBusy { retry_after_ms: 100 }.is_retryable());
        assert!(WabiError::Io(io::Error::new(io::ErrorKind::Other, "x")).is_retryable());
        assert!(!WabiError::Forbidden { user_id: 1, command: "x".into() }.is_retryable());
        assert!(!WabiError::SignatureVerificationFailed.is_retryable());
    }

    #[test]
    fn degraded_classification() {
        assert!(WabiError::EngineBusy { retry_after_ms: 100 }.is_degraded());
        assert!(!WabiError::Validation {
            command: "x".into(),
            reason: "y".into()
        }
        .is_degraded());
    }

    #[test]
    fn display_messages() {
        let e = WabiError::EngineBusy { retry_after_ms: 100 };
        let s = format!("{e}");
        assert!(s.contains("100"));

        let e = WabiError::AuthTagMismatch {
            stream_id: "ch_01H".into(),
            commit_seq: 42,
        };
        let s = format!("{e}");
        assert!(s.contains("ch_01H"));
        assert!(s.contains("42"));
    }

    #[test]
    fn from_io_error() {
        let io_err = io::Error::new(io::ErrorKind::NotFound, "missing");
        let wabi: WabiError = io_err.into();
        assert!(matches!(wabi, WabiError::Io(_)));
    }
}
