//! SPIKE (Task 0.1, throwaway): current in-memory messages read model vs the
//! SQLite read model, through the real engine. Each step runs in its own
//! process so resident memory belongs to that step alone.
//!
//!   messages_sqlite_spike generate <dataset_dir> <messages> <channels>
//!   messages_sqlite_spike cold <memory|sqlite> <work_dir>   (work_dir = copy of dataset)
//!   messages_sqlite_spike warm <memory|sqlite> <work_dir>   (after `cold` on the same dir)
//!
//! `cold` = open on a data directory holding only the log (full replay), then
//! the write and read latency runs. `warm` = a normal restart from the
//! checkpoint the `cold` process left behind. Results print as one JSON line.
//! The driver is `benches/messages_sqlite_spike.sh`.

use rand::{rngs::StdRng, Rng, SeedableRng};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wabidb::crypto::bootstrap::BootstrapSource;
use wabidb::engine::{WabiDbConfig, WabiDbEngine};
use wabidb::format::record::RecordKind;
use wabidb::projections::messages::{encode_record, MessagePageCursor, MessageRecord, MessagesProjection};
use wabidb::projections::messages_sqlite::OPT_IN_MARKER;
use wabidb::sequencer::types::{CommandCommit, EventToWrite, RoomOwnerPrecondition};

const WRITERS: usize = 8;
const SENDS_PER_WRITER: usize = 2_000;
const PAGE: usize = 50;
const READS: usize = 5_000;
const CURSORS_FILE: &str = "bench-cursors.txt";

fn config(dir: &Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(dir.to_path_buf(), BootstrapSource::Provided([0x42; 32]));
    config.allow_init = true;
    config
}

fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
}

fn channel(n: usize) -> String {
    format!("ch_bench_{n:02}")
}

/// The same command `WdbAdapter::send_message` builds (stream key, room-owner
/// precondition with no placement, one `message_created` event on the room).
async fn send_message(engine: &WabiDbEngine, rng: &mut StdRng, room: &str, user: u64) -> String {
    let message_id = format!("msg_{:032x}", rng.gen::<u128>());
    let body_len = rng.gen_range(20..300);
    let body: String = (0..body_len).map(|_| rng.gen_range(b'a'..=b'z') as char).collect();
    let record = MessageRecord {
        message_id: message_id.clone(),
        channel_id: room.into(),
        author_user_id: user,
        author_device_id: String::new(),
        created_at_micros: now_micros(),
        encrypted_body_ref: body,
        idempotency_key: Some(format!("send_message:{room}:{:032x}", rng.gen::<u128>())),
        edit_history: vec![],
        edited_at_micros: None,
        is_deleted: false,
        is_spoiler: false,
        files: vec![],
    };
    engine.get_or_create_stream_key(room).await.unwrap();
    let (response_tx, _) = tokio::sync::oneshot::channel();
    engine
        .run_command(CommandCommit {
            room_owner_precondition: Some(RoomOwnerPrecondition {
                channel_id: room.into(),
                owner_node_id: engine.local_node_id().to_owned(),
                expected_epoch: None,
            }),
            caller_user_id: user,
            caller_device_id: "primary".into(),
            command_name: "send_message".into(),
            idempotency_key: record.idempotency_key.clone(),
            events: vec![EventToWrite {
                stream_id: room.into(),
                event_type: "message_created".into(),
                stream_kind: 1,
                record_kind: RecordKind::Event,
                plaintext: encode_record(&record),
            }],
            essential: true,
            response_tx,
        })
        .await
        .unwrap();
    message_id
}

fn memory_kib() -> (u64, u64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let field = |name: &str| {
        status
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|kib| kib.parse().ok())
            .unwrap_or(0)
    };
    (field("VmRSS:"), field("VmHWM:"))
}

fn percentiles(mut samples: Vec<Duration>) -> serde_json::Value {
    samples.sort();
    let at = |p: usize| samples[(samples.len() * p / 100).min(samples.len() - 1)].as_secs_f64() * 1e3;
    serde_json::json!({
        "n": samples.len(),
        "p50_ms": at(50),
        "p99_ms": at(99),
        "max_ms": samples.last().unwrap().as_secs_f64() * 1e3,
    })
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| {
            let meta = entry.metadata().unwrap();
            if meta.is_dir() { dir_bytes(&entry.path()) } else { meta.len() }
        })
        .sum()
}

async fn generate(dir: PathBuf, messages: usize, channels: usize) {
    // The SQLite read model is attached during generation only so that the
    // in-memory engine's full-state JSON checkpoint (every 1000 commits) does
    // not make generation quadratic. The log it writes is the same format;
    // the read model is deleted below so both backends replay the same bytes.
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(OPT_IN_MARKER), b"sqlite\n").unwrap();
    let engine = Arc::new(WabiDbEngine::open(config(&dir)).await.unwrap());
    let started = Instant::now();
    let tasks = 64;
    let mut handles = Vec::new();
    for task in 0..tasks {
        let engine = Arc::clone(&engine);
        handles.push(tokio::spawn(async move {
            let mut rng = StdRng::seed_from_u64(task as u64);
            let mut cursors = Vec::new();
            for n in (task..messages).step_by(tasks) {
                let room = channel(n % channels);
                let id = send_message(&engine, &mut rng, &room, 1 + (n % 200) as u64).await;
                if n % 500 == 0 {
                    cursors.push(format!("{room} {id}"));
                }
                if n % 100_000 == 0 {
                    eprintln!("generated {n} in {:?}", started.elapsed());
                }
            }
            cursors
        }));
    }
    let mut cursors = Vec::new();
    for handle in handles {
        cursors.extend(handle.await.unwrap());
    }
    let elapsed = started.elapsed();
    std::fs::write(dir.join(CURSORS_FILE), cursors.join("\n")).unwrap();
    drop(Arc::try_unwrap(engine).unwrap());
    tokio::time::sleep(Duration::from_secs(2)).await;
    // Leave only the log: no checkpoint, no SQLite file, no opt-in marker.
    std::fs::remove_dir_all(dir.join("projections")).unwrap();
    std::fs::remove_file(dir.join(OPT_IN_MARKER)).unwrap();
    println!(
        "{}",
        serde_json::json!({
            "step": "generate", "messages": messages, "channels": channels,
            "seconds": elapsed.as_secs_f64(),
            "log_bytes": dir_bytes(&dir),
        })
    );
}

