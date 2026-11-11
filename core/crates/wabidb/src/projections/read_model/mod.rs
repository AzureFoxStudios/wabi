//! The SQLite read model (ADR-0001): projection rows derived from the log.
//!
//! The log stays the source of truth. This store can be deleted at any time;
//! the engine then rebuilds it by replaying the log. It holds record bytes
//! exactly as the in-memory projection held them, so on disk it is as
//! readable as `projections/snapshot.json`: not encrypted.
//!
//! Three kinds of store exist:
//! - **file**: what an open engine uses. One writer connection and a pool of
//!   read-only connections on `projections/read-model.sqlite3` (WAL mode).
//!   Readers only ever see whole commits.
//! - **in memory**: what a bare [`ProjectionState`](crate::engine::locks::ProjectionState)
//!   uses (unit tests, offline inspection's replay). One connection; reads
//!   see writes at once, as the skip maps did.
//! - **frozen**: a file opened read-only and immutable for offline
//!   inspection. Nothing on disk is created or changed.
//!
//! Transactions: the first write after a commit boundary opens one, and the
//! caller that owns the boundary closes it. The dispatcher and replication
//! ingest call [`ReadModel::finish_commit`] once per durable commit, so a
//! commit's rows and its `applied_commit_seq` row become visible together.
//! Startup replay never calls it, so everything replay writes is one
//! transaction, committed by [`ReadModel::commit_startup`] only after replay
//! validated the whole log, and rolled back otherwise.
//!
//! No `rusqlite` type leaves this module's crate-private API.

pub(crate) mod schema;

pub use schema::READ_MODEL_GENERATION;

use crate::error::{Result, WabiError};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// Idle read connections kept for reuse.
const MAX_IDLE_READERS: usize = 16;

fn sql_error(error: rusqlite::Error) -> WabiError {
    WabiError::InternalInvariantViolated {
        invariant: format!("projection read model: {error}"),
    }
}

/// A table whose rows are a byte key and a record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Table {
    Messages,
    MessageVersions,
}

impl Table {
    pub(crate) const ALL: [Table; 2] = [Table::Messages, Table::MessageVersions];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Table::Messages => "messages",
            Table::MessageVersions => "message_versions",
        }
    }
}

struct Writer {
    conn: Connection,
    /// A transaction is open and holds uncommitted rows.
    in_transaction: bool,
}

pub(crate) struct ReadModel {
    /// The database file; `None` for an in-memory store.
    file: Option<PathBuf>,
    /// Opened for offline inspection: never written.
    frozen: bool,
    writer: Mutex<Writer>,
    readers: Mutex<Vec<Connection>>,
    /// Committed `applied_commit_seq` of the messages projection.
    messages_applied: AtomicU64,
    /// During startup replay: message events at or below this commit are
    /// already stored and must not be applied again. Zero otherwise.
    replay_floor: AtomicU64,
    /// Why `open` discarded an existing file, if it did.
    #[cfg_attr(not(test), allow(dead_code))]
    discarded: Option<String>,
}

impl std::fmt::Debug for ReadModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadModel")
            .field("file", &self.file)
            .field("frozen", &self.frozen)
            .field("messages_applied", &self.messages_applied_seq())
            .finish_non_exhaustive()
    }
}

impl Drop for ReadModel {
    /// Close the read connections before the writer. SQLite folds the
    /// write-ahead log into the database and removes it when the last
    /// connection closes, but a read-only connection cannot do that; closed
    /// last, it would leave the log behind on every clean shutdown.
    fn drop(&mut self) {
        lock(&self.readers).clear();
        let mut writer = lock(&self.writer);
        if writer.in_transaction {
            let _ = writer.conn.execute_batch("ROLLBACK");
            writer.in_transaction = false;
        }
    }
}

