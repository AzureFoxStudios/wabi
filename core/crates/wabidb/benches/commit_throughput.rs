use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use std::time::Duration;
use tempfile::tempdir;
use tokio::sync::oneshot;
use wabidb::crypto::bootstrap::BootstrapSource;
use wabidb::engine::{WabiDbConfig, WabiDbEngine};
use wabidb::format::record::RecordKind;
use wabidb::sequencer::types::{CommandCommit, EventToWrite};

/// Bench a run_command call through the FULL durable path: stream key
/// derivation, JSON envelope, AES-GCM encrypt, segment write + fsync,
/// commit-index write + fsync (durability-await), barrier advance, dispatch.
/// One engine per benchmark; every iteration is a real committed command.
fn bench_run_command(c: &mut Criterion, payload_size: usize) {
    let mut group = c.benchmark_group("run_command");
    group.throughput(Throughput::Bytes(payload_size as u64));
    group.measurement_time(Duration::from_secs(3));
    group.sample_size(20);

    group.bench_function(
        format!("commit_{}", payload_size),
        |b| {
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
            // Register the stream key so the command reaches the durable
            // write path instead of failing early with UnknownStreamKey.
            rt.block_on(engine.get_or_create_stream_key("bench_stream")).unwrap();
            let payload = vec![0xABu8; payload_size];

            b.iter(|| {
                let (tx, _rx) = oneshot::channel();
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
                        plaintext: black_box(payload.clone()),
                    }],
                    essential: false,
                    response_tx: tx,
                };
                let outcome = rt.block_on(engine.run_command(cmd)).expect(
                    "bench command must commit; UnknownStreamKey means the bench is off the durable path",
                );
                outcome.commit_seq
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
