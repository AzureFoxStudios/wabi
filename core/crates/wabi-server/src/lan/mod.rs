use serde::{Deserialize, Serialize, Serializer};

fn serialize_option_as_empty_string<S>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(v) => serializer.serialize_str(v),
        None => serializer.serialize_str(""),
    }
}

/// A signed token issued by the authority that grants a client permission
/// to use a specific LAN helper for a specific resource (blob, media room, etc.).
///
/// The helper can verify the primary's signature without querying the authority
/// on every request, making LAN traffic fast and offline-capable.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignedLocalRouteToken {
    pub authority_node_id: String,
    pub node_id: String,
    pub node_endpoint: String,
    pub capability: LocalCapability,
    pub resource_id: String,
    pub user_id: i64,
    pub issued_at: i64,
    pub expires_at: i64,
    /// HMAC-SHA256 signature (hex) over all other fields.
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum LocalCapability {
    BlobDownload,
    BlobUpload,
    MediaRoom,
    CacheRead,
}

impl std::fmt::Display for LocalCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            LocalCapability::BlobDownload => "blob_download",
            LocalCapability::BlobUpload => "blob_upload",
            LocalCapability::MediaRoom => "media_room",
            LocalCapability::CacheRead => "cache_read",
        };
        write!(f, "{}", s)
    }
}

impl std::str::FromStr for LocalCapability {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "blob_download" => Ok(LocalCapability::BlobDownload),
            "blob_upload" => Ok(LocalCapability::BlobUpload),
            "media_room" => Ok(LocalCapability::MediaRoom),
            "cache_read" => Ok(LocalCapability::CacheRead),
            _ => Err(format!("unknown local capability: {}", s)),
        }
    }
}

/// Sign a token with the authority's HMAC secret.
pub fn sign_token(secret: &str, token: &mut SignedLocalRouteToken) {
    let payload = format!(
        "{}:{}:{}:{}:{}:{}:{}",
        token.authority_node_id,
        token.node_id,
        token.node_endpoint,
        token.capability,
        token.resource_id,
        token.user_id,
        token.expires_at
    );
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take any key size");
    mac.update(payload.as_bytes());
    let result = mac.finalize();
    token.signature = hex::encode(result.into_bytes());
}

/// Verify a token's HMAC signature matches the authority secret.
pub fn verify_token(secret: &str, token: &SignedLocalRouteToken) -> bool {
    let mut test = token.clone();
    sign_token(secret, &mut test);
    test.signature == token.signature
}

/// Find the best LAN-reachable helper for a user from the node list.
/// Returns the node_id and its `lan_reachable_at` endpoint, if any Online
/// node reports LAN reachability.
pub fn pick_lan_helper(nodes: &[crate::nodes::HelperNode]) -> Option<(String, String)> {
    for node in nodes {
        if node.status != crate::nodes::NodeStatus::Online {
            continue;
        }
        if let Some(endpoint) = &node.lan_reachable_at {
            if !endpoint.is_empty() {
                return Some((node.node_id.clone(), endpoint.clone()));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_local_route_token() {
        let mut token = SignedLocalRouteToken {
            authority_node_id: "auth-1".into(),
            node_id: "node-lan-1".into(),
            node_endpoint: "http://192.168.1.10:9999".into(),
            capability: LocalCapability::BlobDownload,
            resource_id: "blob-abc".into(),
            user_id: 42,
            issued_at: 1710000000,
            expires_at: 1710003600,
            signature: String::new(),
        };
        sign_token("test-secret", &mut token);
        assert!(!token.signature.is_empty());
        assert!(verify_token("test-secret", &token));
        assert!(!verify_token("wrong-secret", &token));
    }
}