/// A panic inside a handler must not make the store unusable: the connection
/// is still valid and the caller rolls the transaction back.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_meta(conn: &Connection) -> rusqlite::Result<Option<(i64, i64)>> {
    conn.query_row(
        "SELECT schema_version, generation FROM read_model_meta WHERE id = 0",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

fn read_applied(conn: &Connection) -> rusqlite::Result<u64> {
    Ok(conn
        .query_row(
            "SELECT seq FROM applied_commit_seq WHERE projection = ?1",
            params![schema::MESSAGES],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .map_or(0, |seq| seq as u64))
}

fn create_tables(conn: &Connection, generation: i64) -> rusqlite::Result<()> {
    conn.execute_batch(&format!("BEGIN IMMEDIATE;{}COMMIT;", schema::DDL))?;
    conn.execute(
        "INSERT INTO read_model_meta (id, schema_version, generation) VALUES (0, ?1, ?2)",
        params![schema::SCHEMA_VERSION, generation],
    )?;
    Ok(())
}

fn raise_applied(conn: &Connection, seq: u64) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO applied_commit_seq (projection, seq) VALUES (?1, ?2) \
         ON CONFLICT (projection) DO UPDATE SET seq = max(seq, excluded.seq)",
    )?
    .execute(params![schema::MESSAGES, seq as i64])?;
    Ok(())
}

/// Create the database file readable and writable by its owner only. SQLite
/// gives its `-wal` and `-shm` files the mode of the database file.
fn make_private(path: &Path) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(options.open(path)?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `file:` URI for a path, for SQLite's URI filenames.
fn file_uri(path: &Path) -> Option<String> {
    let text = path.to_str()?.replace('\\', "/");
    let mut uri = String::from("file:");
    if !text.starts_with('/') {
        uri.push('/');
    }
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                uri.push(byte as char)
            }
            other => uri.push_str(&format!("%{other:02X}")),
        }
    }
    Some(uri)
}

impl ReadModel {
    /// Where an engine keeps its read model.
    pub(crate) fn path(data_dir: &Path) -> PathBuf {
        data_dir.join("projections").join(schema::FILE_NAME)
    }

