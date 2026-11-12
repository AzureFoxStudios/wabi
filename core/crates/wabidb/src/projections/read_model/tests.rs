use super::*;

fn put(model: &ReadModel, key: &[u8], body: &[u8]) {
    model
        .write(|conn| {
            put_message(conn, key, "ch", "id", 1, body)?;
            put_version(conn, key, "ch", "id", body)
        })
        .unwrap();
}

fn rows(model: &ReadModel) -> u64 {
    model.read(|conn| count(conn, Table::Messages)).unwrap()
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// The read model holds message bodies as the snapshot does, so only its
/// owner may read it. SQLite gives its side files the same mode.
#[cfg(unix)]
#[test]
fn the_file_and_its_write_ahead_log_are_created_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(1).unwrap();
    let path = ReadModel::path(dir.path());
    println!("{:o} {}", mode(&path), path.display());
    assert_eq!(mode(&path), 0o600);
    for suffix in ["-wal", "-shm"] {
        let side = sidecar(&path, suffix);
        assert!(side.exists(), "{}", side.display());
        assert_eq!(mode(&side), 0o600, "{}", side.display());
    }
    // A file left group- or world-readable is tightened at open.
    drop(model);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let _model = ReadModel::open(dir.path()).unwrap();
    assert_eq!(mode(&path), 0o600);
}

#[test]
fn a_reader_sees_a_commit_whole_or_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"a", b"1");
    put(&model, b"b", b"2");
    assert_eq!(rows(&model), 0, "uncommitted rows are visible to a reader");
    assert_eq!(model.messages_applied_seq(), 0);
    model.finish_commit(7).unwrap();
    assert_eq!(rows(&model), 2);
    assert_eq!(model.messages_applied_seq(), 7);

    put(&model, b"c", b"3");
    model.rollback();
    assert_eq!(rows(&model), 2);
    // Nothing open: the watermark does not move.
    model.finish_commit(9).unwrap();
    assert_eq!(model.messages_applied_seq(), 7);

    drop(model);
    assert_eq!(ReadModel::probe(dir.path()).unwrap(), FileState::Usable { applied: 7 });
    let reopened = ReadModel::open(dir.path()).unwrap();
    assert_eq!(rows(&reopened), 2);
    assert_eq!(reopened.messages_applied_seq(), 7);
}

/// Write with generation N, look at it as generation N+1: the file is not
/// usable. Nothing is deleted by looking; the engine decides, and then
/// `recreate` gives an empty store at commit zero to fill from the log.
#[test]
fn a_file_of_another_generation_is_unusable_and_recreated_empty() {
    let dir = tempfile::tempdir().unwrap();
    let n = READ_MODEL_GENERATION;
    let model = ReadModel::open_as_generation(dir.path(), n).unwrap();
    put(&model, b"k", b"written by generation n");
    model.finish_commit(5).unwrap();
    drop(model);
    assert_eq!(
        ReadModel::probe_as_generation(dir.path(), n).unwrap(),
        FileState::Usable { applied: 5 }
    );

    let before = std::fs::read(ReadModel::path(dir.path())).unwrap();
    let state = ReadModel::probe_as_generation(dir.path(), n + 1).unwrap();
    println!("{state:?}");
    let FileState::Unusable { reason, applied } = state else {
        panic!("the old generation's file must be unusable");
    };
    assert!(reason.contains(&format!("generation {n}")), "{reason}");
    assert_eq!(applied, 5, "the commit it claims is still reported");
    assert_eq!(std::fs::read(ReadModel::path(dir.path())).unwrap(), before, "probing changed it");
    // Opening it as it is must fail rather than serve another build's rows.
    assert!(ReadModel::open_as_generation(dir.path(), n + 1).is_err());

    let next = ReadModel::recreate_as_generation(dir.path(), n + 1).unwrap();
    assert_eq!((rows(&next), next.messages_applied_seq()), (0, 0));
    put(&next, b"k", b"rebuilt");
    next.finish_commit(5).unwrap();
    drop(next);
    assert_eq!(
        ReadModel::probe_as_generation(dir.path(), n + 1).unwrap(),
        FileState::Usable { applied: 5 }
    );
}

fn unusable_reason(dir: &Path) -> String {
    match ReadModel::probe(dir).unwrap() {
        FileState::Unusable { reason, .. } => reason,
        other => panic!("expected an unusable file, got {other:?}"),
    }
}

