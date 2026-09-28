//! Additive JSON v1 aggregate; existing postcard RBAC records stay unchanged.
use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::handler::{DurableEvent, Projection},
};
use serde::{Deserialize, Serialize};
pub const INDEX: &str = "service_access";
pub const EVENT: &str = "service_access_replaced_v1";
pub const KEY: &[u8] = b"v1";
pub const BUILTINS: [(&str, &str); 6] = [
    ("owner", "Owner"),
    ("admin", "Admin"),
    ("developer", "Developer"),
    ("mod", "Moderator"),
    ("artist", "Artist"),
    ("member", "Member"),
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceRole {
    pub id: String,
    pub name: String,
    pub services: Vec<String>,
    pub members: Vec<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceAccess {
    pub schema: u8,
    pub revision: String,
    pub roles: Vec<ServiceRole>,
    pub updated_by: u64,
}
impl Default for ServiceAccess {
    fn default() -> Self {
        Self {
            schema: 1,
            revision: "0".into(),
            updated_by: 0,
            roles: BUILTINS
                .iter()
                .map(|(id, name)| ServiceRole {
                    id: format!("builtin:{id}"),
                    name: (*name).into(),
                    services: vec![],
                    members: vec![],
                })
                .collect(),
        }
    }
}
pub fn decode(bytes: &[u8]) -> Result<ServiceAccess> {
    let bad = || WabiError::Corrupt {
        location: INDEX.into(),
        detail: "Invalid service access v1".into(),
    };
    if bytes.len() > 1024 * 1024 {
        return Err(bad());
    }
    let row: ServiceAccess = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if row.schema != 1
        || row.revision.is_empty()
        || row.revision.len() > 64
        || row.roles.len() > 134
    {
        return Err(bad());
    }
    Ok(row)
}
pub struct ServiceAccessProjection;
impl Projection for ServiceAccessProjection {
    fn event_type(&self) -> &str {
        EVENT
    }
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        decode(&event.payload)?;
        state.insert(INDEX, KEY.to_vec(), event.payload.clone(), event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn additive_schema_is_versioned_and_defaults_deny_every_service() {
        let row = ServiceAccess::default();
        assert!(row
            .roles
            .iter()
            .all(|r| r.services.is_empty() && r.members.is_empty()));
        let mut value = serde_json::to_value(row).unwrap();
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_ok());
        value["schema"] = serde_json::json!(2);
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(decode(b"{}").is_err());
        assert!(decode(&vec![0; 1024 * 1024 + 1]).is_err());
    }
}