    /// Delete the read model and SQLite's files beside it. The engine must
    /// not be running. The next open rebuilds everything from the log.
    pub(crate) fn remove_files(data_dir: &Path) -> Result<()> {
        let path = Self::path(data_dir);
        for file in [sidecar(&path, "-wal"), sidecar(&path, "-shm"), path] {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// A store that lives only as long as this value.
    pub(crate) fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("open in-memory read model");
        create_tables(&conn, READ_MODEL_GENERATION).expect("create in-memory read model");
        Self {
            file: None,
            frozen: false,
            writer: Mutex::new(Writer { conn, in_transaction: false }),
            readers: Mutex::new(Vec::new()),
            messages_applied: AtomicU64::new(0),
            replay_floor: AtomicU64::new(0),
            discarded: None,
        }
    }

    /// Open the engine's read model, creating it when missing.
    ///
    /// A file that cannot be read, or whose schema version or generation is
    /// not this build's, is deleted and created empty, with
    /// `applied_commit_seq` zero. The engine then replays the whole log.
    pub(crate) fn open(data_dir: &Path) -> Result<Self> {
        Self::open_as_generation(data_dir, READ_MODEL_GENERATION)
    }

    /// [`Self::open`] for a build whose generation is `generation`.
    pub(crate) fn open_as_generation(data_dir: &Path, generation: i64) -> Result<Self> {
        let path = Self::path(data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut discarded = None;
        loop {
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.is_file() => {
                    return Err(WabiError::Corrupt {
                        location: path.display().to_string(),
                        detail: "projection read model is not a regular file".into(),
                    });
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let existed = std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0);
            make_private(&path)?;
            let opened = Connection::open(&path).and_then(|conn| {
                conn.busy_timeout(Duration::from_secs(5))?;
                conn.pragma_update(None, "journal_mode", "WAL")?;
                conn.pragma_update(None, "synchronous", "NORMAL")?;
                if !existed {
                    create_tables(&conn, generation)?;
                }
                let meta = read_meta(&conn)?;
                let applied = read_applied(&conn)?;
                Ok((conn, meta, applied))
            });
            let problem = match opened {
                Ok((conn, Some((schema_version, stored)), applied))
                    if schema_version == schema::SCHEMA_VERSION && stored == generation =>
                {
                    return Ok(Self {
                        file: Some(path),
                        frozen: false,
                        writer: Mutex::new(Writer { conn, in_transaction: false }),
                        readers: Mutex::new(Vec::new()),
                        messages_applied: AtomicU64::new(applied),
                        replay_floor: AtomicU64::new(0),
                        discarded,
                    });
                }
                Ok((_, Some((schema_version, stored)), _)) => format!(
                    "schema version {schema_version} generation {stored}, this build has \
                     schema version {} generation {generation}",
                    schema::SCHEMA_VERSION
                ),
                Ok((_, None, _)) => "it has no version row".to_string(),
                Err(error) => format!("it cannot be read: {error}"),
            };
            if discarded.is_some() || !existed {
                // A file this call just created is still unusable.
                return Err(WabiError::Corrupt {
                    location: path.display().to_string(),
                    detail: format!("projection read model cannot be created: {problem}"),
                });
            }
            tracing::warn!(
                "projection read model {} is discarded and will be rebuilt from the log: {problem}",
                path.display()
            );
            Self::remove_files(data_dir)?;
            discarded = Some(problem);
        }
    }

    /// Open a stopped engine's read model without creating or changing any
    /// file. `None` when there is nothing this build could use as it is: no
    /// file, a write-ahead log that still holds frames, or another schema
    /// version or generation. In each of those cases the engine would rebuild
    /// or recover the file when it opens.
    pub(crate) fn open_frozen(data_dir: &Path) -> Option<Self> {
        let path = Self::path(data_dir);
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() == 0 {
            return None;
        }
        if std::fs::metadata(sidecar(&path, "-wal")).is_ok_and(|wal| wal.len() > 0) {
            return None;
        }
        let uri = format!("{}?immutable=1", file_uri(&path)?);
        let conn = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .ok()?;
        let meta = read_meta(&conn).ok()??;
        if meta != (schema::SCHEMA_VERSION, READ_MODEL_GENERATION) {
            return None;
        }
        let applied = read_applied(&conn).ok()?;
        Some(Self {
            file: None,
            frozen: true,
            writer: Mutex::new(Writer { conn, in_transaction: false }),
            readers: Mutex::new(Vec::new()),
            messages_applied: AtomicU64::new(applied),
            replay_floor: AtomicU64::new(0),
            discarded: None,
        })
    }

    /// Why `open` threw an existing file away, if it did.
    #[cfg(test)]
    pub(crate) fn discarded(&self) -> Option<&str> {
        self.discarded.as_deref()
    }

    /// The committed `applied_commit_seq` of the messages projection: every
    /// message event of every commit up to it is stored.
    pub(crate) fn messages_applied_seq(&self) -> u64 {
        self.messages_applied.load(Ordering::Acquire)
    }

    /// Message events at or below this commit are already stored (startup
    /// replay only; zero otherwise).
    pub(crate) fn replay_floor(&self) -> u64 {
        self.replay_floor.load(Ordering::Acquire)
    }

    /// Run `f` on the writer connection, inside the open transaction; open
    /// one first if none is. Reads in `f` see the transaction's own rows.
    pub(crate) fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        if self.frozen {
            return Err(WabiError::InternalInvariantViolated {
                invariant: "write to a read-only projection read model".into(),
            });
        }
        let mut writer = lock(&self.writer);
        if !writer.in_transaction {
            writer.conn.execute_batch("BEGIN IMMEDIATE").map_err(sql_error)?;
            writer.in_transaction = true;
        }
        f(&writer.conn)
    }

    /// Run `f` on a connection that sees committed rows. An in-memory or
    /// frozen store has one connection, so `f` must not call back into it.
    pub(crate) fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let Some(path) = &self.file else {
            return f(&lock(&self.writer).conn);
        };
        let pooled = lock(&self.readers).pop();
        let conn = match pooled {
            Some(conn) => conn,
            None => {
                let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(sql_error)?;
                conn.busy_timeout(Duration::from_secs(5)).map_err(sql_error)?;
                conn
            }
        };
        let result = f(&conn);
        let mut readers = lock(&self.readers);
        if readers.len() < MAX_IDLE_READERS {
            readers.push(conn);
        }
        result
    }