async fn open_timed(backend: &str, dir: &Path) -> (WabiDbEngine, serde_json::Value) {
    match backend {
        "memory" => {}
        "sqlite" => std::fs::write(dir.join(OPT_IN_MARKER), b"sqlite\n").unwrap(),
        other => panic!("unknown backend {other}"),
    }
    let started = Instant::now();
    let engine = WabiDbEngine::open(config(dir)).await.unwrap();
    let startup = started.elapsed();
    let (rss, hwm) = memory_kib();
    let info = serde_json::json!({
        "startup_s": startup.as_secs_f64(),
        "rss_mib": rss as f64 / 1024.0,
        "peak_rss_mib": hwm as f64 / 1024.0,
        "applied_commit_seq": engine.projection_state().applied_commit_seq(),
    });
    (engine, info)
}

async fn cold(backend: String, dir: PathBuf) {
    let (engine, startup) = open_timed(&backend, &dir).await;
    let engine = Arc::new(engine);
    let channels: Vec<String> = (0..50).map(channel).collect();

    // send_message under 8 concurrent writers.
    let mut handles = Vec::new();
    for writer in 0..WRITERS {
        let engine = Arc::clone(&engine);
        let channels = channels.clone();
        handles.push(tokio::spawn(async move {
            let mut rng = StdRng::seed_from_u64(1_000 + writer as u64);
            let mut samples = Vec::with_capacity(SENDS_PER_WRITER);
            for _ in 0..SENDS_PER_WRITER {
                let room = &channels[rng.gen_range(0..channels.len())];
                let started = Instant::now();
                send_message(&engine, &mut rng, room, 1 + writer as u64).await;
                samples.push(started.elapsed());
            }
            samples
        }));
    }
    let write_started = Instant::now();
    let mut sends = Vec::new();
    for handle in handles {
        sends.extend(handle.await.unwrap());
    }
    let write_seconds = write_started.elapsed().as_secs_f64();

    // list_messages_page, 50 messages: newest page, and an older page before
    // a random message from anywhere in the channel's history.
    let cursors: Vec<(String, String)> = std::fs::read_to_string(dir.join(CURSORS_FILE))
        .unwrap()
        .lines()
        .map(|line| {
            let (room, id) = line.split_once(' ').unwrap();
            (room.to_owned(), id.to_owned())
        })
        .collect();
    let mut rng = StdRng::seed_from_u64(7);
    let state = engine.projection_state();
    let mut latest = Vec::with_capacity(READS);
    let mut before = Vec::with_capacity(READS);
    for _ in 0..READS {
        let room = &channels[rng.gen_range(0..channels.len())];
        let started = Instant::now();
        let page = MessagesProjection::list_messages_page(state, room, MessagePageCursor::Latest, PAGE).unwrap();
        latest.push(started.elapsed());
        assert_eq!(page.messages.len(), PAGE);

        let (room, id) = &cursors[rng.gen_range(0..cursors.len())];
        let started = Instant::now();
        let page = MessagesProjection::list_messages_page(state, room, MessagePageCursor::Before(id), PAGE).unwrap();
        before.push(started.elapsed());
        assert!(page.messages.len() <= PAGE);
    }
    let (rss_end, hwm_end) = memory_kib();

    let started = Instant::now();
    drop(Arc::try_unwrap(engine).unwrap());
    let shutdown = started.elapsed();
    tokio::time::sleep(Duration::from_secs(2)).await;
    println!(
        "{}",
        serde_json::json!({
            "step": "cold", "backend": backend,
            "startup": startup,
            "send_message": percentiles(sends),
            "send_message_wall_s": write_seconds,
            "page_latest": percentiles(latest),
            "page_before_random_cursor": percentiles(before),
            "rss_after_bench_mib": rss_end as f64 / 1024.0,
            "peak_rss_after_bench_mib": hwm_end as f64 / 1024.0,
            "shutdown_s": shutdown.as_secs_f64(),
            "read_model_bytes_on_disk": dir_bytes(&dir.join("projections")),
        })
    );
}

async fn warm(backend: String, dir: PathBuf) {
    let (engine, startup) = open_timed(&backend, &dir).await;
    drop(engine);
    tokio::time::sleep(Duration::from_secs(2)).await;
    println!("{}", serde_json::json!({ "step": "warm", "backend": backend, "startup": startup }));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|arg| arg != "--bench").collect();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["generate", dir, messages, channels] => runtime.block_on(generate(
            dir.into(),
            messages.parse().unwrap(),
            channels.parse().unwrap(),
        )),
        ["cold", backend, dir] => runtime.block_on(cold(backend.to_string(), dir.into())),
        ["warm", backend, dir] => runtime.block_on(warm(backend.to_string(), dir.into())),
        // `cargo bench --workspace` runs every bench with no arguments.
        _ => eprintln!("usage: generate <dir> <messages> <channels> | cold|warm <memory|sqlite> <dir>"),
    }
}
