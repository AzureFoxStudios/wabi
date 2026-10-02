//! Authorization and write ordering for extensible JSON whiteboard documents.
//! Only absent legacy fields receive defaults; malformed policies fail closed.
use crate::{
    error::{AppError, Result},
    state::AppState,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use wabidb::engine::wabi_store::WabiStore;

/// A bounded set of per-Authority locks orders every channel's board policy read,
/// version check, durable write and publication. Hash collisions only serialize
/// independent boards; untrusted board IDs cannot grow a lock registry.
/// Acquire after membership and credential admission and retain until completion.
pub fn write_gate<'a>(state: &'a AppState, board_id: &str) -> &'a Mutex<()> {
    crate::channel_access::publication_gate(state, &channel_id(board_id))
}

/// The same owning channel controls ordinary boards and derived CAD reviews.
pub(crate) fn channel_id(board_id: &str) -> String {
    if let Some(channel_id) = board_id.strip_prefix("channel:") {
        return channel_id.to_string();
    }
    if let Some(rest) = board_id.strip_prefix("cad-review:") {
        if let Some((channel_id, asset_key)) = rest.split_once(':') {
            let key_valid = !asset_key.is_empty()
                && asset_key.len() <= 64
                && asset_key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
            if !channel_id.is_empty()
                && channel_id.len() <= 128
                && !channel_id.contains(':')
                && key_valid
            {
                return channel_id.to_string();
            }
        }
    }
    board_id.to_string()
}

pub(crate) fn effective_policy(document: &Value) -> Result<Value> {
    if !document.is_object() {
        return Err(AppError::Forbidden("Invalid board policy".into()));
    }
    let policy = match document.get("policy") {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| AppError::Forbidden("Invalid board policy".into()))?,
        ),
    };
    let field = |name: &str, default: &str, allowed: &[&str]| -> Result<String> {
        match policy.and_then(|policy| policy.get(name)) {
            None => Ok(default.to_string()),
            Some(value) => match value.as_str() {
                Some(value) if allowed.contains(&value) => Ok(value.to_string()),
                _ => Err(AppError::Forbidden("Invalid board policy".into())),
            },
        }
    };
    let draw_roles = match policy.and_then(|policy| policy.get("drawRoles")) {
        None => Vec::<String>::new(),
        Some(value) => {
            let roles = value
                .as_array()
                .ok_or_else(|| AppError::Forbidden("Invalid board policy".into()))?;
            if roles.len() > 64 {
                return Err(AppError::Forbidden("Invalid board policy".into()));
            }
            let mut normalized = Vec::with_capacity(roles.len());
            for role in roles {
                let role = role
                    .as_str()
                    .ok_or_else(|| AppError::Forbidden("Invalid board policy".into()))?
                    .trim()
                    .to_ascii_lowercase();
                if role.is_empty()
                    || role.len() > 32
                    || !role.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
                {
                    return Err(AppError::Forbidden("Invalid board policy".into()));
                }
                normalized.push(role);
            }
            normalized.sort_unstable();
            normalized.dedup();
            normalized
        }
    };
    let draw_role = field(
        "drawRole",
        "participants",
        &["participants", "moderators", "admins", "owner", "custom"],
    )?;
    if draw_role == "custom" && draw_roles.is_empty() {
        return Err(AppError::Forbidden("Invalid board policy".into()));
    }
    Ok(json!({
        "access": field("access", "open", &["open", "desktop_only"] )?,
        "writeAccess": field("writeAccess", "anyone", &["anyone", "desktop"] )?,
        "drawRole": draw_role,
        "drawRoles": draw_roles,
    }))
}

pub(crate) fn role_can_draw(role: &str, rank: u8) -> bool {
    match role {
        "participants" => rank >= 1,
        "moderators" => rank >= 2,
        "admins" => rank >= 3,
        "owner" => rank >= 4,
        _ => false,
    }
}

pub(crate) async fn can_draw(state: &AppState, user_id: i64, document: &Value) -> bool {
    // A current owner may repair a malformed stored policy with a valid save.
    if state.is_owner(user_id).await {
        return true;
    }
    let Ok(policy) = effective_policy(document) else {
        return false;
    };
    if policy["drawRole"] == "custom" {
        let current_role = if state.is_admin(user_id).await {
            Some("admin".to_string())
        } else {
            match state
                .wdb
                .get_user_role("default-workspace", user_id as u64)
                .await
            {
                Ok(Some(role)) => Some(normalize_role_id(&role)),
                Ok(None) => match state.wdb.get_user(user_id as u64).await {
                    Ok(Some(user)) if user.is_registered => Some("member".to_string()),
                    _ => None,
                },
                Err(_) => None,
            }
        };
        return current_role.is_some_and(|role| {
            policy["drawRoles"].as_array().is_some_and(|roles| {
                selected_role_can_draw(&role, roles)
            })
        });
    }
    let rank = if state.is_admin(user_id).await {
        3
    } else if state.has_role(user_id, "Moderator").await {
        2
    } else if user_id > 0 {
        1
    } else {
        0
    };
    role_can_draw(policy["drawRole"].as_str().unwrap_or(""), rank)
}

