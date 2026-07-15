use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use std::time::Duration;
use tempfile::tempdir;
use tokio::sync::oneshot;
use wabidb::crypto::bootstrap::BootstrapSource;
use wabidb::engine::{WabiDbConfig, WabiDbEngine};
use wabidb::format::record::RecordKind;
use wabidb::sequencer::types::{CommandCommit, EventToWrite};

/// Bench a run_command call. The command will fail with UnknownStreamKey
/// (we can't register keys from outside without a public API). We measure
/// the cost up to the failure point, which is most of the per-commit work
/// (sequencer permit, batcher, commit log entry creation, encryption).
fn bench_run_command(c: &mut Criterion, payload_size: usize) {
    let mut group = c.benchmark_group("run_command");
    group.throughput(Throughput::Bytes(payload_size as u64));
    group.measurement_time(Duration::from_secs(3));
    group.sample_size(20);

    group.bench_function(
        format!("commit_{}", payload_size),
        |b| {
            b.iter(|| {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                let dir = tempdir().unwrap();
                let config = WabiDbConfig {
                    data_dir: dir.path().to_path_buf(),
                    bootstrap_source: BootstrapSource::Provided([0u8; 32]),
                    bootstrap_salt: None,
                    allow_init: true,
                    replication_config: None,
                    sync_transport: None,
                };
                let engine = rt.block_on(WabiDbEngine::open(config)).unwrap();
                let (tx, _rx) = oneshot::channel();
                let payload = vec![0xABu8; payload_size];
                let cmd = CommandCommit {
                    caller_user_id: 0,
                    caller_device_id: "bench".into(),
                    command_name: "bench".into(),
                    idempotency_key: None,
                    events: vec![EventToWrite {
                        stream_id: "bench_stream".into(),
                        event_type: "bench_event".into(),
                        stream_kind: 6,
                        record_kind: RecordKind::Event,
                        plaintext: black_box(payload),
                    }],
                    essential: false,
                    response_tx: tx,
                };
                // The command will fail with UnknownStreamKey (we can't
                // register keys from outside without a public API). We
                // measure the cost up to the failure point, which is
                // most of the per-commit work.
                let _ = rt.block_on(engine.run_command(cmd));
                drop(engine);
                drop(dir);
            });
        },
    );
    group.finish();
}

fn commit_1kb(c: &mut Criterion) {
    bench_run_command(c, 1024);
}
fn commit_100kb(c: &mut Criterion) {
    bench_run_command(c, 102400);
}
fn commit_1mb(c: &mut Criterion) {
    bench_run_command(c, 1048576);
}

criterion_group! {
    name = commit_throughput;
    config = Criterion::default().sample_size(10).measurement_time(Duration::from_secs(3));
    targets = commit_1kb, commit_100kb, commit_1mb
}
criterion_main!(commit_throughput);
