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
//! Waiting. A write can wait on another connection's lock only when a
//! foreign process opened the file for writing (within one engine only the
//! writer connection writes, and the process lock keeps other engines out);
//! it then waits [`BUSY_TIMEOUT`], fails, and the engine halts as for any
//! commit it cannot apply. Reads never wait on a lock of this store.
//!
//! The write-ahead log. SQLite restarts the log only when no reader uses
//! it, so readers that always overlap make it grow by every commit. A real
//! engine under four reading threads grew a 3.7 MB database's log to 110 MB
//! in 3,000 commits. [`ReadModel::trim_log`] bounds it: when the log is above
//! 32 MiB (checked every 16 commits and at every checkpoint) it holds new
//! read statements back for at most 50 ms while the running ones finish, then
//! truncates. The bound it keeps, and what it assumes, are in that function's
//! comment. A read statement is never held more than 50 ms plus one truncate,
//! and a checkpoint never waits for a reader.
//!
//! The gate holds back this store's own readers. **It cannot hold back a
//! reader in another process.** A process that holds a read transaction on the
//! live file (an `sqlite3` shell, a backup tool copying the file) pins the
//! write-ahead log: measured, 344 MiB of log over 8,000 commits and a 118 ms
//! commit every 16 commits, because the truncate then has to wait. Do not open
//! the live read model with other tools. Copy it only with the engine stopped
//! (`docs/deployment/BACKUP_AND_RECOVERY.md`).
//!
//! Damage. When SQLite reports the file as damaged while the engine runs,
//! this store marks itself damaged and leaves a rebuild request. The engine
//! is then no longer healthy, **and it takes no more commands**: the
//! sequencer refuses every command before it is written, as it would after a
//! commit it could not apply, so nothing durable is written that the engine
//! cannot apply. The flag never clears. One read that returns a damage code
//! (including one caused by a bad disk read that would not repeat) means
//! `/readyz` is 503 and writes are refused until the process is restarted;
//! the restart rebuilds the read model from the log if the log is whole, and
//! refuses to start if it is not.
//!
//! No `rusqlite` type leaves this module's crate-private API.

pub(crate) mod schema;

pub use schema::READ_MODEL_GENERATION;
pub(crate) use schema::MAX_COMMIT_SEQ;

use crate::error::{Result, WabiError};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Idle read connections kept for reuse.
const MAX_IDLE_READERS: usize = 16;

/// How long a statement waits for another connection's lock. Within one
/// engine only the writer connection writes and readers never block it (WAL),
/// so this is reached only when another process has the file open.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The write-ahead log is cut back to this size after a checkpoint.
const WAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

/// Above this size the write-ahead log is truncated at the next opportunity
/// (see "The write-ahead log" in the module comment).
const WAL_TRIM_THRESHOLD: u64 = 32 * 1024 * 1024;

/// The longest the read gate is held closed while in-flight reads finish.
const GATE_CAP: Duration = Duration::from_millis(50);

/// The write-ahead log's size is looked at once per this many commits.
const WAL_CHECK_EVERY: u64 = 16;

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
    Channels,
}

impl Table {
    pub(crate) const ALL: [Table; 3] = [Table::Messages, Table::MessageVersions, Table::Channels];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Table::Messages => "messages",
            Table::MessageVersions => "message_versions",
            Table::Channels => "channels",
        }
    }
}

struct Writer {
    conn: Connection,
    /// A transaction is open and holds uncommitted rows.
    in_transaction: bool,
}

#[derive(Default)]
struct GateState {
    readers: usize,
    closed: bool,
}

/// Lets the writer wait, for a bounded time, for the read statements that
/// are running to finish, and holds new ones back meanwhile. Reads never
/// wait on it otherwise.
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

struct GateGuard<'a>(&'a Gate);