    fn commit_locked(&self, writer: &mut Writer, seq: u64) -> Result<()> {
        raise_applied(&writer.conn, seq).map_err(sql_error)?;
        writer.conn.execute_batch("COMMIT").map_err(sql_error)?;
        writer.in_transaction = false;
        self.messages_applied.fetch_max(seq, Ordering::AcqRel);
        Ok(())
    }

    /// End durable commit `seq`: commit its rows together with
    /// `applied_commit_seq = seq`. Nothing happens when the commit wrote no
    /// row here; the watermark then catches up at the next checkpoint.
    pub(crate) fn finish_commit(&self, seq: u64) -> Result<()> {
        let mut writer = lock(&self.writer);
        if !writer.in_transaction {
            return Ok(());
        }
        self.commit_locked(&mut writer, seq)
    }

    /// Throw away everything written since the last commit.
    pub(crate) fn rollback(&self) {
        let mut writer = lock(&self.writer);
        if writer.in_transaction {
            if let Err(error) = writer.conn.execute_batch("ROLLBACK") {
                tracing::error!("projection read model rollback failed: {error}");
            }
            writer.in_transaction = false;
        }
        self.replay_floor.store(0, Ordering::Release);
    }

    /// Prepare for startup replay. With `rebuild`, the tables are emptied
    /// inside the startup transaction, so a failed replay brings the old rows
    /// back. Otherwise replay skips message events the store already holds.
    pub(crate) fn begin_startup(&self, rebuild: bool) -> Result<()> {
        if rebuild {
            self.replay_floor.store(0, Ordering::Release);
            self.write(|conn| {
                conn.execute_batch(
                    "DELETE FROM messages; DELETE FROM message_versions; \
                     DELETE FROM applied_commit_seq;",
                )
                .map_err(sql_error)
            })
        } else {
            self.replay_floor.store(self.messages_applied_seq(), Ordering::Release);
            Ok(())
        }
    }

    /// Replay validated the whole log up to `seq`: commit everything it
    /// wrote, with `applied_commit_seq = seq`, in one transaction.
    pub(crate) fn commit_startup(&self, seq: u64) -> Result<()> {
        // Opens the transaction if replay wrote nothing, so the row is
        // stored even then.
        self.write(|_| Ok(()))?;
        let mut writer = lock(&self.writer);
        self.commit_locked(&mut writer, seq)?;
        // A rebuild may end below the watermark the discarded rows claimed.
        let stored = read_applied(&writer.conn).map_err(sql_error)?;
        self.messages_applied.store(stored, Ordering::Release);
        self.replay_floor.store(0, Ordering::Release);
        self.shrink_log(&writer);
        Ok(())
    }

