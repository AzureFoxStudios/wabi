//! Community-bound source claims for an opaque core checkpoint.
//! A valid signature proves the community key signed these claims. It is not
//! proof of current writer authority, payload encryption, replay or readiness.
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SOURCE_PROFILE: &str = "encrypted-live-core-v2";
pub const SIGNING_DOMAIN: &[u8] = b"wabi/recovery-source-context/p256/v1\0";
pub const MAX_SOURCE_CONTEXT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    #[error("invalid recovery source context")]
    Format,
    #[error("recovery source context exceeds budget")]
    Budget,
    #[error("recovery source context binding mismatch")]
    Binding,
    #[error("recovery source community signature refused")]
    Signature,
}
pub type Result<T> = std::result::Result<T, SourceError>;

/// The current archive/inspector does not capture the highest sequence ever
/// allocated, or fence an unreachable earlier writer. Never substitute its
/// applied/observed watermark for that allocation fact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AllocationKnowledge {
    Unknown,
}
impl<'de> Deserialize<'de> for AllocationKnowledge {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        // serde's internally tagged unit variants can ignore extra fields even
        // with deny_unknown_fields. A strict struct keeps Unknown from silently
        // admitting invented allocation facts or duplicate kind fields.
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            kind: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.kind != "unknown" {
            return Err(serde::de::Error::custom("unsupported allocation knowledge"));
        }
        Ok(Self::Unknown)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceClaims {
    pub schema_version: u8,
    pub support_profile: String,
    pub community_id: String,
    pub source_node_id: String,
    pub archive_sha256: String,
    pub inventory_sha256: String,
    pub ciphertext_bytes: u64,
    pub applied_commit_seq: u64,
    pub commit_prefix_fingerprint: String,
    pub bootstrap_fingerprint: String,
    pub allocation: AllocationKnowledge,
}
fn lower_hex(s: &str, count: usize) -> bool {
    s.len() == count
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl SourceClaims {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || self.support_profile != SOURCE_PROFILE
            || !crate::model::identifier_valid(&self.source_node_id)
            || [
                &self.community_id,
                &self.archive_sha256,
                &self.inventory_sha256,
                &self.commit_prefix_fingerprint,
                &self.bootstrap_fingerprint,
            ]
            .into_iter()
            .any(|s| !lower_hex(s, 64))
        {
            return Err(SourceError::Format);
        }
        // A bounded signed metadata claim does not allocate its payload.
        // Actual transfer/storage uses the independently configured quotas.
        if self.ciphertext_bytes == 0 {
            return Err(SourceError::Budget);
        }
        Ok(())
    }
}
/// Exact domain-separated input for a separately coordinated real capture
/// signer. This consumer does not generate an Authority key or open state.
pub fn signing_input(claims: &SourceClaims) -> Result<Vec<u8>> {
    claims.validate()?;
    let encoded = serde_json::to_vec(claims).map_err(|_| SourceError::Format)?;
    if encoded.len() > MAX_SOURCE_CONTEXT_BYTES - SIGNING_DOMAIN.len() {
        return Err(SourceError::Budget);
    }
    let mut input = Vec::with_capacity(SIGNING_DOMAIN.len() + encoded.len());
    input.extend_from_slice(SIGNING_DOMAIN);
    input.extend_from_slice(&encoded);
    Ok(input)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedSourceContext {
    pub claims: SourceClaims,
    /// Canonical uncompressed SEC1 P256 point, lower-case hex.
    pub public_key: String,
    /// Canonical fixed-width low-S signature, lower-case hex.
    pub signature: String,
}
/// Owned immutable verification result. Callers cannot deserialize or mutate
/// it into a proof; source role, nonce authority and readiness remain unknown.
#[derive(Clone, Debug)]
pub struct VerifiedSourceContext {
    signed: SignedSourceContext,
    sha256: String,
}
impl VerifiedSourceContext {
    pub fn claims(&self) -> &SourceClaims {
        &self.signed.claims
    }
    pub fn signed(&self) -> &SignedSourceContext {
        &self.signed
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}
impl SignedSourceContext {
    pub fn verify(
        &self,
        expected_community: &str,
        expected_source_node: &str,
    ) -> Result<VerifiedSourceContext> {
        self.claims.validate()?;
        if !lower_hex(expected_community, 64)
            || !crate::model::identifier_valid(expected_source_node)
            || self.claims.community_id != expected_community
            || self.claims.source_node_id != expected_source_node
        {
            return Err(SourceError::Binding);
        }
        if !lower_hex(&self.public_key, 130)
            || !self.public_key.starts_with("04")
            || !lower_hex(&self.signature, 128)
        {
            return Err(SourceError::Format);
        }
        let point = hex::decode(&self.public_key).map_err(|_| SourceError::Format)?;
        if hex::encode(Sha256::digest(&point)) != expected_community {
            return Err(SourceError::Binding);
        }
        let key = VerifyingKey::from_sec1_bytes(&point).map_err(|_| SourceError::Signature)?;
        let signature =
            Signature::from_slice(&hex::decode(&self.signature).map_err(|_| SourceError::Format)?)
                .map_err(|_| SourceError::Signature)?;
        if signature.normalize_s().is_some() {
            return Err(SourceError::Signature);
        }
        key.verify(&signing_input(&self.claims)?, &signature)
            .map_err(|_| SourceError::Signature)?;
        let bytes = serde_json::to_vec(self).map_err(|_| SourceError::Format)?;
        if bytes.len() > MAX_SOURCE_CONTEXT_BYTES {
            return Err(SourceError::Budget);
        }
        Ok(VerifiedSourceContext {
            signed: self.clone(),
            sha256: hex::encode(Sha256::digest(bytes)),
        })
    }
    pub fn parse_bounded(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_SOURCE_CONTEXT_BYTES {
            return Err(SourceError::Budget);
        }
        serde_json::from_slice(bytes).map_err(|_| SourceError::Format)
    }
}

#[cfg(test)]
pub(crate) mod tests;