#[test]
fn another_schema_version_a_non_database_and_a_rebuild_request_are_unusable() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(ReadModel::probe(dir.path()).unwrap(), FileState::Missing);
    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(5).unwrap();
    drop(model);
    let path = ReadModel::path(dir.path());
    let good = std::fs::read(&path).unwrap();

    ReadModel::request_rebuild(dir.path(), "a test asked").unwrap();
    assert!(unusable_reason(dir.path()).contains("a test asked"));
    assert_eq!(
        ReadModel::probe(dir.path()).unwrap(),
        FileState::Unusable { reason: unusable_reason(dir.path()), applied: 5 }
    );
    std::fs::remove_file(ReadModel::rebuild_marker(dir.path())).unwrap();
    assert_eq!(ReadModel::probe(dir.path()).unwrap(), FileState::Usable { applied: 5 });

    Connection::open(&path)
        .unwrap()
        .execute("UPDATE read_model_meta SET schema_version = schema_version + 1", [])
        .unwrap();
    assert!(unusable_reason(dir.path()).contains("schema version"));

    std::fs::write(&path, b"this is not a database, it is long enough to have a header").unwrap();
    println!("not a database: {}", unusable_reason(dir.path()));

    // Recreating clears the request and the file.
    std::fs::write(&path, &good).unwrap();
    ReadModel::request_rebuild(dir.path(), "again").unwrap();
    let model = ReadModel::recreate(dir.path()).unwrap();
    assert_eq!((rows(&model), model.messages_applied_seq()), (0, 0));
    drop(model);
    assert_eq!(ReadModel::probe(dir.path()).unwrap(), FileState::Usable { applied: 0 });
}

/// A file whose version row reads fine and whose pages are damaged. Reading
/// only the version row would accept it, and every later read would fail.
#[test]
fn damaged_pages_are_found_when_the_file_is_probed() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    for n in 0..2_000u32 {
        let key = n.to_be_bytes();
        model
            .write(|conn| {
                put_message(conn, &key, "ch", &format!("id{n}"), 1, &[7u8; 200])?;
                put_version(conn, &key, "ch", &format!("id{n}"), &[7u8; 200])
            })
            .unwrap();
    }
    model.finish_commit(9).unwrap();
    drop(model);
    let path = ReadModel::path(dir.path());
    let mut bytes = std::fs::read(&path).unwrap();
    assert!(bytes.len() > 16 * 4096, "{} bytes", bytes.len());
    for byte in &mut bytes[3 * 4096..] {
        *byte = 0xA5;
    }
    std::fs::write(&path, &bytes).unwrap();
    let reason = unusable_reason(dir.path());
    println!("damaged file: {reason}");
    assert!(reason.contains("consistency check failed"), "{reason}");
    // The commit it claims is still known, for the engine's decision.
    assert!(matches!(
        ReadModel::probe(dir.path()).unwrap(),
        FileState::Unusable { applied: 9, .. }
    ));
}

/// Damage that appears while the engine runs: the store stops being healthy
/// and leaves a request, so the next start rebuilds whatever a check at open
/// would or would not find.
#[test]
fn damage_seen_at_run_time_marks_the_store_and_requests_a_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    for n in 0..2_000u32 {
        let key = n.to_be_bytes();
        model
            .write(|conn| put_message(conn, &key, "ch", &format!("id{n}"), 1, &[7u8; 200]))
            .unwrap();
    }
    model.finish_commit(9).unwrap();
    model.sync(9).unwrap();
    assert!(!model.is_damaged());
    assert_eq!(rows(&model), 2_000);
    // Overwrite the pages under the open store. Its connections have cached
    // little; a full scan has to read the damaged pages.
    let path = ReadModel::path(dir.path());
    let len = std::fs::metadata(&path).unwrap().len() as usize;
    {
        use std::io::{Seek, SeekFrom, Write};
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(3 * 4096)).unwrap();
        file.write_all(&vec![0xA5u8; len - 3 * 4096]).unwrap();
    }
    let fresh = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert!(fresh.query_row("SELECT count(*) FROM messages", [], |row| row.get::<_, i64>(0)).is_err());
    drop(fresh);
    lock(&model.readers).clear();
    let read = model.read(|conn| {
        scan(conn, Table::Messages, &[], None, false, |_, _| Ok(true))
    });
    println!("read after damage: {:?}", read.as_ref().map_err(|e| e.to_string()));
    assert!(read.is_err());
    assert!(model.is_damaged());
    assert!(ReadModel::rebuild_marker(dir.path()).is_file());
}