impl Gate {
    fn enter(&self) -> GateGuard<'_> {
        let mut state = lock(&self.state);
        while state.closed {
            state = self.changed.wait(state).unwrap_or_else(|p| p.into_inner());
        }
        state.readers += 1;
        GateGuard(self)
    }

    /// Close the gate and wait up to `cap` for the running reads. `Some`: it
    /// drained and the gate stays closed until the returned guard is dropped,
    /// also by a panic. `None`: it did not, and the gate is open again.
    fn close_and_drain(&self, cap: Duration) -> Option<ClosedGate<'_>> {
        let deadline = Instant::now() + cap;
        let mut state = lock(&self.state);
        state.closed = true;
        while state.readers > 0 {
            let now = Instant::now();
            if now >= deadline {
                state.closed = false;
                self.changed.notify_all();
                return None;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        Some(ClosedGate(self))
    }

    fn open(&self) {
        lock(&self.state).closed = false;
        self.changed.notify_all();
    }
}

/// Keeps the gate closed. Dropping it, also while unwinding from a panic,
/// opens the gate again: a gate left closed would make every read wait
/// forever, including the sequencer's admission lookups, so the engine would
/// hang instead of halting.
struct ClosedGate<'a>(&'a Gate);

impl Drop for ClosedGate<'_> {
    fn drop(&mut self) {
        self.0.open();
    }
}

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.0.state);
        state.readers -= 1;
        if state.readers == 0 {
            self.0.changed.notify_all();
        }
    }
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
    /// Committed `applied_commit_seq` of the projections stored here (the
    /// lowest of their rows; they are written together).
    messages_applied: AtomicU64,
    /// During startup replay: events of the projections stored here at or
    /// below this commit are already stored and must not be applied again.
    /// Zero otherwise.
    replay_floor: AtomicU64,
    /// SQLite reported the file as damaged while the engine was running.
    damaged: AtomicBool,
    /// Read statements of a file store run inside this gate.
    gate: Gate,
    /// Size above which the write-ahead log is trimmed.
    wal_threshold: AtomicU64,
    /// Commits since the write-ahead log was last measured.
    commits_since_wal_check: AtomicU64,
    /// Test hook: panic inside the trim while the gate is closed.
    #[cfg(test)]
    panic_in_trim: AtomicBool,
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
    /// A file the engine would replace and rebuild from the log, with the
    /// `applied_commit_seq` it claims (zero when unreadable).
    Replaced(String, u64),
    /// Something at the read model's path, or its rebuild request, that makes
    /// the engine refuse to start (not a regular file).
    Refused(String),
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

