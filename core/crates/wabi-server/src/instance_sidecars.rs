//! Explicit, bounded file set for experimental Authority sidecar catch-up.
//! This is not a whole-instance checkpoint or a promotion certificate.

use serde::{Deserialize, Serialize};

pub const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;

pub const NAMES: &[&str] = &[
    "addons.json",
    "admin_policies.json",
    "blacklist.txt",
    "blob_registry.json",
    "bots.json",
    "channel_retention.json",
    "community_roster.json",
    "conversation_notes.json",
    "e2ee_state.json",
    "job_queue.json",
    "join-invites-v1.json",
    "jwt_secret",
    "lore_roles.json",
    "media_nodes.json",
    "media_rooms.json",
    "node_registry.json",
    "recovery_codes.json",
    "revocations.json",
    "server_center.json",
    "service_endpoints.json",
    "upload_registry.json",
    "voice_policies.json",
    "volunteer_boosters.json",
    "web_push.json",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarDigest {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidecarInventory {
    pub files: Vec<SidecarDigest>,
}

pub fn allowed(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn valid_digest(entry: &SidecarDigest) -> bool {
    allowed(&entry.name)
        && entry.size <= MAX_FILE_BYTES as u64
        && entry.sha256.len() == 64
        && entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_names_are_unique_and_pathless() {
        let mut names = std::collections::HashSet::new();
        for name in NAMES {
            assert!(names.insert(name));
            assert!(!name.contains('/') && !name.contains('\\') && !name.contains(".."));
        }
        assert!(!allowed("wabidb/root_key"));
        assert!(!allowed("../jwt_secret"));
    }

    #[test]
    fn inventory_digest_must_name_a_bounded_allowlisted_file() {
        let valid = SidecarDigest {
            name: "conversation_notes.json".into(),
            size: 1,
            sha256: hex::encode([0u8; 32]),
        };
        assert!(valid_digest(&valid));
        assert!(!valid_digest(&SidecarDigest {
            name: "../jwt_secret".into(),
            ..valid.clone()
        }));
        assert!(!valid_digest(&SidecarDigest {
            size: MAX_FILE_BYTES as u64 + 1,
            ..valid.clone()
        }));
        assert!(!valid_digest(&SidecarDigest {
            sha256: "not-a-sha256".into(),
            ..valid
        }));
    }
}
