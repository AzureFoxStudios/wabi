//! Actual redb applied membership and private byte-store checks, with explicitly
//! synthetic peer observations for model invariants. No network/HA acceptance.
use super::*;
use crate::{
    model::{ControlCommand, CONTROL_PROTOCOL},
    store::StoreLimits,
    transport::material::{
        client::synthetic_test_ack,
        tests::{configs, setup},
    },
    Entry,
};
use openraft::{storage::RaftStateMachine, EntryPayload};
use std::{fs, os::unix::fs::PermissionsExt};

fn log(index: u64) -> LogId {
    LogId::new(openraft::CommittedLeaderId::new(1, 1), index)
}
async fn install(store: &mut Store, config: &Config, index: u64) {
    store
        .apply([Entry {
            log_id: log(index),
            payload: EntryPayload::Membership(openraft::Membership::new(
                vec![[1, 2, 3].into()],
                config.peers.clone(),
            )),
        }])
        .await
        .unwrap();
}
struct Fixture {
    _material_root: tempfile::TempDir,
    _control_root: tempfile::TempDir,
    config: Arc<Config>,
    control: Store,
    service: MaterialService,
    manifest: CheckpointManifest,
    bytes: Vec<u8>,
}
impl Fixture {
    async fn new() -> Self {
        let (material_root, io, manifest, bytes) = setup(1);
        io.store.put_object(&manifest.objects[0], &bytes).unwrap();
        io.store.certify_checkpoint(&manifest, "node-1").unwrap();
        let config = Arc::new(configs(&manifest.source.claims.community_id)[1].clone());
        let control_root = tempfile::tempdir().unwrap();
        fs::set_permissions(control_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut control = Store::open(
            control_root.path(),
            config.binding.clone(),
            StoreLimits::default(),
        )
        .unwrap();
        install(&mut control, &config, 1).await;
        let service = MaterialService::new(io.store, &config, "node-1".into(), 1).unwrap();
        Self {
            _material_root: material_root,
            _control_root: control_root,
            config,
            control,
            service,
            manifest,
            bytes,
        }
    }
    async fn round(&self) -> CheckpointAvailabilityRound {
        CheckpointAvailabilityRound::begin(
            self.config.clone(),
            self.control.clone(),
            &self.service,
            "ab".repeat(16),
            &self.manifest,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
    }
    fn peer(&self, node: u64) -> AuthenticatedCheckpointAck {
        synthetic_test_ack(
            self.config.clone(),
            node,
            &self.manifest,
            self.service
                .io
                .store
                .checkpoint_receipt(&self.manifest.sha256().unwrap(), "node-1")
                .unwrap(),
        )
    }
}

#[tokio::test]
async fn two_distinct_observations_bind_exact_proposal_and_grant_no_permission() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let proposal = round.finish().await.unwrap();
    assert_eq!(proposal.observed_voters(), [1, 2]);
    assert_eq!(
        proposal.manifest_sha256(),
        fixture.manifest.sha256().unwrap()
    );
    assert_eq!(proposal.operation_id(), "ab".repeat(16));
    let wire = serde_json::to_value(&proposal).unwrap();
    assert_eq!(
        wire["scope"],
        "uncommitted_checkpoint_availability_proposal"
    );
    assert_eq!(
        wire["membershipLogId"],
        serde_json::to_value(log(1)).unwrap()
    );
    assert_eq!(
        wire["sourceArchiveSha256"],
        fixture.manifest.source.claims.archive_sha256
    );
    assert_eq!(
        wire["sourceInventorySha256"],
        fixture.manifest.source.claims.inventory_sha256
    );
    assert_eq!(wire["requiredBytes"], fixture.bytes.len());
    assert_eq!(wire["allocation"]["kind"], "unknown");
    for flag in [
        "committed",
        "sourceRoleVerified",
        "payloadEncryptionVerified",
        "inactiveReplayVerified",
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(wire[flag], false);
    }
    let unchanged = fixture.control.control_state().await.unwrap();
    assert!(unchanged.operations.is_empty() && unchanged.intents.is_empty());
    assert_eq!(unchanged.last_applied, Some(log(1)));
    assert_eq!(proposal.sha256().unwrap(), proposal.sha256().unwrap());
}

#[tokio::test]
async fn repeating_a_voter_never_counts_twice_or_finishes_a_minority() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.observe_peer(fixture.peer(1)).unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    assert_eq!(round.observations.len(), 1);
    assert!(matches!(round.finish().await, Err(Error::Refused)));
}

#[tokio::test]
async fn failed_fresh_local_read_removes_earlier_success_and_preserves_lock() {
    use std::os::unix::fs::MetadataExt;
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let lock = fixture._material_root.path().join(".lock");
    let before = fs::metadata(&lock).unwrap();
    let blob = fixture
        ._material_root
        .path()
        .join(format!("{}.blob", fixture.manifest.objects[0].sha256));
    // Owned test corruption; do not bypass writer admission or unlink a lock.
    fs::write(&blob, b"corruption").unwrap();
    assert!(round.refresh(2).await.is_err());
    assert!(!round.observations.contains_key(&2));
    assert!(matches!(round.finish().await, Err(Error::Refused)));
    let after = fs::metadata(lock).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
}