fn normalize_role_id(role: &str) -> String {
    match role.trim().to_ascii_lowercase().as_str() {
        "moderator" => "mod".into(),
        role => role.to_string(),
    }
}

fn selected_role_can_draw(current_role: &str, allowed_roles: &[Value]) -> bool {
    let current_role = normalize_role_id(current_role);
    allowed_roles
        .iter()
        .any(|allowed| allowed.as_str() == Some(current_role.as_str()))
}

/// Accepted writes retain this board's write gate through the whole operation;
/// early upload preflight checks are repeated behind that gate after parsing.
pub(crate) async fn require_write(
    state: &AppState,
    user_id: i64,
    board_id: &str,
    incoming: Option<&Value>,
) -> Result<()> {
    let current = match state.wdb.get_whiteboard_doc(board_id).await? {
        Some(raw) => serde_json::from_str::<Value>(&raw)
            .map_err(|_| AppError::Internal("Stored board policy is invalid".into()))?,
        None => json!({}),
    };
    if !can_draw(state, user_id, &current).await {
        return Err(AppError::Forbidden(
            "This board is read-only for your role".into(),
        ));
    }
    if let Some(next) = incoming {
        let policy = effective_policy(next)?;
        if !state.is_owner(user_id).await && effective_policy(&current)? != policy {
            return Err(AppError::Forbidden(
                "Only the server owner can change board permissions".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_policy_keeps_participant_access() {
        assert_eq!(
            effective_policy(&json!({})).unwrap(),
            effective_policy(&json!({"policy":{"access":"open","writeAccess":"anyone","drawRole":"participants"}})).unwrap()
        );
        assert!(role_can_draw("participants", 1));
        assert!(!role_can_draw("participants", 0));
    }

    #[test]
    fn role_restrictions_fail_closed_and_follow_server_rank() {
        for (policy, minimum) in [
            ("participants", 1),
            ("moderators", 2),
            ("admins", 3),
            ("owner", 4),
        ] {
            for rank in 0..=4 {
                assert_eq!(role_can_draw(policy, rank), rank >= minimum);
            }
        }
        assert!(!role_can_draw("typo", 4));
    }

    #[test]
    fn selected_role_policies_are_normalized_and_bounded() {
        let policy = effective_policy(&json!({"policy":{
            "drawRole":"custom",
            "drawRoles":["Artist", "developer", "artist", "mod"]
        }}))
        .unwrap();
        assert_eq!(policy["drawRoles"], json!(["artist", "developer", "mod"]));
        assert_eq!(normalize_role_id("Moderator"), "mod");
        assert_eq!(normalize_role_id("Developer"), "developer");
        assert!(selected_role_can_draw(
            "Moderator",
            &[json!("mod"), json!("artist")]
        ));
        assert!(!selected_role_can_draw(
            "Moderator",
            &[json!("moderator")]
        ));

        for malformed in [
            json!("artist"),
            json!([null]),
            json!(["bad role"]),
            json!(vec!["role"; 65]),
        ] {
            assert!(effective_policy(&json!({
                "policy":{"drawRole":"custom","drawRoles":malformed}
            }))
            .is_err());
        }
        assert!(effective_policy(&json!({
            "policy":{"drawRole":"custom","drawRoles":[]}
        }))
        .is_err());
    }

    #[test]
    fn present_malformed_policy_is_never_a_legacy_default() {
        for malformed in [Value::Null, json!([]), json!(42), json!("participants")] {
            assert!(effective_policy(&json!({"policy":malformed})).is_err());
        }
        // A scalar policy is invalid, but "participants" is a valid drawRole.
        // Exercise malformed field values independently from the policy shape.
        for malformed in [Value::Null, json!([]), json!(42), json!("invalid-policy")] {
            for name in ["access", "writeAccess", "drawRole"] {
                let mut document = json!({"policy":{}});
                document["policy"][name] = malformed.clone();
                assert!(effective_policy(&document).is_err(), "{document}");
            }
        }
    }
}