/// Startup replay writes one transaction. `rebuild` empties the tables inside
/// it, so a failed replay brings back exactly what was there.
#[test]
fn a_failed_startup_keeps_the_rows_from_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"old", b"body");
    model.finish_commit(3).unwrap();

    for rebuild in [false, true] {
        model.begin_startup(rebuild).unwrap();
        assert_eq!(model.replay_floor(), if rebuild { 0 } else { 3 });
        put(&model, b"replayed", b"body");
        // No commit boundary is taken during replay.
        assert_eq!(rows(&model), 1);
        model.rollback();
        assert_eq!(model.replay_floor(), 0);
        assert_eq!((rows(&model), model.messages_applied_seq()), (1, 3));
    }

    model.begin_startup(true).unwrap();
    put(&model, b"replayed", b"body");
    model.commit_startup(9).unwrap();
    assert_eq!((rows(&model), model.messages_applied_seq()), (1, 9));
    assert!(model.read(|conn| get(conn, Table::Messages, b"old")).unwrap().is_none());

    // A replay that wrote nothing still records how far it validated.
    model.begin_startup(false).unwrap();
    model.commit_startup(12).unwrap();
    drop(model);
    assert_eq!(ReadModel::open(dir.path()).unwrap().messages_applied_seq(), 12);
}

#[test]
fn sync_records_the_checkpoint_watermark_and_never_lowers_it() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(4).unwrap();
    model.sync(10).unwrap();
    assert_eq!(model.messages_applied_seq(), 10);
    model.sync(6).unwrap();
    assert_eq!(model.messages_applied_seq(), 10);
    // The sync is a real write even when the watermark does not move: with
    // an empty write-ahead log, it must add a frame for SQLite to sync.
    let wal = sidecar(&ReadModel::path(dir.path()), "-wal");
    model.shrink_log(&lock(&model.writer));
    assert_eq!(std::fs::metadata(&wal).unwrap().len(), 0);
    model.sync(10).unwrap();
    assert!(std::fs::metadata(&wal).unwrap().len() > 0, "sync wrote nothing");

    // A checkpoint never commits half of a commit that is still open.
    put(&model, b"half", b"body");
    assert!(model.sync(11).is_err());
    assert_eq!((rows(&model), model.messages_applied_seq()), (1, 10));
    model.rollback();
    drop(model);
    let reopened = ReadModel::open(dir.path()).unwrap();
    assert_eq!((rows(&reopened), reopened.messages_applied_seq()), (1, 10));
}

fn listing(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
    let mut files: Vec<_> = std::fs::read_dir(dir.join("projections"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                metadata.len(),
                metadata.modified().unwrap(),
            )
        })
        .collect();
    files.sort();
    files
}

fn frozen_kind(dir: &Path) -> &'static str {
    match ReadModel::open_frozen(dir) {
        Frozen::Missing => "missing",
        Frozen::Usable(_) => "usable",
        Frozen::Replaced(..) => "replaced",
        Frozen::Refused(_) => "refused",
        Frozen::Unverifiable(_) => "unverifiable",
    }
}

/// Offline inspection must not change the tree it inspects, and must not
/// call a file verified when the engine would serve content it did not read.
#[test]
fn a_frozen_open_reads_a_stopped_file_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(frozen_kind(dir.path()), "missing");

    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(4).unwrap();
    // The engine would recover these frames and serve them.
    assert_eq!(frozen_kind(dir.path()), "unverifiable");
    assert!(matches!(ReadModel::peek(dir.path()), Peek::NotExamined(_)));
    // A read connection is open too; closing must still fold the log in.
    assert_eq!(rows(&model), 1);
    drop(model);

    let before = listing(dir.path());
    assert_eq!(before.len(), 1, "a clean close leaves only the database: {before:?}");
    let Frozen::Usable(frozen) = ReadModel::open_frozen(dir.path()) else {
        panic!("a stopped file opens");
    };
    assert_eq!(frozen.messages_applied_seq(), 4);
    let mut seen = Vec::new();
    frozen
        .for_each_full_row(Table::Messages, |columns| {
            seen.push(columns.iter().map(|column| column.to_vec()).collect::<Vec<_>>());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        seen,
        vec![vec![
            b"k".to_vec(),
            b"ch".to_vec(),
            b"id".to_vec(),
            1i64.to_le_bytes().to_vec(),
            b"body".to_vec()
        ]]
    );
    assert!(frozen.write(|_| Ok(())).is_err());
    frozen.sync(99).unwrap();
    drop(frozen);
    assert_eq!(ReadModel::peek(dir.path()), Peek::State(FileState::Usable { applied: 4 }));
    assert_eq!(listing(dir.path()), before);

    // An index that disagrees with its table passes the engine's quick
    // check; the full check here must not.
    let path = ReadModel::path(dir.path());
    let good = std::fs::read(&path).unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "writable_schema", true).unwrap();
        conn.execute_batch(
            "PRAGMA ignore_check_constraints = ON; \
             UPDATE sqlite_schema SET sql = replace(sql, 'messages (message_id)', 'messages (channel_id)') \
             WHERE name = 'messages_by_id';",
        )
        .unwrap();
    }
    println!("index rewritten: {}", frozen_kind(dir.path()));
    assert_ne!(frozen_kind(dir.path()), "usable");

    // Another build's file is one the engine would replace.
    std::fs::write(&path, &good).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE read_model_meta SET generation = generation + 1", [])
        .unwrap();
    assert_eq!(frozen_kind(dir.path()), "replaced");
}

