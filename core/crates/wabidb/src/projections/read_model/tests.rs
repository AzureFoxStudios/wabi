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
    let reopened = ReadModel::open(dir.path()).unwrap();
    assert_eq!(reopened.discarded(), None);
    assert_eq!(rows(&reopened), 2);
    assert_eq!(reopened.messages_applied_seq(), 7);
}

/// Write with generation N, reopen as generation N+1: the file is thrown
/// away, and the store is empty at commit zero so the engine replays the log.
#[test]
fn a_file_of_another_generation_is_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let n = READ_MODEL_GENERATION;
    let model = ReadModel::open_as_generation(dir.path(), n).unwrap();
    put(&model, b"k", b"written by generation n");
    model.finish_commit(5).unwrap();
    drop(model);

    let same = ReadModel::open_as_generation(dir.path(), n).unwrap();
    assert_eq!(same.discarded(), None);
    assert_eq!((rows(&same), same.messages_applied_seq()), (1, 5));
    drop(same);

    let next = ReadModel::open_as_generation(dir.path(), n + 1).unwrap();
    let reason = next.discarded().expect("the old generation's file must be discarded");
    println!("discarded: {reason}");
    assert!(reason.contains(&format!("generation {n}")), "{reason}");
    assert_eq!((rows(&next), next.messages_applied_seq()), (0, 0));
    put(&next, b"k", b"rebuilt");
    next.finish_commit(5).unwrap();
    drop(next);

    // The rebuilt file belongs to the new generation and is kept.
    let again = ReadModel::open_as_generation(dir.path(), n + 1).unwrap();
    assert_eq!(again.discarded(), None);
    assert_eq!((rows(&again), again.messages_applied_seq()), (1, 5));
}

#[test]
fn a_file_of_another_schema_version_or_not_a_database_is_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(5).unwrap();
    drop(model);
    let path = ReadModel::path(dir.path());
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE read_model_meta SET schema_version = schema_version + 1", [])
        .unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    assert!(model.discarded().unwrap().contains("schema version"));
    assert_eq!((rows(&model), model.messages_applied_seq()), (0, 0));
    drop(model);

    std::fs::write(&path, b"this is not a database, it is long enough to have a header").unwrap();
    let model = ReadModel::open(dir.path()).unwrap();
    assert!(model.discarded().is_some());
    assert_eq!((rows(&model), model.messages_applied_seq()), (0, 0));
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

/// Offline inspection must not change the tree it inspects.
#[test]
fn a_frozen_open_reads_a_stopped_file_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    assert!(ReadModel::open_frozen(dir.path()).is_none(), "no file");

    let model = ReadModel::open(dir.path()).unwrap();
    put(&model, b"k", b"body");
    model.finish_commit(4).unwrap();
    assert!(
        ReadModel::open_frozen(dir.path()).is_none(),
        "frames still in the write-ahead log"
    );
    // A read connection is open too; closing must still fold the log in.
    assert_eq!(rows(&model), 1);
    drop(model);

    let before = listing(dir.path());
    assert_eq!(before.len(), 1, "a clean close leaves only the database: {before:?}");
    let frozen = ReadModel::open_frozen(dir.path()).expect("a stopped file opens");
    assert_eq!(frozen.messages_applied_seq(), 4);
    let mut seen = Vec::new();
    frozen
        .for_each_row(Table::Messages, |key, record| {
            seen.push((key.to_vec(), record.to_vec()));
            Ok(())
        })
        .unwrap();
    assert_eq!(seen, vec![(b"k".to_vec(), b"body".to_vec())]);
    assert!(frozen.write(|_| Ok(())).is_err());
    frozen.sync(99).unwrap();
    drop(frozen);
    assert_eq!(listing(dir.path()), before);

    // Another build's file is not something this build would use.
    Connection::open(ReadModel::path(dir.path()))
        .unwrap()
        .execute("UPDATE read_model_meta SET generation = generation + 1", [])
        .unwrap();
    assert!(ReadModel::open_frozen(dir.path()).is_none());
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
    assert_eq!(ReadModel::open_frozen(&dir).unwrap().messages_applied_seq(), 1);
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