#[tokio::test]
async fn actual_applied_membership_change_invalidates_previously_observed_bytes() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let mut control = fixture.control.clone();
    // Same voter values at a NEW applied membership log position still refuse
    // the original proposal; membership identity is not just voter arithmetic.
    install(&mut control, &fixture.config, 2).await;
    assert!(matches!(round.finish().await, Err(Error::Authentication)));
}

#[tokio::test]
async fn expired_round_never_returns_late_success_or_creates_an_operation() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    round.deadline = Instant::now() - Duration::from_millis(1);
    assert!(matches!(round.finish().await, Err(Error::Deadline)));
    assert!(fixture
        .control
        .control_state()
        .await
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn strict_binding_operation_and_membership_admission_refuses_before_io() {
    let fixture = Fixture::new().await;
    for id in [
        "",
        "ABABABABABABABABABABABABABABABAB",
        "ab",
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ] {
        assert!(CheckpointAvailabilityRound::begin(
            fixture.config.clone(),
            fixture.control.clone(),
            &fixture.service,
            id.into(),
            &fixture.manifest,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    }
    for timeout in [Duration::ZERO, Duration::from_secs(31)] {
        assert!(CheckpointAvailabilityRound::begin(
            fixture.config.clone(),
            fixture.control.clone(),
            &fixture.service,
            "ab".repeat(16),
            &fixture.manifest,
            timeout
        )
        .await
        .is_err());
    }
    let mut wrong = (*fixture.config).clone();
    wrong.binding.node_id = 1;
    assert!(CheckpointAvailabilityRound::begin(
        Arc::new(wrong),
        fixture.control.clone(),
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
    let mut wrong = (*fixture.config).clone();
    wrong.peers.get_mut(&3).unwrap().site_id = "changed-site".into();
    // Config's stored digest cannot substitute for comparison with actual
    // applied member records (this direct mutation is internal test-only).
    assert!(CheckpointAvailabilityRound::begin(
        Arc::new(wrong),
        fixture.control.clone(),
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
    let mut changed = fixture.manifest.clone();
    changed.partition_id = "other/root".into();
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        fixture.control.clone(),
        &fixture.service,
        "ab".repeat(16),
        &changed,
        Duration::from_secs(30)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn joint_membership_learners_and_uninitialized_membership_refuse() {
    let fixture = Fixture::new().await;
    for (index, groups, nodes) in [
        (
            2,
            vec![[1, 2, 3].into(), [1, 2].into()],
            fixture.config.peers.clone(),
        ),
        (3, vec![[1, 2].into()], fixture.config.peers.clone()),
    ] {
        let mut control = fixture.control.clone();
        control
            .apply([Entry {
                log_id: log(index),
                payload: EntryPayload::Membership(openraft::Membership::new(groups, nodes)),
            }])
            .await
            .unwrap();
        assert!(CheckpointAvailabilityRound::begin(
            fixture.config.clone(),
            control,
            &fixture.service,
            "ab".repeat(16),
            &fixture.manifest,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    }
    let mut extra = fixture.config.peers.clone();
    let mut learner = extra[&3].clone();
    learner.site_id = "learner4".into();
    learner.protocol = CONTROL_PROTOCOL;
    extra.insert(4, learner);
    let mut control = fixture.control.clone();
    control
        .apply([Entry {
            log_id: log(4),
            payload: EntryPayload::Membership(openraft::Membership::new(
                vec![[1, 2, 3].into()],
                extra,
            )),
        }])
        .await
        .unwrap();
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        control,
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
    let empty = tempfile::tempdir().unwrap();
    fs::set_permissions(empty.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(
        empty.path(),
        fixture.config.binding.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        store,
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_different_command_using_the_operation_identity_invalidates_finish() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let mut control = fixture.control.clone();
    control
        .apply([Entry {
            log_id: log(2),
            payload: EntryPayload::Normal(ControlCommand {
                operation_id: "ab".repeat(16),
                partition_id: "room:example".into(),
                expected_epoch: 0,
                proposed_writer: 2,
                checkpoint_inventory_sha256: "cd".repeat(32),
            }),
        }])
        .await
        .unwrap();
    assert!(matches!(round.finish().await, Err(Error::Authentication)));
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        control,
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn even_typed_observations_from_a_different_roster_or_manifest_refuse() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    let other = Arc::new(configs(&fixture.manifest.source.claims.community_id)[1].clone());
    let local = fixture.service.io.store.checkpoint_receipt(&fixture.manifest.sha256().unwrap(), "node-1").unwrap();
    let ack = synthetic_test_ack(other, 1, &fixture.manifest, local);
    assert!(matches!(round.observe_peer(ack), Err(Error::Authentication)));
    // An immutable round owns the manifest captured at begin. Even a valid
    // typed ACK is refused if its content differs from that captured identity.
    let ack = fixture.peer(1);
    round.manifest_sha256 = "de".repeat(32); // internal test-only mutation
    assert!(matches!(round.observe_peer(ack), Err(Error::Authentication)));
    assert!(round.observations.is_empty());
}
