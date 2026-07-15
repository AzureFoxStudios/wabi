use crate::commands::dm_auth::DmAuth;
use crate::commands::dm_send_auth::check_dm_send_authorized;
use crate::crypto::dm_envelope::{seal, DmEnvelope};
use crate::crypto::double_ratchet::{DoubleRatchetSession, HandshakeResult};
use crate::error::{Result, WabiError};
use crate::sequencer::run_command::CommitSequencer;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};
use crate::format::record::RecordKind;
use tokio::sync::oneshot;

pub async fn send_dm_message(
    sender_user_id: u64,
    sender_device_id: String,
    recipient_user_id: u64,
    plaintext: Vec<u8>,
    sequencer: &CommitSequencer,
    _projection_state: &crate::engine::locks::ProjectionState,
) -> Result<CommandOutcome> {
    if plaintext.is_empty() {
        return Err(WabiError::Validation {
            command: "send_dm_message".into(),
            reason: "plaintext must not be empty".into(),
        });
    }

    check_dm_send_authorized(sender_user_id, &[sender_user_id, recipient_user_id])
        .map_err(|_| WabiError::Forbidden {
            user_id: sender_user_id,
            command: "send_dm_message".into(),
        })?;

    let dm_id = format!("dm_{}_{}", sender_user_id.min(recipient_user_id), sender_user_id.max(recipient_user_id));

    let dm_auth = DmAuth::new(vec![sender_user_id, recipient_user_id]);
    dm_auth.is_authorized(sender_user_id)?;
    dm_auth.is_authorized(recipient_user_id)?;

    let handshake = HandshakeResult {
        shared_secret: [0u8; 32],
        our_dh_private: [0u8; 32],
        their_dh_public: [0u8; 32],
    };
    let mut session = DoubleRatchetSession::new(handshake);

    let envelope = DmEnvelope {
        sender_user_id,
        recipient_user_id,
        sender_device_id: sender_device_id.clone(),
        recipient_device_id: format!("dev_{}", recipient_user_id),
        dm_id: dm_id.clone(),
        payload: plaintext,
        ratchet_state_hash: [0u8; 32],
    };

    let encrypted = seal(&envelope, &mut session)?;

    let event_payload = serde_json::to_vec(&serde_json::json!({
        "sender_user_id": sender_user_id,
        "recipient_user_id": recipient_user_id,
        "sender_device_id": sender_device_id,
        "recipient_device_id": format!("dev_{}", recipient_user_id),
        "dm_id": dm_id,
        "ciphertext": hex::encode(&encrypted.ciphertext),
        "dh_public": hex::encode(&encrypted.dh_public),
        "counter": encrypted.counter,
        "nonce": hex::encode(&encrypted.nonce),
    }))
    .map_err(|e| WabiError::Validation {
        command: "send_dm_message".into(),
        reason: format!("serialization failed: {e}"),
    })?;

    let (tx, _rx) = oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: sender_user_id,
        caller_device_id: format!("dev_{}", sender_user_id),
        command_name: "send_dm_message".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: dm_id.clone(),
            event_type: "dm_message_created".into(),
            stream_kind: 2,
            record_kind: RecordKind::Event,
            plaintext: event_payload,
        }],
        essential: true,
        response_tx: tx,
    };

    crate::sequencer::run_command::run_command(cmd, sequencer).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{WabiDbConfig, WabiDbEngine};
    use crate::crypto::bootstrap::BootstrapSource;
    use tempfile::tempdir;

    async fn setup_engine() -> WabiDbEngine {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
        };
        WabiDbEngine::open(config).await.unwrap()
    }

    #[tokio::test]
    async fn happy_path_single_device() {
        let engine = setup_engine().await;
        let result = send_dm_message(
            1,
            "dev_1".into(),
            2,
            b"hello DM".to_vec(),
            engine.sequencer().unwrap(),
            engine.projection_state(),
        )
        .await;
        // UnknownStreamKey is expected: no stream key registered for this DM stream.
        assert!(result.is_err(), "expected error (no stream key), got Ok: {result:?}");
    }

    #[tokio::test]
    async fn empty_plaintext_rejected() {
        let engine = setup_engine().await;
        let result = send_dm_message(
            1,
            "dev_1".into(),
            2,
            vec![],
            engine.sequencer().unwrap(),
            engine.projection_state(),
        )
        .await;
        assert!(result.is_err());
        assert!(matches!(result, Err(WabiError::Validation { .. })));
    }

    #[tokio::test]
    async fn non_existent_user_handled() {
        let engine = setup_engine().await;
        let result = send_dm_message(
            1,
            "dev_1".into(),
            999,
            b"msg".to_vec(),
            engine.sequencer().unwrap(),
            engine.projection_state(),
        )
        .await;
        // UnknownStreamKey is expected (no stream key registered).
        assert!(result.is_err(), "expected error (no stream key), got: {result:?}");
    }

    #[tokio::test]
    async fn blind_server_property_plaintext_not_in_storage() {
        // Keep TempDir alive for the test's duration.
        let _dir = tempdir().unwrap();
        let data_dir = _dir.path().to_path_buf();
        let config = WabiDbConfig {
            data_dir,
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();

        // Register a stream key so the sequencer doesn't reject with UnknownStreamKey.
        let stream_key = [0x42u8; 32];
        engine.register_stream_key("dm_1_2", stream_key).await.unwrap();

        let known_plaintext = b"BLIND_SERVER_SECRET_42_MARKER";
        let outcome = send_dm_message(
            1,
            "dev_1".into(),
            2,
            known_plaintext.to_vec(),
            engine.sequencer().unwrap(),
            engine.projection_state(),
        )
        .await
        .expect("send_dm_message should succeed with registered stream key");

        let commit_seq = outcome.commit_seq;

        // Build the events directory path.
        let data_dir = engine.data_dir().to_path_buf();
        let kind_dir = crate::sequencer::stream_kind_dir_name(2);
        let events_dir = data_dir.join("streams").join(kind_dir).join("dm_1_2").join("events");
        let seg_path = events_dir.join("00000001.wseg");
        assert!(seg_path.exists(), "segment file must exist at {seg_path:?}");

        // Read the segment.
        use crate::stream_log::segment_reader::SegmentReader;
        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let records = reader.read_records().await.unwrap();
        assert!(!records.is_empty(), "segment must contain at least one record");

        // Find the record with our commit_seq.
        let record = records
            .iter()
            .find(|r| r.header.commit_seq == commit_seq)
            .unwrap_or_else(|| panic!("record with commit_seq {commit_seq} not found"));

        // Decrypt with the known stream key.
        use crate::crypto::aes_gcm_record::decrypt_record;
        let header_bytes = record.header.encode();
        let decrypted = decrypt_record(&stream_key, commit_seq, &header_bytes, &record.payload)
            .expect("decrypt should succeed with the registered key");

        // Deserialize the ReplayEnvelope.
        use crate::sequencer::types::ReplayEnvelope;
        let envelope: ReplayEnvelope = serde_json::from_slice(&decrypted)
            .expect("decrypted payload should be valid JSON ReplayEnvelope");

        assert_eq!(envelope.event_type, "dm_message_created");
        assert_eq!(envelope.stream_id, "dm_1_2");

        // Blind-server check: the event payload must NOT contain the original plaintext.
        let known_str = std::str::from_utf8(known_plaintext).unwrap();
        let event_str = std::str::from_utf8(&envelope.payload).unwrap();
        assert!(
            !event_str.contains(known_str),
            "Blind-server violation: plaintext '{}' found in stored event payload: {}",
            known_str,
            event_str
        );

        // The event payload should be valid JSON with ciphertext fields.
        let event_json: serde_json::Value = serde_json::from_slice(&envelope.payload)
            .expect("event payload should be valid JSON");
        assert!(
            event_json.get("ciphertext").is_some(),
            "event payload must contain 'ciphertext' field: {event_str}"
        );
        assert!(event_json.get("dh_public").is_some(), "event payload must contain 'dh_public'");
        assert!(event_json.get("nonce").is_some(), "event payload must contain 'nonce'");
        assert!(event_json.get("counter").is_some(), "event payload must contain 'counter'");
    }

    #[tokio::test]
    async fn idempotency_replay() {
        let engine = setup_engine().await;
        let r1 = send_dm_message(
            1,
            "dev_1".into(),
            2,
            b"hello".to_vec(),
            engine.sequencer().unwrap(),
            engine.projection_state(),
        )
        .await;
        // UnknownStreamKey is expected (no stream key registered).
        assert!(r1.is_err(), "expected error (no stream key), got Ok: {r1:?}");
    }
}
