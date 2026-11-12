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
//! Waiting. Two things here could wait on another connection's lock while
//! the caller holds the engine's application lock:
//! - a write, when another connection holds the write lock. Within one
//!   engine only the writer connection writes, and the engine's process lock
//!   keeps other engines out, so only a foreign process that opens the file
//!   for writing can cause it. The write then waits [`BUSY_TIMEOUT`], fails,
//!   and the engine halts as for any commit it cannot apply.
//! - a checkpoint of the write-ahead log, which waits for readers if asked
//!   to truncate. This store's own pooled readers could cause that, so the
//!   checkpoint taken at a projection checkpoint is `PASSIVE`, which never
//!   waits. Only the one after startup replay truncates, before any reader
//!   exists.
//!
//! No `rusqlite` type leaves this module's crate-private API.

pub(crate) mod schema;

pub use schema::READ_MODEL_GENERATION;

use crate::error::{Result, WabiError};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// Idle read connections kept for reuse.
const MAX_IDLE_READERS: usize = 16;

/// How long a statement waits for another connection's lock. Within one
/// engine only the writer connection writes and readers never block it (WAL),
/// so this is reached only when another process has the file open.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The write-ahead log is cut back to this size after a checkpoint.
const WAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

thread_local! {
    /// Set when SQLite reports the database file itself as damaged, so the
    /// store that ran the statement can stop calling itself healthy.
    static SAW_DAMAGE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn is_damage(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    )
}

fn sql_error(error: rusqlite::Error) -> WabiError {
    if is_damage(&error) {
        SAW_DAMAGE.with(|flag| flag.set(true));
    }
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
    /// The engine directory of a file store.
    data_dir: Option<PathBuf>,
    /// Opened for offline inspection: never written.
    frozen: bool,
    writer: Mutex<Writer>,
    readers: Mutex<Vec<Connection>>,
    /// Committed `applied_commit_seq` of the messages projection.
    messages_applied: AtomicU64,
    /// During startup replay: message events at or below this commit are
    /// already stored and must not be applied again. Zero otherwise.
    replay_floor: AtomicU64,
    /// SQLite reported the file as damaged while the engine was running.
    damaged: AtomicBool,
}

/// What is on disk where an engine keeps its read model.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FileState {
    /// No file. The engine creates one and fills it from the log.
    Missing,
    /// A file this build can use as it is.
    Usable { applied: u64 },
    /// A file this build must not read from: another schema version or
    /// generation, a failed consistency check, or a rebuild request. The
    /// engine replaces it and fills the new one from the log. `applied` is
    /// the `applied_commit_seq` the file claims, zero when it cannot be read.
    Unusable { reason: String, applied: u64 },
}

