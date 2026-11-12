use super::*;
use p256::ecdsa::{signature::Signer, SigningKey};

pub(crate) fn fixture(archive: &[u8]) -> SignedSourceContext {
    let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let public_key = hex::encode(key.verifying_key().to_sec1_point(false).as_bytes());
    let community_id = hex::encode(Sha256::digest(hex::decode(&public_key).unwrap()));
    let claims = SourceClaims {
        schema_version: 1,
        support_profile: SOURCE_PROFILE.into(),
        community_id,
        source_node_id: "node-1".into(),
        archive_sha256: hex::encode(Sha256::digest(archive)),
        inventory_sha256: "ab".repeat(32),
        ciphertext_bytes: archive.len() as u64,
        applied_commit_seq: 16,
        commit_prefix_fingerprint: "cd".repeat(32),
        bootstrap_fingerprint: "ef".repeat(32),
        allocation: AllocationKnowledge::Unknown,
    };
    let signature: Signature = key.sign(&signing_input(&claims).unwrap());
    let signature = signature.normalize_s();
    SignedSourceContext {
        claims,
        public_key,
        signature: hex::encode(signature.to_bytes()),
    }
}
#[test]
fn verified_context_is_exact_community_bound_and_explicitly_unknown_allocation() {
    let context = fixture(b"opaque fixture, not a real age archive");
    let verified = context
        .verify(&context.claims.community_id, "node-1")
        .unwrap();
    assert_eq!(verified.claims(), &context.claims);
    assert_eq!(verified.claims().allocation, AllocationKnowledge::Unknown);
    assert_eq!(
        verified.sha256(),
        hex::encode(Sha256::digest(serde_json::to_vec(&context).unwrap()))
    );
    assert_eq!(
        SignedSourceContext::parse_bounded(&serde_json::to_vec(&context).unwrap()).unwrap(),
        context
    );
}
#[test]
fn foreign_community_wrong_node_and_changed_signed_claims_refuse() {
    let original = fixture(b"opaque");
    let community = original.claims.community_id.clone();
    assert_eq!(
        original.verify(&"12".repeat(32), "node-1").unwrap_err(),
        SourceError::Binding
    );
    assert_eq!(
        original.verify(&community, "node-2").unwrap_err(),
        SourceError::Binding
    );
    for field in 0..6 {
        let mut context = original.clone();
        match field {
            0 => context.claims.archive_sha256 = "12".repeat(32),
            1 => context.claims.inventory_sha256 = "12".repeat(32),
            2 => context.claims.applied_commit_seq += 1,
            3 => context.claims.bootstrap_fingerprint = "12".repeat(32),
            4 => context.claims.ciphertext_bytes += 1,
            _ => context.claims.commit_prefix_fingerprint = "12".repeat(32),
        }
        assert_eq!(
            context.verify(&community, "node-1").unwrap_err(),
            SourceError::Signature
        )
    }
}
#[test]
fn malformed_unknown_and_oversized_context_refuses_without_any_store() {
    let original = fixture(b"opaque");
    let community = original.claims.community_id.clone();
    for field in 0..4 {
        let mut context = original.clone();
        match field {
            0 => context.public_key = context.public_key.to_uppercase(),
            1 => context.signature.pop().map(|_| ()).unwrap(),
            2 => context.claims.schema_version = 2,
            _ => context.claims.support_profile = "full-instance-ready".into(),
        };
        assert!(context.verify(&community, "node-1").is_err())
    }
    assert_eq!(
        SignedSourceContext::parse_bounded(&vec![b' '; MAX_SOURCE_CONTEXT_BYTES + 1]),
        Err(SourceError::Budget)
    );
    let mut encoded = serde_json::to_value(original).unwrap();
    encoded["claims"]["allocation"] = serde_json::json!({"kind":"known","assignedHighWater":16});
    assert_eq!(
        SignedSourceContext::parse_bounded(&serde_json::to_vec(&encoded).unwrap()),
        Err(SourceError::Format)
    );
    encoded["claims"]["allocation"] = serde_json::json!({"kind":"unknown"});
    encoded["writerPermitted"] = serde_json::Value::Bool(true);
    assert_eq!(
        SignedSourceContext::parse_bounded(&serde_json::to_vec(&encoded).unwrap()),
        Err(SourceError::Format)
    );
}
#[test]
fn signature_domain_cannot_be_replaced_by_roster_or_bare_claim_signature() {
    let mut context = fixture(b"opaque");
    let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let signature: Signature = key.sign(&serde_json::to_vec(&context.claims).unwrap());
    context.signature = hex::encode(signature.normalize_s().to_bytes());
    assert_eq!(
        context
            .verify(&context.claims.community_id, "node-1")
            .unwrap_err(),
        SourceError::Signature
    );
}

