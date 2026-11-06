//! SPIKE (Task 0.1, throwaway branch, do not merge): SQLite storage behind
//! `MessagesProjection`, used only when the data directory contains the
//! `spike-messages-sqlite` marker file. The sequencer, segments, commit index,
//! replay and encryption are unchanged; this file is a derived read model that
//! can be deleted and rebuilt from the log.
//!
//! - `messages`: latest version of each message, keyed by message ID (the
//!   channel is part of the key because legacy rooms may share an ID).
//! - `messages_by_channel_time`: every version, ordered like the in-memory
//!   `messages_by_channel_time` index (channel, created_at, commit_seq, ID).
//! - `applied_commit_seq`: the last commit whose message events are stored.
//!   Writes open one transaction per commit and store this row in it.

use crate::error::{Result, WabiError};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const OPT_IN_MARKER: &str = "spike-messages-sqlite";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    author_user_id INTEGER NOT NULL,
    record BLOB NOT NULL,
    PRIMARY KEY (message_id, channel_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_channel ON messages (channel_id, message_id);
CREATE INDEX IF NOT EXISTS messages_author ON messages (author_user_id);
CREATE TABLE IF NOT EXISTS messages_by_channel_time (
    channel_id TEXT NOT NULL,
    created_at_micros INTEGER NOT NULL,
    commit_seq INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    record BLOB NOT NULL,
    PRIMARY KEY (channel_id, created_at_micros, commit_seq, message_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS applied_commit_seq (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    seq INTEGER NOT NULL
);
";

pub fn opted_in(data_dir: &Path) -> bool {
    data_dir.join(OPT_IN_MARKER).is_file()
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("projections").join("messages.sqlite3")
}

fn sql_error(error: rusqlite::Error) -> WabiError {
    WabiError::InternalInvariantViolated {
        invariant: format!("sqlite messages read model: {error}"),
    }
}

struct Writer {
    conn: Connection,
    /// The commit whose transaction is open, if any.
    open: Option<u64>,
}

pub struct SqliteMessages {
    path: PathBuf,
    writer: Mutex<Writer>,
    readers: Mutex<Vec<Connection>>,
    applied: AtomicU64,
}

impl std::fmt::Debug for SqliteMessages {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteMessages")
            .field("path", &self.path)
            .field("applied", &self.applied.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

/// Where a channel-time scan starts and ends, inclusive, and its direction.
pub struct TimeRange {
    pub from_micros: i64,
    pub through_micros: i64,
    pub newest_first: bool,
}

impl TimeRange {
    pub fn all(newest_first: bool) -> Self {
        Self { from_micros: i64::MIN, through_micros: i64::MAX, newest_first }
    }
}

impl SqliteMessages {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let path = path(data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path).map_err(sql_error)?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(sql_error)?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(sql_error)?;
        conn.execute_batch(SCHEMA).map_err(sql_error)?;
        let applied: u64 = conn
            .query_row("SELECT seq FROM applied_commit_seq WHERE id = 0", [], |row| row.get::<_, i64>(0))
            .optional()
            .map_err(sql_error)?
            .map_or(0, |seq| seq as u64);
        Ok(Self {
            path,
            writer: Mutex::new(Writer { conn, open: None }),
            readers: Mutex::new(Vec::new()),
            applied: AtomicU64::new(applied),
        })
    }

    /// Highest commit whose message events are committed to SQLite. Events at
    /// or below it are already stored, exactly like a snapshot watermark.
    pub fn applied_seq(&self) -> u64 {
        self.applied.load(Ordering::Acquire)
    }

    /// Run `f` inside the transaction for `commit_seq`. A different commit
    /// first commits the open one, so replay (which has no commit-boundary
    /// hook) still gets one transaction per commit.
    pub fn write<T>(&self, commit_seq: u64, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut writer = self.writer.lock().expect("sqlite writer poisoned");
        match writer.open {
            Some(open) if open == commit_seq => {}
            Some(_) => {
                Self::commit_locked(&mut writer, &self.applied)?;
                writer.conn.execute_batch("BEGIN").map_err(sql_error)?;
                writer.open = Some(commit_seq);
            }
            None => {
                writer.conn.execute_batch("BEGIN").map_err(sql_error)?;
                writer.open = Some(commit_seq);
            }
        }
        f(&writer.conn).map_err(sql_error)
    }

    /// Commit the open transaction, if any, with its watermark row.
    pub fn finish_commit(&self) -> Result<()> {
        let mut writer = self.writer.lock().expect("sqlite writer poisoned");
        Self::commit_locked(&mut writer, &self.applied)
    }

    fn commit_locked(writer: &mut Writer, applied: &AtomicU64) -> Result<()> {
        let Some(seq) = writer.open.take() else { return Ok(()) };
        writer
            .conn
            .prepare_cached("INSERT INTO applied_commit_seq (id, seq) VALUES (0, ?1) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq")
            .and_then(|mut statement| statement.execute(params![seq as i64]))
            .map_err(sql_error)?;
        writer.conn.execute_batch("COMMIT").map_err(sql_error)?;
        applied.store(seq, Ordering::Release);
        Ok(())
    }

    /// Called under the application lock when an in-memory checkpoint is
    /// written at `watermark`: every message event up to it is committed, so
    /// record that (commits without message events never move `applied`) and
    /// make it durable first (WAL is synced before a checkpoint).
    pub fn sync(&self, watermark: u64) -> Result<()> {
        let mut writer = self.writer.lock().expect("sqlite writer poisoned");
        Self::commit_locked(&mut writer, &self.applied)?;
        if watermark > self.applied_seq() {
            writer.conn.execute_batch("BEGIN").map_err(sql_error)?;
            writer.open = Some(watermark);
            Self::commit_locked(&mut writer, &self.applied)?;
        }
        writer
            .conn
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))
            .map_err(sql_error)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let pooled = self.readers.lock().expect("sqlite reader pool poisoned").pop();
        let conn = match pooled {
            Some(conn) => conn,
            None => {
                let conn = Connection::open(&self.path).map_err(sql_error)?;
                conn.pragma_update(None, "query_only", true).map_err(sql_error)?;
                conn
            }
        };
        let result = f(&conn).map_err(sql_error);
        self.readers.lock().expect("sqlite reader pool poisoned").push(conn);
        result
    }

    /// Store one message version: replace the latest row, append a time row.
    pub fn put(
        conn: &Connection,
        commit_seq: u64,
        record: &super::messages::MessageRecord,
        bytes: &[u8],
    ) -> rusqlite::Result<()> {
        conn.prepare_cached(
            "INSERT OR REPLACE INTO messages (message_id, channel_id, author_user_id, record) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![record.message_id, record.channel_id, record.author_user_id as i64, bytes])?;
        conn.prepare_cached(
            "INSERT OR REPLACE INTO messages_by_channel_time (channel_id, created_at_micros, commit_seq, message_id, record) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?
        .execute(params![record.channel_id, record.created_at_micros, commit_seq as i64, record.message_id, bytes])?;
        Ok(())
    }

    pub fn get(conn: &Connection, channel_id: &str, message_id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        conn.prepare_cached("SELECT record FROM messages WHERE message_id = ?1 AND channel_id = ?2")?
            .query_row(params![message_id, channel_id], |row| row.get(0))
            .optional()
    }

    /// At most two rows for an ID, so callers can reject legacy ambiguity.
    pub fn by_id(conn: &Connection, message_id: &str) -> rusqlite::Result<Vec<(String, Vec<u8>)>> {
        conn.prepare_cached("SELECT channel_id, record FROM messages WHERE message_id = ?1 LIMIT 2")?
            .query_map(params![message_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
    }

    /// Latest rows of a channel (or every channel), in message-ID order.
    pub fn visit_latest(
        conn: &Connection,
        channel_id: Option<&str>,
        mut f: impl FnMut(&[u8]) -> bool,
    ) -> rusqlite::Result<()> {
        let mut statement = match channel_id {
            Some(_) => conn.prepare_cached("SELECT record FROM messages WHERE channel_id = ?1 ORDER BY message_id")?,
            None => conn.prepare_cached("SELECT record FROM messages ORDER BY channel_id, message_id")?,
        };
        let mut rows = match channel_id {
            Some(channel_id) => statement.query(params![channel_id])?,
            None => statement.query([])?,
        };
        while let Some(row) = rows.next()? {
            if !f(row.get_ref(0)?.as_blob()?) {
                break;
            }
        }
        Ok(())
    }

    pub fn visit_author(conn: &Connection, author: u64, mut f: impl FnMut(&[u8])) -> rusqlite::Result<()> {
        let mut statement = conn.prepare_cached("SELECT record FROM messages WHERE author_user_id = ?1")?;
        let mut rows = statement.query(params![author as i64])?;
        while let Some(row) = rows.next()? {
            f(row.get_ref(0)?.as_blob()?);
        }
        Ok(())
    }

    /// Walk every stored version in a channel's time order; stop when `f`
    /// returns `Ok(false)`.
    pub fn visit_time<E>(
        conn: &Connection,
        channel_id: &str,
        range: &TimeRange,
        mut f: impl FnMut(&[u8]) -> std::result::Result<bool, E>,
    ) -> rusqlite::Result<std::result::Result<(), E>> {
        let sql = if range.newest_first {
            "SELECT record FROM messages_by_channel_time WHERE channel_id = ?1 AND created_at_micros BETWEEN ?2 AND ?3 ORDER BY created_at_micros DESC, commit_seq DESC, message_id DESC"
        } else {
            "SELECT record FROM messages_by_channel_time WHERE channel_id = ?1 AND created_at_micros BETWEEN ?2 AND ?3 ORDER BY created_at_micros, commit_seq, message_id"
        };
        let mut statement = conn.prepare_cached(sql)?;
        let mut rows = statement.query(params![channel_id, range.from_micros, range.through_micros])?;
        while let Some(row) = rows.next()? {
            match f(row.get_ref(0)?.as_blob()?) {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => return Ok(Err(error)),
            }
        }
        Ok(Ok(()))
    }

    /// Remove soft-deleted messages and every time-index version of them.
    pub fn compact(&self) -> Result<usize> {
        let writer = self.writer.lock().expect("sqlite writer poisoned");
        let mut deleted = Vec::new();
        Self::visit_latest(&writer.conn, None, |bytes| {
            if let Ok(record) = super::messages::decode_record_lenient(bytes) {
                if record.is_deleted {
                    deleted.push((record.channel_id, record.message_id));
                }
            }
            true
        })
        .map_err(sql_error)?;
        let mut removed = 0;
        for (channel_id, message_id) in deleted {
            removed += writer
                .conn
                .execute("DELETE FROM messages WHERE message_id = ?1 AND channel_id = ?2", params![message_id, channel_id])
                .map_err(sql_error)?;
            removed += writer
                .conn
                .execute(
                    "DELETE FROM messages_by_channel_time WHERE channel_id = ?1 AND message_id = ?2",
                    params![channel_id, message_id],
                )
                .map_err(sql_error)?;
        }
        Ok(removed)
    }
}