/// The lowest `applied_commit_seq` of the projections stored here; a missing
/// row counts as zero. Every commit writes all the rows in one transaction,
/// so they differ only in a file this build did not write, and the lowest is
/// what all of them are known to cover.
fn read_applied(conn: &Connection) -> rusqlite::Result<u64> {
    let mut lowest = u64::MAX;
    for projection in schema::PROJECTIONS {
        let seq = conn
            .query_row(
                "SELECT seq FROM applied_commit_seq WHERE projection = ?1",
                params![projection],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map_or(Ok(0), |seq| {
                // A value outside what a commit number can be is damage.
                u64::try_from(seq)
                    .ok()
                    .filter(|seq| *seq <= schema::MAX_COMMIT_SEQ)
                    .ok_or(rusqlite::Error::IntegralValueOutOfRange(0, seq))
            })?;
        lowest = lowest.min(seq);
    }
    Ok(lowest)
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
    let mut statement = conn.prepare_cached(
        "INSERT INTO applied_commit_seq (projection, seq) VALUES (?1, ?2) \
         ON CONFLICT (projection) DO UPDATE SET seq = max(seq, excluded.seq)",
    )?;
    for projection in schema::PROJECTIONS {
        statement.execute(params![projection, seq as i64])?;
    }
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

enum Classified {
    Missing,
    /// The engine would serve the file, but a read-only look cannot verify it.
    Unverifiable(String),
    /// The state, and the connection when the file is usable.
    State(FileState, Option<Connection>),
}

/// What the read-only `check` and `verify` commands found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Peek {
    State(FileState),
    /// The engine refuses to start on it.
    Refuses(String),
    /// A read-only look cannot judge it; the engine examines it at start.
    NotExamined(String),
}

/// Make a directory's entries durable. A no-op where a directory cannot be
/// opened for this (Windows).
pub(crate) fn sync_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
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

    fn from_parts(
        file: Option<PathBuf>,
        data_dir: Option<PathBuf>,
        frozen: bool,
        conn: Connection,
        applied: u64,
    ) -> Self {
        Self {
            file,
            data_dir,
            frozen,
            writer: Mutex::new(Writer { conn, in_transaction: false }),
            readers: Mutex::new(Vec::new()),
            messages_applied: AtomicU64::new(applied),
            replay_floor: AtomicU64::new(0),
            damaged: AtomicBool::new(false),
            gate: Gate::default(),
            wal_threshold: AtomicU64::new(WAL_TRIM_THRESHOLD),
            commits_since_wal_check: AtomicU64::new(0),
            #[cfg(test)]
            panic_in_trim: AtomicBool::new(false),
        }
    }

    /// A store that lives only as long as this value.
    pub(crate) fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("open in-memory read model");
        create_tables(&conn, READ_MODEL_GENERATION).expect("create in-memory read model");
        Self::from_parts(None, None, false, conn, 0)
    }

    /// A file whose presence asks the next start to rebuild the read model.
    /// Written when SQLite reports damage at run time and by
    /// `wabidb-cli quarantine`. Its text is the reason.
    pub(crate) fn rebuild_marker(data_dir: &Path) -> PathBuf {
        data_dir.join("projections").join("read-model.rebuild")
    }

    /// The reason in the rebuild request, `None` when there is none. A
    /// request that is not a regular file is an error: ignoring it could
    /// skip a rebuild somebody asked for, so the engine refuses instead.
    pub(crate) fn rebuild_request(data_dir: &Path) -> Result<Option<String>> {
        let marker = Self::rebuild_marker(data_dir);
        match std::fs::symlink_metadata(&marker) {
            Ok(metadata) if metadata.is_file() => {
                let bytes = std::fs::read(&marker)?;
                Ok(Some(String::from_utf8_lossy(&bytes).trim().to_string()))
            }
            Ok(_) => Err(WabiError::Corrupt {
                location: marker.display().to_string(),
                detail: "the rebuild request is not a regular file; remove it, or restore \
                         the data directory from a backup"
                    .into(),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Ask the next start to replace the read model and fill it from the
    /// log. Nothing is deleted here: the engine decides at startup, when it
    /// knows whether the log still covers what the file holds. The request
    /// is durable when this returns: file synced through a writable handle,
    /// then its directory.
    pub(crate) fn request_rebuild(data_dir: &Path, reason: &str) -> Result<()> {
        use std::io::Write;
        let marker = Self::rebuild_marker(data_dir);
        let parent = marker.parent().expect("the marker has a parent");
        std::fs::create_dir_all(parent)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&marker)?;
        file.write_all(reason.as_bytes())?;
        file.sync_all()?;
        drop(file);
        sync_dir(parent)?;
        Ok(())
    }

    /// Remove a rebuild request that has nothing left to rebuild.
    fn clear_rebuild_request(data_dir: &Path) -> Result<()> {
        let marker = Self::rebuild_marker(data_dir);
        match std::fs::remove_file(&marker) {
            Ok(()) => sync_dir(marker.parent().expect("the marker has a parent"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
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
    ///
    /// **Writes nothing to the database or its write-ahead log.** A read-write
    /// connection folds the log into the file when it closes, which would
    /// change a directory the engine then refuses to start on. This one is
    /// read-only: immutable when there is no log to read, so that it creates
    /// no file, and an ordinary read-only connection when the log holds
    /// frames, which then touches only the `-shm` index file (it holds
    /// nothing that is not rebuilt from the log).
    pub(crate) fn probe_as_generation(data_dir: &Path, generation: i64) -> Result<FileState> {
        match Self::classify(data_dir, generation, false)? {
            Classified::Missing => Ok(FileState::Missing),
            Classified::State(state, _) => Ok(state),
            Classified::Unverifiable(reason) => Err(WabiError::Corrupt {
                location: Self::path(data_dir).display().to_string(),
                detail: reason,
            }),
        }
    }

    fn classify(data_dir: &Path, generation: i64, frozen: bool) -> Result<Classified> {
        let marker = Self::rebuild_request(data_dir)?;
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
                return Ok(Classified::Missing)
            }
            Err(error) => return Err(error.into()),
        }
        let wal_frames = std::fs::metadata(sidecar(&path, "-wal")).is_ok_and(|wal| wal.len() > 0);
        if frozen && wal_frames {
            // The engine recovers a write-ahead log that holds frames and
            // then serves what it holds. An immutable open cannot see them,
            // and an ordinary open would change the directory.
            return Ok(Classified::Unverifiable(
                "its write-ahead log still holds frames (the engine did not stop cleanly, \
                 or the files were copied while it ran)"
                    .into(),
            ));
        }
        let opened = if wal_frames {
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        } else {
            let Some(uri) = file_uri(&path) else {
                return Ok(Classified::Unverifiable("its path is not valid UTF-8".into()));
            };
            Connection::open_with_flags(
                format!("{uri}?immutable=1"),
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
        };
        let unreadable = |error: rusqlite::Error, applied| {
            Ok(Classified::State(
                FileState::Unusable { reason: format!("it cannot be read: {error}"), applied },
                None,
            ))
        };
        let conn = match opened {
            Ok(conn) => conn,
            Err(error) => return unreadable(error, 0),
        };
        let _ = conn.busy_timeout(BUSY_TIMEOUT);
        let (meta, applied) = match (read_meta(&conn), read_applied(&conn)) {
            (Ok(meta), Ok(applied)) => (meta, applied),
            (Err(error), _) | (_, Err(error)) => return unreadable(error, 0),
        };
        let unusable = |reason: String| {
            Ok(Classified::State(FileState::Unusable { reason, applied }, None))
        };
        if let Some(reason) = marker {
            return unusable(format!("a rebuild was requested: {reason}"));
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
        // Stricter for inspection: integrity_check also compares every index
        // with its table, which the engine's lookups depend on.
        let pragma = if frozen { "PRAGMA integrity_check(1)" } else { "PRAGMA quick_check(1)" };
        match conn.query_row(pragma, [], |row| row.get::<_, String>(0)) {
            Ok(result) if result == "ok" => {
                Ok(Classified::State(FileState::Usable { applied }, Some(conn)))
            }
            Ok(result) if frozen => {
                Ok(Classified::Unverifiable(format!("integrity check failed: {result}")))
            }
            Err(error) if frozen => {
                Ok(Classified::Unverifiable(format!("integrity check failed: {error}")))
            }
            Ok(result) => unusable(format!("consistency check failed: {result}")),
            Err(error) => unusable(format!("consistency check failed: {error}")),
        }
    }

    /// [`Self::probe`] for the lock-free, read-only `check` and `verify`
    /// commands: nothing is created or changed.
    pub(crate) fn peek(data_dir: &Path) -> Peek {
        match Self::open_frozen(data_dir) {
            Frozen::Missing => Peek::State(FileState::Missing),
            Frozen::Usable(model) => {
                Peek::State(FileState::Usable { applied: model.messages_applied_seq() })
            }
            Frozen::Replaced(reason, applied) => {
                Peek::State(FileState::Unusable { reason, applied })
            }
            Frozen::Refused(reason) => Peek::Refuses(reason),
            Frozen::Unverifiable(reason) => Peek::NotExamined(reason),
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
        if !existed {
            // A request left beside a file that is gone (a crash between the
            // two removals) has nothing to rebuild: the file is new and is
            // filled from the log anyway.
            Self::clear_rebuild_request(data_dir)?;
        }
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
                Ok(Self::from_parts(
                    Some(path),
                    Some(data_dir.to_path_buf()),
                    false,
                    conn,
                    applied,
                ))
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
        match Self::classify(data_dir, READ_MODEL_GENERATION, true) {
            Err(error) => Frozen::Refused(error.to_string()),
            Ok(Classified::Missing) => Frozen::Missing,
            Ok(Classified::Unverifiable(reason)) => Frozen::Unverifiable(reason),
            Ok(Classified::State(FileState::Missing, _)) => Frozen::Missing,
            Ok(Classified::State(FileState::Unusable { reason, applied }, _)) => {
                Frozen::Replaced(reason, applied)
            }
            Ok(Classified::State(FileState::Usable { applied }, Some(conn))) => {
                Frozen::Usable(Self::from_parts(None, None, true, conn, applied))
            }
            Ok(Classified::State(FileState::Usable { .. }, None)) => {
                Frozen::Unverifiable("the connection was not kept".into())
            }
        }
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

    /// The committed `applied_commit_seq` of the read model: every event of
    /// every commit up to it that a projection stored here handles (messages,
    /// channels) is stored.
    pub(crate) fn messages_applied_seq(&self) -> u64 {
        self.messages_applied.load(Ordering::Acquire)
    }

    /// Events of the projections stored here at or below this commit are
    /// already stored (startup replay only; zero otherwise).
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
        // Held until the statements are done: see "The write-ahead log".
        let _running = self.gate.enter();
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
        if self.file.is_some()
            && self.commits_since_wal_check.fetch_add(1, Ordering::Relaxed) % WAL_CHECK_EVERY == 0
        {
            self.trim_log(writer);
        }
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
    /// back. Otherwise replay skips the events the store already holds.
    pub(crate) fn begin_startup(&self, rebuild: bool) -> Result<()> {
        if rebuild {
            self.replay_floor.store(0, Ordering::Release);
            self.write(|conn| {
                conn.execute_batch(
                    "DELETE FROM messages; DELETE FROM message_versions; \
                     DELETE FROM channels; DELETE FROM applied_commit_seq;",
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
    /// rebuilds the read model from the log.
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
        // Fold the log into the file as far as readers allow, and keep it
        // bounded. Neither waits for a reader longer than `GATE_CAP`, so a
        // read cannot stall the checkpoint, which runs under the application
        // lock. Durability does not depend on it.
        if self.file.is_some() {
            let _ = writer.conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()));
            self.trim_log(&writer);
        }
        Ok(())
    }

    /// Keep the write-ahead log from growing without bound while reads
    /// overlap. SQLite can restart the log only when no reader is using it,
    /// and readers that always overlap never leave that moment, so the log
    /// would grow by every commit, for as long as the load lasts.
    ///
    /// When the log is above the threshold: copy what the readers' marks
    /// allow (`PASSIVE`, never waits); hold new read statements for at most
    /// [`GATE_CAP`] while the running ones finish; then `TRUNCATE`, which has
    /// almost nothing left to copy and nothing to wait for; then let the
    /// readers go. If the running statements do not finish within the cap,
    /// the gate opens again and the next attempt is one `WAL_CHECK_EVERY`
    /// commits away.
    ///
    /// **Bound.** A read statement is never held longer than `GATE_CAP` plus
    /// the time of one `TRUNCATE` (a sync of what the readers had pinned). The
    /// log stays below the threshold plus `WAL_CHECK_EVERY` commits of growth
    /// as long as the statements that are running when the gate closes finish
    /// within `GATE_CAP`, which is true of every read the engine makes except
    /// the unfiltered full scan of `MessagesProjection::query`. While such a
    /// scan keeps overlapping, the log can exceed the threshold.
    fn trim_log(&self, writer: &Writer) {
        let Some(path) = &self.file else { return };
        let size = std::fs::metadata(sidecar(path, "-wal")).map_or(0, |wal| wal.len());
        if size <= self.wal_threshold.load(Ordering::Relaxed) {
            return;
        }
        let _ = writer.conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()));
        let Some(_closed) = self.gate.close_and_drain(GATE_CAP) else {
            tracing::debug!("write-ahead log is {size} bytes; reads did not finish in time");
            return;
        };
        #[cfg(test)]
        if self.panic_in_trim.load(Ordering::Relaxed) {
            panic!("injected panic with the read gate closed");
        }
        // No read statement is running and none can start: nothing to wait for.
        let _ = writer.conn.busy_timeout(Duration::from_millis(100));
        let result = writer.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        let _ = writer.conn.busy_timeout(BUSY_TIMEOUT);
        drop(_closed);
        if let Err(error) = result {
            tracing::debug!("write-ahead log truncate failed: {error}");
        }
    }

    /// Test hook: make the next trim panic with the gate closed.
    #[cfg(test)]
    pub(crate) fn panic_in_next_trim_for_tests(&self) {
        self.panic_in_trim.store(true, Ordering::Relaxed);
    }

    /// Test hook: the size above which the log is trimmed.
    #[cfg(test)]
    pub(crate) fn set_wal_threshold_for_tests(&self, bytes: u64) {
        self.wal_threshold.store(bytes, Ordering::Relaxed);
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
        // The record is always the last column.
        let sql = match table {
            Table::Messages => {
                "SELECT key, CAST(channel_id AS BLOB), CAST(message_id AS BLOB), \
                 author_user_id, record FROM messages ORDER BY key"
            }
            Table::MessageVersions => {
                "SELECT key, CAST(channel_id AS BLOB), CAST(message_id AS BLOB), \
                 0, record FROM message_versions ORDER BY key"
            }
            Table::Channels => "SELECT key, record FROM channels ORDER BY key",
        };
        self.watching_for_damage(|| {
            let mut statement = writer.conn.prepare_cached(sql).map_err(sql_error)?;
            let width = statement.column_count();
            let mut rows = statement.query([]).map_err(sql_error)?;
            while let Some(row) = rows.next().map_err(sql_error)? {
                // An integer column (the author) is passed as its 8
                // little-endian bytes, every other column as its blob.
                let mut columns = Vec::with_capacity(width);
                for index in 0..width {
                    columns.push(match row.get_ref(index).map_err(sql_error)? {
                        rusqlite::types::ValueRef::Integer(value) => value.to_le_bytes().to_vec(),
                        value => value.as_blob().map_err(|e| sql_error(e.into()))?.to_vec(),
                    });
                }
                f(&columns.iter().map(Vec::as_slice).collect::<Vec<_>>())?;
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
        Table::Channels => "SELECT record FROM channels WHERE key = ?1",
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
        (Table::Channels, true, false) => "SELECT key, record FROM channels WHERE key >= ?1 AND key < ?2 ORDER BY key",
        (Table::Channels, true, true) => "SELECT key, record FROM channels WHERE key >= ?1 AND key < ?2 ORDER BY key DESC",
        (Table::Channels, false, false) => "SELECT key, record FROM channels WHERE key >= ?1 ORDER BY key",
        (Table::Channels, false, true) => "SELECT key, record FROM channels WHERE key >= ?1 ORDER BY key DESC",
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

/// Insert or replace a channel.
pub(crate) fn put_channel(conn: &Connection, key: &[u8], record: &[u8]) -> Result<()> {
    conn.prepare_cached("INSERT OR REPLACE INTO channels (key, record) VALUES (?1, ?2)")
        .and_then(|mut statement| statement.execute(params![key, record]))
        .map(drop)
        .map_err(sql_error)
}

/// Remove a channel. Returns the number of rows removed.
pub(crate) fn delete_channel(conn: &Connection, key: &[u8]) -> Result<usize> {
    conn.prepare_cached("DELETE FROM channels WHERE key = ?1")
        .and_then(|mut statement| statement.execute(params![key]))
        .map_err(sql_error)
}

/// Number of rows in `table`.
#[cfg(test)]
pub(crate) fn count(conn: &Connection, table: Table) -> Result<u64> {
    let sql = match table {
        Table::Messages => "SELECT count(*) FROM messages",
        Table::MessageVersions => "SELECT count(*) FROM message_versions",
        Table::Channels => "SELECT count(*) FROM channels",
    };
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|rows| rows as u64)
        .map_err(sql_error)
}

#[cfg(test)]
mod tests;