/// What offline inspection found where the read model would be.
pub(crate) enum Frozen {
    /// No file.
    Missing,
    /// A file the engine would use as it is, opened without changing it.
    Usable(ReadModel),
    /// A file the engine would replace and rebuild from the log.
    Replaced(String),
    /// A file the engine would use, but whose content cannot be read without
    /// changing the directory, or does not pass a full integrity check.
    Unverifiable(String),
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
        for file in [
            sidecar(&path, "-wal"),
            sidecar(&path, "-shm"),
            path,
            Self::rebuild_marker(data_dir),
        ] {
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
            damaged: AtomicBool::new(false),
            data_dir: None,
        }
    }

    /// A file whose presence asks the next start to rebuild the read model.
    /// Written when SQLite reports damage at run time and by
    /// `wabidb-cli quarantine`. Its text is the reason.
    pub(crate) fn rebuild_marker(data_dir: &Path) -> PathBuf {
        data_dir.join("projections").join("read-model.rebuild")
    }

    /// Ask the next start to replace the read model and fill it from the
    /// log. Nothing is deleted here: the engine decides at startup, when it
    /// knows whether the log still covers what the file holds.
    pub(crate) fn request_rebuild(data_dir: &Path, reason: &str) -> Result<()> {
        let marker = Self::rebuild_marker(data_dir);
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&marker, reason)?;
        std::fs::File::open(&marker)?.sync_all()?;
        Ok(())
    }

    /// Look at the read model of a stopped engine without replacing it.
    pub(crate) fn probe(data_dir: &Path) -> Result<FileState> {
        Self::probe_as_generation(data_dir, READ_MODEL_GENERATION)
    }

    /// [`Self::probe`] for a build whose generation is `generation`.
    ///
    /// Runs `PRAGMA quick_check`, which reads the whole file: opening only
    /// the version row would accept a file whose pages are damaged, and every
    /// later read and every message write would then fail.
    pub(crate) fn probe_as_generation(data_dir: &Path, generation: i64) -> Result<FileState> {
        let path = Self::path(data_dir);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(WabiError::Corrupt {
                    location: path.display().to_string(),
                    detail: "projection read model is not a regular file".into(),
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileState::Missing)
            }
            Err(error) => return Err(error.into()),
        }
        let opened = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .and_then(|conn| {
                conn.busy_timeout(BUSY_TIMEOUT)?;
                let meta = read_meta(&conn)?;
                let applied = read_applied(&conn)?;
                Ok((conn, meta, applied))
            });
        let (conn, meta, applied) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                return Ok(FileState::Unusable {
                    reason: format!("it cannot be read: {error}"),
                    applied: 0,
                })
            }
        };
        let unusable = |reason: String| Ok(FileState::Unusable { reason, applied });
        if let Ok(reason) = std::fs::read_to_string(Self::rebuild_marker(data_dir)) {
            return unusable(format!("a rebuild was requested: {}", reason.trim()));
        }
        match meta {
            Some((schema_version, stored))
                if schema_version == schema::SCHEMA_VERSION && stored == generation => {}
            Some((schema_version, stored)) => {
                return unusable(format!(
                    "schema version {schema_version} generation {stored}, this build has \
                     schema version {} generation {generation}",
                    schema::SCHEMA_VERSION
                ))
            }
            None => return unusable("it has no version row".into()),
        }
        let check: rusqlite::Result<String> =
            conn.query_row("PRAGMA quick_check(1)", [], |row| row.get(0));
        match check {
            Ok(result) if result == "ok" => Ok(FileState::Usable { applied }),
            Ok(result) => unusable(format!("consistency check failed: {result}")),
            Err(error) => unusable(format!("consistency check failed: {error}")),
        }
    }

    /// [`Self::probe`] for the lock-free, read-only `check` and `verify`
    /// commands: nothing is created or changed. `Err` with the reason when
    /// the file cannot be judged that way (its write-ahead log still holds
    /// frames, or it fails the integrity check).
    pub(crate) fn peek(data_dir: &Path) -> std::result::Result<FileState, String> {
        match Self::open_frozen(data_dir) {
            Frozen::Missing => Ok(FileState::Missing),
            Frozen::Usable(model) => Ok(FileState::Usable { applied: model.messages_applied_seq() }),
            Frozen::Replaced(reason) => Ok(FileState::Unusable { reason, applied: 0 }),
            Frozen::Unverifiable(reason) => Err(reason),
        }
    }

    /// Open the engine's read model: the file [`Self::probe`] called usable,
    /// or a new empty one when there is none.
    pub(crate) fn open(data_dir: &Path) -> Result<Self> {
        Self::open_as_generation(data_dir, READ_MODEL_GENERATION)
    }

    /// Delete the read model and create an empty one at commit zero. Only
    /// for a file the engine decided to rebuild from the log.
    pub(crate) fn recreate(data_dir: &Path) -> Result<Self> {
        Self::recreate_as_generation(data_dir, READ_MODEL_GENERATION)
    }

    pub(crate) fn recreate_as_generation(data_dir: &Path, generation: i64) -> Result<Self> {
        Self::remove_files(data_dir)?;
        Self::open_as_generation(data_dir, generation)
    }

    /// [`Self::open`] for a build whose generation is `generation`.
    pub(crate) fn open_as_generation(data_dir: &Path, generation: i64) -> Result<Self> {
        let path = Self::path(data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existed = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(WabiError::Corrupt {
                    location: path.display().to_string(),
                    detail: "projection read model is not a regular file".into(),
                });
            }
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        make_private(&path)?;
        let opened = Connection::open(&path).and_then(|conn| {
            conn.busy_timeout(BUSY_TIMEOUT)?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "journal_size_limit", WAL_SIZE_LIMIT)?;
            if !existed {
                create_tables(&conn, generation)?;
            }
            let meta = read_meta(&conn)?;
            let applied = read_applied(&conn)?;
            Ok((conn, meta, applied))
        });
        match opened {
            Ok((conn, Some(meta), applied)) if meta == (schema::SCHEMA_VERSION, generation) => {
                Ok(Self {
                    file: Some(path),
                    data_dir: Some(data_dir.to_path_buf()),
                    frozen: false,
                    writer: Mutex::new(Writer { conn, in_transaction: false }),
                    readers: Mutex::new(Vec::new()),
                    messages_applied: AtomicU64::new(applied),
                    replay_floor: AtomicU64::new(0),
                    damaged: AtomicBool::new(false),
                })
            }
            Ok(_) => Err(WabiError::Corrupt {
                location: path.display().to_string(),
                detail: "projection read model is not this build's; it must be rebuilt".into(),
            }),
            Err(error) => Err(WabiError::Corrupt {
                location: path.display().to_string(),
                detail: format!("projection read model cannot be opened: {error}"),
            }),
        }
    }

    /// Open a stopped engine's read model for offline inspection, without
    /// creating or changing any file.
    pub(crate) fn open_frozen(data_dir: &Path) -> Frozen {
        let path = Self::path(data_dir);
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            return Frozen::Missing;
        };
        if !metadata.is_file() {
            return Frozen::Unverifiable("it is not a regular file".into());
        }
        // The engine recovers a write-ahead log that still holds frames and
        // then serves what it holds. An immutable open cannot see those
        // frames, and an ordinary open would change the directory.
        if std::fs::metadata(sidecar(&path, "-wal")).is_ok_and(|wal| wal.len() > 0) {
            return Frozen::Unverifiable(
                "its write-ahead log still holds frames (the engine did not stop cleanly, \
                 or the files were copied while it ran)"
                    .into(),
            );
        }
        if let Ok(reason) = std::fs::read_to_string(Self::rebuild_marker(data_dir)) {
            return Frozen::Replaced(format!("a rebuild was requested: {}", reason.trim()));
        }
        let Some(uri) = file_uri(&path) else {
            return Frozen::Unverifiable("its path is not valid UTF-8".into());
        };
        let conn = match Connection::open_with_flags(
            format!("{uri}?immutable=1"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        ) {
            Ok(conn) => conn,
            Err(error) => return Frozen::Replaced(format!("it cannot be read: {error}")),
        };
        match read_meta(&conn) {
            Ok(Some(meta)) if meta == (schema::SCHEMA_VERSION, READ_MODEL_GENERATION) => {}
            Ok(_) => return Frozen::Replaced("another schema version or generation".into()),
            Err(error) => return Frozen::Replaced(format!("it cannot be read: {error}")),
        }
        // Stricter than the engine's check at open: this one also compares
        // every index with its table, which the engine's lookups depend on.
        let check: rusqlite::Result<String> =
            conn.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0));
        match check {
            Ok(result) if result == "ok" => {}
            Ok(result) => return Frozen::Unverifiable(format!("integrity check failed: {result}")),
            Err(error) => return Frozen::Unverifiable(format!("integrity check failed: {error}")),
        }
        let applied = match read_applied(&conn) {
            Ok(applied) => applied,
            Err(error) => return Frozen::Unverifiable(format!("it cannot be read: {error}")),
        };
        Frozen::Usable(Self {
            file: None,
            data_dir: None,
            frozen: true,
            writer: Mutex::new(Writer { conn, in_transaction: false }),
            readers: Mutex::new(Vec::new()),
            messages_applied: AtomicU64::new(applied),
            replay_floor: AtomicU64::new(0),
            damaged: AtomicBool::new(false),
        })
    }

    /// SQLite reported the file as damaged since this store was opened.
    pub(crate) fn is_damaged(&self) -> bool {
        self.damaged.load(Ordering::Acquire)
    }

    /// Run `f`; if SQLite called the file damaged while it ran, remember it
    /// and ask the next start to rebuild.
    fn watching_for_damage<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        SAW_DAMAGE.with(|flag| flag.set(false));
        let result = f();
        if SAW_DAMAGE.with(|flag| flag.replace(false)) && !self.damaged.swap(true, Ordering::AcqRel) {
            tracing::error!(
                "projection read model is damaged; the engine is no longer healthy and the \
                 next start rebuilds it from the log"
            );
            if let Some(data_dir) = &self.data_dir {
                if let Err(error) = Self::request_rebuild(data_dir, "SQLite reported damage at run time") {
                    tracing::error!("could not record the rebuild request: {error}");
                }
            }
        }
        result
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
        self.watching_for_damage(|| {
            if !writer.in_transaction {
                writer.conn.execute_batch("BEGIN IMMEDIATE").map_err(sql_error)?;
                writer.in_transaction = true;
            }
            f(&writer.conn)
        })
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
                conn.busy_timeout(BUSY_TIMEOUT).map_err(sql_error)?;
                conn
            }
        };
        let result = self.watching_for_damage(|| f(&conn));
        let mut readers = lock(&self.readers);
        if readers.len() < MAX_IDLE_READERS {
            readers.push(conn);
        }
        result
    }

    fn commit_locked(&self, writer: &mut Writer, seq: u64) -> Result<()> {
        self.watching_for_damage(|| {
            raise_applied(&writer.conn, seq).map_err(sql_error)?;
            writer.conn.execute_batch("COMMIT").map_err(sql_error)
        })?;
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
    /// checkpoint must not claim more than the store kept, so one transaction
    /// is written here with `synchronous = FULL`. SQLite then syncs the
    /// write-ahead log when it commits, and with it every earlier commit.
    /// The transaction also bumps a counter, because SQLite writes nothing,
    /// and so syncs nothing, for an update that changes no byte.
    ///
    /// If the sync is lost all the same (a disk that lies about it), a power
    /// cut leaves the read model behind the snapshot, and the next start
    /// rebuilds every projection from the log.
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
        let stored = self.watching_for_damage(|| {
            writer
                .conn
                .execute_batch(
                    "BEGIN IMMEDIATE; UPDATE read_model_meta SET sync_count = sync_count + 1;",
                )
                .and_then(|()| raise_applied(&writer.conn, watermark))
                .and_then(|()| writer.conn.execute_batch("COMMIT"))
                .map_err(sql_error)
        });
        if self.file.is_some() {
            writer.conn.pragma_update(None, "synchronous", "NORMAL").map_err(sql_error)?;
        }
        if let Err(error) = stored {
            let _ = writer.conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        self.messages_applied.fetch_max(watermark, Ordering::AcqRel);
        // Fold the log into the file as far as readers allow. PASSIVE never
        // waits for a reader, so a long read cannot stall the checkpoint,
        // which runs under the application lock. Durability does not depend
        // on it.
        if self.file.is_some() {
            let _ = writer.conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()));
        }
        Ok(())
    }

    /// Move the write-ahead log into the database file and empty it. Only
    /// used at startup, when this store has no reader yet.
    fn shrink_log(&self, writer: &Writer) {
        if self.file.is_some() {
            let _ = writer
                .conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
    }

    /// Every row of `table` in key order, with every column the engine
    /// reads: the key, the columns its lookups use, and the record.
    pub(crate) fn for_each_full_row(
        &self,
        table: Table,
        mut f: impl FnMut(&[&[u8]]) -> Result<()>,
    ) -> Result<()> {
        let writer = lock(&self.writer);
        let sql = match table {
            Table::Messages => {
                "SELECT key, CAST(channel_id AS BLOB), CAST(message_id AS BLOB), \
                 author_user_id, record FROM messages ORDER BY key"
            }
            Table::MessageVersions => {
                "SELECT key, CAST(channel_id AS BLOB), CAST(message_id AS BLOB), \
                 0, record FROM message_versions ORDER BY key"
            }
        };
        self.watching_for_damage(|| {
            let mut statement = writer.conn.prepare_cached(sql).map_err(sql_error)?;
            let mut rows = statement.query([]).map_err(sql_error)?;
            while let Some(row) = rows.next().map_err(sql_error)? {
                let blob = |index| row.get_ref(index).and_then(|v| Ok(v.as_blob()?)).map_err(sql_error);
                let author: i64 = row.get(3).map_err(sql_error)?;
                f(&[blob(0)?, blob(1)?, blob(2)?, &author.to_le_bytes(), blob(4)?])?;
            }
            Ok(())
        })
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