#[test]
fn a_path_with_spaces_and_percent_signs_still_opens_frozen() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("data dir 100%#?");
    std::fs::create_dir_all(&dir).unwrap();
    let model = ReadModel::open(&dir).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(1).unwrap();
    drop(model);
    assert_eq!(ReadModel::peek(&dir), Peek::State(FileState::Usable { applied: 1 }));
}

#[test]
fn scans_are_in_key_order_within_bounds() {
    let model = ReadModel::in_memory();
    for key in [&b"a1"[..], b"a2", b"a3", b"b1"] {
        put(&model, key, key);
    }
    let collect = |lower: &[u8], upper: Option<&[u8]>, reverse| {
        let mut keys = Vec::new();
        model
            .read(|conn| {
                scan(conn, Table::Messages, lower, upper, reverse, |key, _| {
                    keys.push(String::from_utf8(key.to_vec()).unwrap());
                    Ok(keys.len() < 2)
                })
            })
            .unwrap();
        keys
    };
    assert_eq!(collect(b"a", Some(b"b"), false), ["a1", "a2"]);
    assert_eq!(collect(b"a", Some(b"b"), true), ["a3", "a2"]);
    assert_eq!(collect(b"a2", None, true), ["b1", "a3"]);
}

fn wal_len(dir: &Path) -> u64 {
    std::fs::metadata(sidecar(&ReadModel::path(dir), "-wal")).map_or(0, |wal| wal.len())
}

/// Reader threads that never pause (each runs one short statement after
/// another, so some statement is almost always running) against a writer
/// doing `commits` one-message commits and a checkpoint sync every 500.
/// Returns the largest write-ahead log seen and the longest single call of
/// the writer's `finish_commit` or `sync`.
fn run_under_sustained_reads(threshold: u64, commits: u32) -> (u64, Duration) {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ReadModel::open(dir.path()).unwrap());
    model.set_wal_threshold_for_tests(threshold);
    for n in 0..2_000u32 {
        let key = n.to_be_bytes();
        model.write(|conn| put_message(conn, &key, "ch", &format!("seed{n}"), 1, &[1u8; 200])).unwrap();
    }
    model.finish_commit(1).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let (model, stop) = (Arc::clone(&model), Arc::clone(&stop));
            std::thread::spawn(move || {
                let mut statements = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let mut rows = 0;
                    model
                        .read(|conn| {
                            scan(conn, Table::Messages, &[], None, true, |_, _| {
                                rows += 1;
                                Ok(rows < 300)
                            })
                        })
                        .unwrap();
                    statements += 1;
                }
                statements
            })
        })
        .collect();
    let (mut peak, mut longest) = (0u64, Duration::ZERO);
    for n in 2..=commits {
        let key = [&[9u8][..], &n.to_be_bytes()].concat();
        model
            .write(|conn| {
                put_message(conn, &key, "ch", &format!("m{n}"), 7, &[2u8; 1_000])?;
                put_version(conn, &key, "ch", &format!("m{n}"), &[2u8; 1_000])
            })
            .unwrap();
        let started = Instant::now();
        model.finish_commit(u64::from(n)).unwrap();
        if n % 500 == 0 {
            model.sync(u64::from(n)).unwrap();
        }
        longest = longest.max(started.elapsed());
        peak = peak.max(wal_len(dir.path()));
    }
    stop.store(true, Ordering::Relaxed);
    let statements: u64 = readers.into_iter().map(|reader| reader.join().unwrap()).sum();
    println!(
        "threshold {threshold}: peak write-ahead log {:.1} MB, longest finish_commit or sync \
         {:.1?}, {statements} read statements, database {:.1} MB",
        peak as f64 / 1e6,
        longest,
        std::fs::metadata(ReadModel::path(dir.path())).unwrap().len() as f64 / 1e6
    );
    (peak, longest)
}