    /// Before a projection checkpoint is written at `watermark`: make every
    /// committed row durable and record that the store covers `watermark`.
    /// The caller holds the application lock, so no commit is half applied.
    ///
    /// Ordinary commits do not wait for the disk (`synchronous = NORMAL`): a
    /// power loss may lose the newest ones, never corrupt the file. The
    /// checkpoint must not claim more than the store kept, so this one
    /// transaction is written with `synchronous = FULL`, which syncs the
    /// write-ahead log and with it every commit before it.
    pub(crate) fn sync(&self, watermark: u64) -> Result<()> {
        if self.frozen {
            return Ok(());
        }
        let mut writer = lock(&self.writer);
        if writer.in_transaction {
            if self.file.is_some() {
                // The dispatcher ends every commit before it releases the
                // application lock. An open transaction here is a commit
                // still being applied by a path that does not take that lock
                // (replication ingest). Its rows must not be committed early.
                return Err(WabiError::InternalInvariantViolated {
                    invariant: "projection checkpoint during an unfinished read-model commit"
                        .into(),
                });
            }
            // A bare state has no commit boundaries; its rows are complete.
            self.commit_locked(&mut writer, watermark)?;
        }
        if self.file.is_some() {
            writer.conn.pragma_update(None, "synchronous", "FULL").map_err(sql_error)?;
        }
        let stored = writer
            .conn
            .execute_batch("BEGIN IMMEDIATE")
            .and_then(|()| raise_applied(&writer.conn, watermark))
            .and_then(|()| writer.conn.execute_batch("COMMIT"));
        if self.file.is_some() {
            writer.conn.pragma_update(None, "synchronous", "NORMAL").map_err(sql_error)?;
        }
        if let Err(error) = stored {
            let _ = writer.conn.execute_batch("ROLLBACK");
            return Err(sql_error(error));
        }
        self.messages_applied.fetch_max(watermark, Ordering::AcqRel);
        self.shrink_log(&writer);
        Ok(())
    }

    /// Move the write-ahead log into the database file and empty it. Best
    /// effort: a reader in the middle of a query makes it do less.
    fn shrink_log(&self, writer: &Writer) {
        if self.file.is_some() {
            let _ = writer
                .conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
    }

    /// Every row of `table` in key order.
    pub(crate) fn for_each_row(
        &self,
        table: Table,
        mut f: impl FnMut(&[u8], &[u8]) -> Result<()>,
    ) -> Result<()> {
        // The writer connection: uncommitted rows of a bare state count, as
        // skip-map rows did. A frozen store has no other connection.
        let writer = lock(&self.writer);
        scan(&writer.conn, table, &[], None, false, |key, record| {
            f(key, record)?;
            Ok(true)
        })
    }
}

/// Insert or replace the latest version of a message.
pub(crate) fn put_message(
    conn: &Connection,
    key: &[u8],
    channel_id: &str,
    message_id: &str,
    author_user_id: u64,
    record: &[u8],
) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO messages (key, channel_id, message_id, author_user_id, record) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .and_then(|mut statement| {
        statement.execute(params![key, channel_id, message_id, author_user_id as i64, record])
    })
    .map(drop)
    .map_err(sql_error)
}

/// Insert or replace one event's version of a message.
pub(crate) fn put_version(
    conn: &Connection,
    key: &[u8],
    channel_id: &str,
    message_id: &str,
    record: &[u8],
) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO message_versions (key, channel_id, message_id, record) \
         VALUES (?1, ?2, ?3, ?4)",
    )
    .and_then(|mut statement| statement.execute(params![key, channel_id, message_id, record]))
    .map(drop)
    .map_err(sql_error)
}