#[test]
fn malleable_signature_invalid_points_scalars_and_duplicate_fields_refuse() {
    let original = fixture(b"opaque");
    let community = &original.claims.community_id;
    let mut context = original.clone();
    let mut signature = hex::decode(&context.signature).unwrap();
    let order =
        hex::decode("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551").unwrap();
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let value = order[i] as i16 - signature[i + 32] as i16 - borrow;
        signature[i + 32] = value.rem_euclid(256) as u8;
        borrow = if value < 0 { 1 } else { 0 };
    }
    context.signature = hex::encode(signature);
    assert_eq!(
        context.verify(community, "node-1").unwrap_err(),
        SourceError::Signature
    );
    context.signature = "00".repeat(64);
    assert!(context.verify(community, "node-1").is_err());
    for public_key in [
        "02".to_owned() + &"00".repeat(32),
        "04".to_owned() + &"00".repeat(64),
    ] {
        context = original.clone();
        context.public_key = public_key;
        context.claims.community_id =
            hex::encode(Sha256::digest(hex::decode(&context.public_key).unwrap()));
        assert!(context
            .verify(&context.claims.community_id, "node-1")
            .is_err());
    }
    let encoded = serde_json::to_string(&original).unwrap();
    let duplicate = encoded.replacen(
        "\"schemaVersion\":1",
        "\"schemaVersion\":1,\"schemaVersion\":1",
        1,
    );
    assert!(SignedSourceContext::parse_bounded(duplicate.as_bytes()).is_err());
    let mut extra = serde_json::to_value(original).unwrap();
    extra["claims"]["allocation"] = serde_json::json!({"kind":"unknown","assignedHighWater":16});
    assert!(SignedSourceContext::parse_bounded(&serde_json::to_vec(&extra).unwrap()).is_err());
}

/// A signed source context as `community_roster` signs it and recovery stores
/// and replicates it, captured from the p256 0.13 encoder. The SEC1 point and
/// fixed-width low-S signature encodings must not change with a crate upgrade.
const GOLDEN_CONTEXT: &str = r#"{"claims":{"schemaVersion":1,"supportProfile":"encrypted-live-core-v2","communityId":"c8f193e678e762f9c4b28fc9e11a6e43d5cd792d2e1e376e56b80a76f22744ac","sourceNodeId":"node-1","archiveSha256":"e0e6385dcfd2a1e8154e479342c80b3827429407b69abdcf208440178f8a2ee1","inventorySha256":"abababababababababababababababababababababababababababababababab","ciphertextBytes":21,"appliedCommitSeq":16,"commitPrefixFingerprint":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","bootstrapFingerprint":"efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef","allocation":{"kind":"unknown"}},"publicKey":"041e18532fd4754c02f3041d9c75ceb33b83ffd81ac7ce4fe882ccb1c98bc5896ea46c311c4e2ff40dd96a3653e6e45445d32dfe486eced75c7a90c6a18881c0a3","signature":"aa98536b593d59fa0154e3f20430cde88d53717d026573e30281e6ff150d1eee746558b6576b8b60f58d93dce173a252e41ffc05ac34bc0741b4450c9df550bf"}"#;

#[test]
fn stored_golden_context_still_verifies_and_signing_is_byte_stable() {
    let stored = SignedSourceContext::parse_bounded(GOLDEN_CONTEXT.as_bytes()).unwrap();
    let verified = stored
        .verify(&stored.claims.community_id, "node-1")
        .unwrap();
    assert_eq!(
        verified.sha256(),
        hex::encode(Sha256::digest(GOLDEN_CONTEXT.as_bytes()))
    );
    assert_eq!(
        serde_json::to_string(&fixture(b"golden source context")).unwrap(),
        GOLDEN_CONTEXT
    );
}

#[test]
fn high_s_twin_of_the_golden_signature_is_refused() {
    // n - s for the stored low-S signature: mathematically valid ECDSA, but
    // the stored format admits only the canonical low-S form.
    let mut stored = SignedSourceContext::parse_bounded(GOLDEN_CONTEXT.as_bytes()).unwrap();
    let bytes = hex::decode(&stored.signature).unwrap();
    let n = hex::decode("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551").unwrap();
    let mut high_s = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let v = n[i] as i16 - bytes[32 + i] as i16 - borrow;
        borrow = (v < 0) as i16;
        high_s[i] = v.rem_euclid(256) as u8;
    }
    stored.signature = hex::encode([&bytes[..32], &high_s[..]].concat());
    assert_eq!(
        stored.verify(&stored.claims.community_id, "node-1").unwrap_err(),
        SourceError::Signature
    );
}