/// The write-ahead log under readers that never pause: unbounded without the
/// trim (SQLite can restart the log only when no reader uses it), and held
/// near the threshold with it, without any commit or checkpoint waiting for a
/// reader longer than the gate's cap.
#[test]
fn the_write_ahead_log_stays_bounded_while_readers_never_pause() {
    const COMMITS: u32 = 6_000;
    let (without, _) = run_under_sustained_reads(u64::MAX, COMMITS);
    let (with, longest) = run_under_sustained_reads(1024 * 1024, COMMITS);
    assert!(
        without > 16 * 1024 * 1024,
        "the load did not reproduce the growth ({without} bytes), so this test proves nothing"
    );
    // Threshold plus 16 commits of growth, with room for the commit in flight.
    assert!(with < 8 * 1024 * 1024, "the log reached {with} bytes with the trim on");
    assert!(longest < Duration::from_secs(1), "a commit or checkpoint stalled for {longest:?}");
}

/// A reader that stays inside a statement for much longer than the cap cannot
/// hold the writer: the checkpoint gives up after the cap, and the reader
/// finishes undisturbed. (The 5-second stall this replaced must stay gone.)
#[test]
fn a_reader_pinned_for_a_long_time_cannot_hold_a_checkpoint() {
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ReadModel::open(dir.path()).unwrap());
    model.set_wal_threshold_for_tests(0);
    put(&model, b"k", b"body");
    model.finish_commit(1).unwrap();
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let reader = {
        let model = Arc::clone(&model);
        std::thread::spawn(move || {
            model
                .read(|conn| {
                    let rows = count(conn, Table::Messages)?;
                    entered.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(600));
                    Ok(rows)
                })
                .unwrap()
        })
    };
    entered_rx.recv().unwrap();
    put(&model, b"k2", b"body");
    model.finish_commit(2).unwrap();
    let started = Instant::now();
    model.sync(2).unwrap();
    let took = started.elapsed();
    println!("sync with a reader pinned for 600 ms: {took:?}");
    assert!(took < Duration::from_millis(300), "the checkpoint waited for the reader: {took:?}");
    assert_eq!(reader.join().unwrap(), 1);
    // The gate is open again.
    assert_eq!(rows(&model), 2);
}

/// A panic between closing the read gate and reopening it must not leave the
/// gate closed: every read would wait forever, including the sequencer's
/// admission lookups, so the engine would hang instead of halting.
#[test]
fn a_panic_with_the_read_gate_closed_does_not_wedge_reads() {
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ReadModel::open(dir.path()).unwrap());
    model.set_wal_threshold_for_tests(0);
    put(&model, b"k", b"body");
    model.finish_commit(1).unwrap();
    model.panic_in_next_trim_for_tests();
    let writer = {
        let model = Arc::clone(&model);
        std::thread::spawn(move || {
            // The sync trims, and the trim panics with the gate closed.
            model.sync(1)
        })
    };
    assert!(writer.join().is_err(), "the injected panic did not happen");
    let (done, done_rx) = std::sync::mpsc::channel();
    {
        let model = Arc::clone(&model);
        std::thread::spawn(move || done.send(rows(&model)).unwrap());
    }
    let seen = done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a read waited on a gate that was never reopened");
    assert_eq!(seen, 1);
}

/// SQLite before 3.54.0 can return uninitialized page-cache memory when a
/// database is opened with a write-ahead log of a different page size
/// (RUSTSEC-2026-0459, CVE-2026-119375). The read model is a WAL database,
/// so the SQLite linked in at run time must be at least 3.54.0. This catches
/// a downgrade of `rusqlite` / `libsqlite3-sys` or a switch away from the
/// bundled library.
#[test]
fn linked_sqlite_has_the_wal_page_size_fix() {
    let version = rusqlite::version_number();
    assert!(
        version >= 3_054_000,
        "linked SQLite {} is older than 3.54.0 (RUSTSEC-2026-0459)",
        rusqlite::version()
    );
}