/// The record stored under `key`.
pub(crate) fn get(conn: &Connection, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>> {
    let sql = match table {
        Table::Messages => "SELECT record FROM messages WHERE key = ?1",
        Table::MessageVersions => "SELECT record FROM message_versions WHERE key = ?1",
    };
    conn.prepare_cached(sql)
        .and_then(|mut statement| statement.query_row(params![key], |row| row.get(0)).optional())
        .map_err(sql_error)
}

/// Up to two latest rows with this message id, as (channel id, record), so
/// the caller can refuse an id that legacy rooms share.
pub(crate) fn messages_by_id(conn: &Connection, message_id: &str) -> Result<Vec<(String, Vec<u8>)>> {
    conn.prepare_cached("SELECT channel_id, record FROM messages WHERE message_id = ?1 LIMIT 2")
        .and_then(|mut statement| {
            statement
                .query_map(params![message_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .map_err(sql_error)
}

/// Latest rows of one author, shortest message id first, then in byte order
/// (the order of the old author index).
pub(crate) fn messages_by_author(
    conn: &Connection,
    author_user_id: u64,
    mut f: impl FnMut(&[u8]),
) -> Result<()> {
    (|| -> rusqlite::Result<()> {
        let mut statement = conn.prepare_cached(
            "SELECT record FROM messages WHERE author_user_id = ?1 \
             ORDER BY length(CAST(message_id AS BLOB)), CAST(message_id AS BLOB), key",
        )?;
        let mut rows = statement.query(params![author_user_id as i64])?;
        while let Some(row) = rows.next()? {
            f(row.get_ref(0)?.as_blob()?);
        }
        Ok(())
    })()
    .map_err(sql_error)
}

/// Rows with `lower <= key` and, when given, `key < upper`, in key order
/// (`reverse`: highest first), until `f` returns `Ok(false)`.
pub(crate) fn scan(
    conn: &Connection,
    table: Table,
    lower: &[u8],
    upper: Option<&[u8]>,
    reverse: bool,
    mut f: impl FnMut(&[u8], &[u8]) -> Result<bool>,
) -> Result<()> {
    let sql = match (table, upper.is_some(), reverse) {
        (Table::Messages, true, false) => "SELECT key, record FROM messages WHERE key >= ?1 AND key < ?2 ORDER BY key",
        (Table::Messages, true, true) => "SELECT key, record FROM messages WHERE key >= ?1 AND key < ?2 ORDER BY key DESC",
        (Table::Messages, false, false) => "SELECT key, record FROM messages WHERE key >= ?1 ORDER BY key",
        (Table::Messages, false, true) => "SELECT key, record FROM messages WHERE key >= ?1 ORDER BY key DESC",
        (Table::MessageVersions, true, false) => "SELECT key, record FROM message_versions WHERE key >= ?1 AND key < ?2 ORDER BY key",
        (Table::MessageVersions, true, true) => "SELECT key, record FROM message_versions WHERE key >= ?1 AND key < ?2 ORDER BY key DESC",
        (Table::MessageVersions, false, false) => "SELECT key, record FROM message_versions WHERE key >= ?1 ORDER BY key",
        (Table::MessageVersions, false, true) => "SELECT key, record FROM message_versions WHERE key >= ?1 ORDER BY key DESC",
    };
    let mut statement = conn.prepare_cached(sql).map_err(sql_error)?;
    let mut rows = match upper {
        Some(upper) => statement.query(params![lower, upper]),
        None => statement.query(params![lower]),
    }
    .map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let key = row.get_ref(0).and_then(|v| Ok(v.as_blob()?)).map_err(sql_error)?;
        let record = row.get_ref(1).and_then(|v| Ok(v.as_blob()?)).map_err(sql_error)?;
        if !f(key, record)? {
            break;
        }
    }
    Ok(())
}

/// Remove the latest row under `key`. Returns the number of rows removed.
pub(crate) fn delete_message(conn: &Connection, key: &[u8]) -> Result<usize> {
    conn.prepare_cached("DELETE FROM messages WHERE key = ?1")
        .and_then(|mut statement| statement.execute(params![key]))
        .map_err(sql_error)
}

/// Remove every stored version of one message. Returns the number removed.
pub(crate) fn delete_versions(conn: &Connection, channel_id: &str, message_id: &str) -> Result<usize> {
    conn.prepare_cached("DELETE FROM message_versions WHERE channel_id = ?1 AND message_id = ?2")
        .and_then(|mut statement| statement.execute(params![channel_id, message_id]))
        .map_err(sql_error)
}

/// Number of rows in `table`.
#[cfg(test)]
pub(crate) fn count(conn: &Connection, table: Table) -> Result<u64> {
    let sql = match table {
        Table::Messages => "SELECT count(*) FROM messages",
        Table::MessageVersions => "SELECT count(*) FROM message_versions",
    };
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|rows| rows as u64)
        .map_err(sql_error)
}

#[cfg(test)]
mod tests;
