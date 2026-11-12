//! Tables of the SQLite read model, and the two numbers that say whether a
//! file on disk can be used by this build.
//!
//! Both numbers are stored in `read_model_meta`. When either differs from the
//! build's, the engine deletes the file and rebuilds it from the log; nothing
//! is migrated in place, because the read model is derived.

/// Layout of the tables below. Change it whenever a table, column or index
/// changes.
pub(crate) const SCHEMA_VERSION: i64 = 3;

/// What replay writes into the read model.
///
/// Replay decodes records and encodes them again, so the stored bytes depend
/// on the build: the same event yields different rows after a record's
/// version is bumped or a handler stores something else. A file written by
/// another generation may therefore disagree with the log.
///
/// **Bump this number in the same change** whenever
/// - a record type gets a new version in `format::versioned`, or
/// - a projection handler whose rows live in the read model changes what it
///   stores for an event (keys, values, which events it applies).
pub const READ_MODEL_GENERATION: i64 = 4;

/// The largest commit number any file may name. Anything above is damage or
/// tampering, not a count of commits: a value near `u64::MAX` would stop the
/// sequencer, and SQLite stores the number as a signed 64-bit integer.
pub(crate) const MAX_COMMIT_SEQ: u64 = 1 << 62;

/// File name under `<data dir>/projections/`.
pub(crate) const FILE_NAME: &str = "read-model.sqlite3";

/// Name of the messages projection's row in `applied_commit_seq`.
pub(crate) const MESSAGES: &str = "messages";

/// Name of the channels projection's row in `applied_commit_seq`.
pub(crate) const CHANNELS: &str = "channels";

/// Name of the channel_members projection's row in `applied_commit_seq`.
pub(crate) const CHANNEL_MEMBERS: &str = "channel_members";

/// Every projection stored here, by its row in `applied_commit_seq`. All of
/// them are written in one transaction per commit, so their rows always hold
/// the same number.
pub(crate) const PROJECTIONS: [&str; 3] = [MESSAGES, CHANNELS, CHANNEL_MEMBERS];

/// `messages`: the latest version of each message. `key` is the length-prefixed
/// channel id followed by the length-prefixed message id, so a byte-ordered
/// range scan lists one channel exactly as the old in-memory index did. The
/// channel is part of the key because legacy rooms may share a message id.
///
/// `message_versions`: one row per message event (create, edit, delete).
/// `key` is the length-prefixed channel id, the creation time and the commit
/// sequence (both big-endian), then the length-prefixed message id: a channel
/// in time order, with later events of the same message sorting after earlier
/// ones.
///
/// `channels`: one row per channel, `key` being the channel id's bytes and
/// `record` the channel as JSON (`domain::Channel`), the bytes the in-memory
/// `channels` index held. Byte order of `key` is the old index's order.
///
/// `channel_members`: one row per member of a channel. `key` is the
/// length-prefixed channel id followed by the user id (8 bytes, little
/// endian), so a byte-ordered range scan lists one channel exactly as the old
/// in-memory index did; `record` is the versioned `ChannelMemberRecord`;
/// `user_id` repeats the key's user id (its 64 bits stored as a signed
/// integer) so that a user's memberships are one indexed lookup.
/// `channel_membership_versions`: one row per channel with membership
/// history, `key` being the channel id's bytes and `record` the commit of the
/// channel's latest membership event (8 bytes, little endian).
///
/// `read_model_meta.sync_count` is bumped by every checkpoint sync, so that
/// transaction always writes something for SQLite to sync.
///
/// `applied_commit_seq`: one row per projection stored here. Every commit
/// whose events that projection handles, up to and including `seq`, is in the
/// tables. The row is written in the same transaction as the rows it covers.
pub(crate) const DDL: &str = "
CREATE TABLE read_model_meta (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    schema_version INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    sync_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE applied_commit_seq (
    projection TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE messages (
    key BLOB PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_user_id INTEGER NOT NULL,
    record BLOB NOT NULL
) WITHOUT ROWID;
CREATE INDEX messages_by_id ON messages (message_id);
CREATE INDEX messages_by_author ON messages (author_user_id);
CREATE TABLE message_versions (
    key BLOB PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    record BLOB NOT NULL
) WITHOUT ROWID;
CREATE INDEX message_versions_by_message ON message_versions (channel_id, message_id);
CREATE TABLE channels (
    key BLOB PRIMARY KEY,
    record BLOB NOT NULL
) WITHOUT ROWID;
CREATE TABLE channel_members (
    key BLOB PRIMARY KEY,
    user_id INTEGER NOT NULL,
    record BLOB NOT NULL
) WITHOUT ROWID;
CREATE INDEX channel_members_by_user ON channel_members (user_id);
CREATE TABLE channel_membership_versions (
    key BLOB PRIMARY KEY,
    record BLOB NOT NULL
) WITHOUT ROWID;
";
