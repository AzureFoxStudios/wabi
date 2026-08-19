//! Payment projection: account links, intents, policies, user blocks.
//!
//! Phase 1 of the payments roadmap (docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md):
//! moves the payment surface out of JSONL files and handler-local no-ops into
//! the event-sourced projection engine, so account links / intents / policies
//! are replayed from the stream log on restart and survive standby snapshots.
//!
//! Event types (stream `payments`):
//! - `payment_account_link_upserted` / `payment_account_link_deleted`
//! - `payment_intent_created` / `payment_intent_confirmed` / `payment_intent_rejected`
//! - `payment_policy_upserted`
//! - `payment_user_block_upserted` / `payment_user_block_deleted`
//!
//! Records are new postcard types (golden rule 5: never mutate existing
//! postcard records; new ones are fine).

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// A saved seller pointer (PromptPay ID today; crypto/EU/US rails later).
/// Field names serialize camelCase so the API JSON contract is unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentAccountLinkRecord {
    pub user_id: i64,
    pub workspace_id: String,
    pub plugin_id: String,
    pub provider_account_ref: String,
    pub display_label: Option<String>,
    pub metadata: Option<Value>,
    pub linked_at: i64,
    pub updated_at: i64,
}

/// A non-custodial payment intent. Rail-agnostic since the 2026-08-18
/// multi-rail pass (phases 2-4): `provider` selects the compiled rail and
/// `presentation_json` carries the rendered payment surface (QR payload,
/// pointer, reference code, disclosure). The PromptPay fields remain for
/// wire compatibility with the v1 frontend contract. Mirrors the former
/// `intents.jsonl` shape (camelCase wire fields).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentIntentRecord {
    pub id: String,
    pub user_id: i64,
    pub provider: String, // promptpay | payments-crypto | payments-eu | payments-us
    pub amount_minor: i64,
    pub currency: String,
    pub status: String, // pending | completed | rejected | expired
    /// Rail-specific method id (e.g. `promptpay_qr`, `usdc_base`,
    /// `epc_qr`, `cashapp_pointer`). Absent in pre-multi-rail rows.
    #[serde(default)]
    pub method_id: Option<String>,
    /// 2-letter country the request is scoped to (TH / DE / US / …).
    #[serde(default)]
    pub country_code: Option<String>,
    /// JSON `{ mode, qrData?, pointer?, referenceCode?, disclosure?, … }`
    /// rendered by the frontend intent card (postcard-safe: string).
    #[serde(default)]
    pub presentation_json: Option<String>,
    pub promptpay_proxy_id: Option<String>,
    pub promptpay_qr_payload: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub confirmed_by: Option<i64>,
    pub confirm_note: Option<String>,
}

/// A generic policy row (payments_access / payments_donations). The value is
/// the sanitized JSON config stored as a string (postcard cannot encode
/// `serde_json::Value` directly — see audit projection); keys are namespaced
/// like `policy:payments_access`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaymentPolicyRecord {
    pub key: String,
    pub value_json: String,
}

impl PaymentPolicyRecord {
    pub fn new(key: &str, value: &Value) -> Self {
        Self {
            key: key.to_string(),
            value_json: value.to_string(),
        }
    }

    pub fn value(&self) -> Result<Value> {
        serde_json::from_str(&self.value_json).map_err(|e| crate::error::WabiError::Corrupt {
            location: "payment_policy".into(),
            detail: format!("policy value is not valid JSON: {e}"),
        })
    }
}

/// An admin-issued block preventing a user from creating intents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentUserBlockRecord {
    pub user_id: i64,
    pub workspace_id: String,
    pub reason: Option<String>,
    pub blocked_by_user_id: Option<i64>,
    pub blocked_by_username: Option<String>,
    pub blocked_username: Option<String>,
    pub blocked_at: i64,
    pub expires_at: Option<i64>,
}

/// Minimal payload for delete events (account link / user block).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaymentDeleteKey {
    pub user_id: i64,
    pub workspace_id: Option<String>,
    pub plugin_id: Option<String>,
}

impl RecordCodec for PaymentAccountLinkRecord {
    fn codec_name() -> &'static str {
        "payment_account_link"
    }
}
impl RecordCodec for PaymentIntentRecord {
    fn codec_name() -> &'static str {
        "payment_intent"
    }
}
impl RecordCodec for PaymentPolicyRecord {
    fn codec_name() -> &'static str {
        "payment_policy"
    }
}
impl RecordCodec for PaymentUserBlockRecord {
    fn codec_name() -> &'static str {
        "payment_user_block"
    }
}
impl RecordCodec for PaymentDeleteKey {
    fn codec_name() -> &'static str {
        "payment_delete_key"
    }
}

/// Encode any payments record to its postcard payload.
pub fn encode_record<T: RecordCodec>(r: &T) -> Vec<u8> {
    r.encode()
}

/// Decode a payments account-link record.
pub fn decode_record(buf: &[u8]) -> Result<PaymentAccountLinkRecord> {
    PaymentAccountLinkRecord::decode(buf)
}

// ---------------------------------------------------------------------------
// Key encoding
//
// len-prefixed strings (u64 LE length + bytes) and fixed-width i64 LE user
// ids, matching the incidents projection key scheme. Prefix scans list by
// (user, …) or (workspace, …) in order.
// ---------------------------------------------------------------------------

fn push_len_prefix(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u64).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

fn encode_account_link_key(user_id: i64, plugin_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&user_id.to_le_bytes());
    push_len_prefix(&mut buf, plugin_id);
    buf
}

fn encode_intent_key(user_id: i64, intent_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&user_id.to_le_bytes());
    push_len_prefix(&mut buf, intent_id);
    buf
}

fn encode_policy_key(key: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    push_len_prefix(&mut buf, key);
    buf
}

fn encode_user_block_key(workspace_id: &str, user_id: i64) -> Vec<u8> {
    let mut buf = Vec::new();
    push_len_prefix(&mut buf, workspace_id);
    buf.extend_from_slice(&user_id.to_le_bytes());
    buf
}

fn decode_user_prefix(user_id: i64) -> Vec<u8> {
    user_id.to_le_bytes().to_vec()
}

fn decode_workspace_prefix(workspace_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    push_len_prefix(&mut buf, workspace_id);
    buf
}

// ---------------------------------------------------------------------------
// Projection implementation
// ---------------------------------------------------------------------------

pub struct PaymentsProjection;

impl Projection for PaymentsProjection {
    fn event_type(&self) -> &str {
        "payment_intent_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec![
            "payment_account_link_upserted",
            "payment_account_link_deleted",
            "payment_intent_created",
            "payment_intent_confirmed",
            "payment_intent_rejected",
            "payment_policy_upserted",
            "payment_user_block_upserted",
            "payment_user_block_deleted",
        ]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "payment_account_link_upserted" => {
                let record: PaymentAccountLinkRecord =
                    PaymentAccountLinkRecord::decode(&event.payload)?;
                let key = encode_account_link_key(record.user_id, &record.plugin_id);
                state.insert(
                    "payment_account_links",
                    key,
                    record.encode(),
                    event.commit_seq,
                );
                Ok(())
            }
            "payment_account_link_deleted" => {
                let key: PaymentDeleteKey = PaymentDeleteKey::decode(&event.payload)?;
                state.remove("payment_account_links", &encode_account_link_key(
                    key.user_id,
                    key.plugin_id.as_deref().unwrap_or(""),
                ));
                Ok(())
            }
            "payment_intent_created" | "payment_intent_confirmed" | "payment_intent_rejected" => {
                let record: PaymentIntentRecord = PaymentIntentRecord::decode(&event.payload)?;
                let key = encode_intent_key(record.user_id, &record.id);
                state.insert("payment_intents", key, record.encode(), event.commit_seq);
                Ok(())
            }
            "payment_policy_upserted" => {
                let record: PaymentPolicyRecord = PaymentPolicyRecord::decode(&event.payload)?;
                let key = encode_policy_key(&record.key);
                state.insert("payment_policies", key, record.encode(), event.commit_seq);
                Ok(())
            }
            "payment_user_block_upserted" => {
                let record: PaymentUserBlockRecord = PaymentUserBlockRecord::decode(&event.payload)?;
                let key = encode_user_block_key(&record.workspace_id, record.user_id);
                state.insert(
                    "payment_user_blocks",
                    key,
                    record.encode(),
                    event.commit_seq,
                );
                Ok(())
            }
            "payment_user_block_deleted" => {
                let key: PaymentDeleteKey = PaymentDeleteKey::decode(&event.payload)?;
                state.remove(
                    "payment_user_blocks",
                    &encode_user_block_key(key.workspace_id.as_deref().unwrap_or(""), key.user_id),
                );
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Typed queries
// ---------------------------------------------------------------------------

impl PaymentsProjection {
    /// All account links for a user, newest-first by `linked_at`.
    pub fn list_account_links(
        state: &ProjectionState,
        user_id: i64,
    ) -> Result<Vec<PaymentAccountLinkRecord>> {
        let prefix = decode_user_prefix(user_id);
        let mut results = Vec::new();
        state.prefix_scan("payment_account_links", &prefix, |_key, value| {
            if let Ok(record) = PaymentAccountLinkRecord::decode(value) {
                results.push(record);
            }
        });
        results.sort_by(|a, b| b.linked_at.cmp(&a.linked_at));
        Ok(results)
    }

    pub fn get_account_link(
        state: &ProjectionState,
        user_id: i64,
        plugin_id: &str,
    ) -> Result<Option<PaymentAccountLinkRecord>> {
        let key = encode_account_link_key(user_id, plugin_id);
        match state.get("payment_account_links", &key) {
            None => Ok(None),
            Some(bytes) => PaymentAccountLinkRecord::decode(&bytes).map(Some),
        }
    }

    /// List intents. When `include_all` is false only the given user's intents
    /// are returned (non-admin caller). Sorted newest-first.
    pub fn list_intents(
        state: &ProjectionState,
        user_id: i64,
        include_all: bool,
    ) -> Result<Vec<PaymentIntentRecord>> {
        let mut results = Vec::new();
        if include_all {
            state.for_each("payment_intents", |_key, value| {
                if let Ok(record) = PaymentIntentRecord::decode(value) {
                    results.push(record);
                }
            });
        } else {
            let prefix = decode_user_prefix(user_id);
            state.prefix_scan("payment_intents", &prefix, |_key, value| {
                if let Ok(record) = PaymentIntentRecord::decode(value) {
                    results.push(record);
                }
            });
        }
        results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(results)
    }

    /// Find an intent by id (regardless of owner). O(n) scan — confirm/reject
    /// are rare admin ops on hobbyist-scale data.
    pub fn get_intent_by_id(
        state: &ProjectionState,
        intent_id: &str,
    ) -> Result<Option<PaymentIntentRecord>> {
        let mut found = None;
        state.for_each("payment_intents", |_key, value| {
            if found.is_some() {
                return;
            }
            if let Ok(record) = PaymentIntentRecord::decode(value) {
                if record.id == intent_id {
                    found = Some(record);
                }
            }
        });
        Ok(found)
    }

    /// A single stored policy row (e.g. `policy:payments_access`).
    pub fn get_policy(state: &ProjectionState, key: &str) -> Result<Option<Value>> {
        let encoded = encode_policy_key(key);
        match state.get("payment_policies", &encoded) {
            None => Ok(None),
            Some(bytes) => {
                let record = PaymentPolicyRecord::decode(&bytes)?;
                record.value().map(Some)
            }
        }
    }

    pub fn list_user_blocks(
        state: &ProjectionState,
        workspace_id: &str,
    ) -> Result<Vec<PaymentUserBlockRecord>> {
        let prefix = decode_workspace_prefix(workspace_id);
        let mut results = Vec::new();
        state.prefix_scan("payment_user_blocks", &prefix, |_key, value| {
            if let Ok(record) = PaymentUserBlockRecord::decode(value) {
                results.push(record);
            }
        });
        Ok(results)
    }

    pub fn get_user_block(
        state: &ProjectionState,
        workspace_id: &str,
        user_id: i64,
    ) -> Result<Option<PaymentUserBlockRecord>> {
        let key = encode_user_block_key(workspace_id, user_id);
        match state.get("payment_user_blocks", &key) {
            None => Ok(None),
            Some(bytes) => PaymentUserBlockRecord::decode(&bytes).map(Some),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_link(user_id: i64, plugin_id: &str) -> PaymentAccountLinkRecord {
        PaymentAccountLinkRecord {
            user_id,
            workspace_id: "default-workspace".into(),
            plugin_id: plugin_id.into(),
            provider_account_ref: "0812345678".into(),
            display_label: Some("Poster payments".into()),
            metadata: None,
            linked_at: 1_000,
            updated_at: 1_000,
        }
    }

    fn sample_intent(user_id: i64, id: &str) -> PaymentIntentRecord {
        PaymentIntentRecord {
            id: id.into(),
            user_id,
            provider: "promptpay".into(),
            amount_minor: 20_000,
            currency: "THB".into(),
            status: "pending".into(),
            method_id: Some("promptpay_qr".into()),
            country_code: Some("TH".into()),
            presentation_json: None,
            promptpay_proxy_id: Some("0812345678".into()),
            promptpay_qr_payload: Some("0002010102112937...".into()),
            note: Some("poster commission".into()),
            created_at: 2_000,
            updated_at: 2_000,
            confirmed_by: None,
            confirm_note: None,
        }
    }

    fn sample_policy(key: &str) -> PaymentPolicyRecord {
        PaymentPolicyRecord::new(key, &serde_json::json!({ "enabled": true }))
    }

    fn sample_block(user_id: i64) -> PaymentUserBlockRecord {
        PaymentUserBlockRecord {
            user_id,
            workspace_id: "default-workspace".into(),
            reason: Some("chargeback".into()),
            blocked_by_user_id: Some(1),
            blocked_by_username: Some("admin".into()),
            blocked_username: None,
            blocked_at: 3_000,
            expires_at: None,
        }
    }

    fn make_event(seq: u64, event_type: &str, payload: Vec<u8>) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: "payments".into(),
            event_type: event_type.to_string(),
            payload,
        }
    }

    #[test]
    fn account_link_roundtrip_and_list() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        let link = sample_link(7, "promptpay");
        proj.apply(
            &make_event(1, "payment_account_link_upserted", link.encode()),
            &state,
        )
        .unwrap();
        let stored = PaymentsProjection::get_account_link(&state, 7, "promptpay")
            .unwrap()
            .unwrap();
        assert_eq!(stored, link);
        let all = PaymentsProjection::list_account_links(&state, 7).unwrap();
        assert_eq!(all.len(), 1);
        // Other users don't see it.
        assert!(PaymentsProjection::list_account_links(&state, 8)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn account_link_delete_removes_row() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        let link = sample_link(7, "promptpay");
        proj.apply(
            &make_event(1, "payment_account_link_upserted", link.encode()),
            &state,
        )
        .unwrap();
        let del = PaymentDeleteKey {
            user_id: 7,
            workspace_id: None,
            plugin_id: Some("promptpay".into()),
        };
        proj.apply(
            &make_event(2, "payment_account_link_deleted", del.encode()),
            &state,
        )
        .unwrap();
        assert!(PaymentsProjection::get_account_link(&state, 7, "promptpay")
            .unwrap()
            .is_none());
    }

    #[test]
    fn upserting_same_plugin_overwrites() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        let mut link = sample_link(7, "promptpay");
        proj.apply(
            &make_event(1, "payment_account_link_upserted", link.encode()),
            &state,
        )
        .unwrap();
        link.provider_account_ref = "0999999999".into();
        link.updated_at = 9_000;
        proj.apply(
            &make_event(2, "payment_account_link_upserted", link.encode()),
            &state,
        )
        .unwrap();
        let stored = PaymentsProjection::get_account_link(&state, 7, "promptpay")
            .unwrap()
            .unwrap();
        assert_eq!(stored.provider_account_ref, "0999999999");
        assert_eq!(stored.updated_at, 9_000);
        assert_eq!(PaymentsProjection::list_account_links(&state, 7).unwrap().len(), 1);
    }

    #[test]
    fn intent_lifecycle_created_confirmed() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        let mut intent = sample_intent(7, "pi_abc");
        proj.apply(
            &make_event(1, "payment_intent_created", intent.encode()),
            &state,
        )
        .unwrap();
        intent.status = "completed".into();
        intent.confirmed_by = Some(1);
        intent.confirm_note = Some("bank confirmed".into());
        intent.updated_at = 4_000;
        proj.apply(
            &make_event(2, "payment_intent_confirmed", intent.encode()),
            &state,
        )
        .unwrap();
        let stored = PaymentsProjection::get_intent_by_id(&state, "pi_abc")
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, "completed");
        assert_eq!(stored.confirmed_by, Some(1));
        assert_eq!(stored.confirm_note.as_deref(), Some("bank confirmed"));
    }

    #[test]
    fn intent_list_scopes_by_user() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        proj.apply(
            &make_event(1, "payment_intent_created", sample_intent(7, "pi_a").encode()),
            &state,
        )
        .unwrap();
        proj.apply(
            &make_event(2, "payment_intent_created", sample_intent(7, "pi_b").encode()),
            &state,
        )
        .unwrap();
        proj.apply(
            &make_event(3, "payment_intent_created", sample_intent(8, "pi_c").encode()),
            &state,
        )
        .unwrap();
        let mine = PaymentsProjection::list_intents(&state, 7, false).unwrap();
        assert_eq!(mine.len(), 2);
        assert!(mine.iter().all(|i| i.user_id == 7));
        let all = PaymentsProjection::list_intents(&state, 7, true).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn intent_list_sorted_newest_first() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        for seq in 1..=3u64 {
            let mut intent = sample_intent(7, &format!("pi_{seq}"));
            intent.created_at = (seq * 1_000) as i64;
            proj.apply(
                &make_event(seq, "payment_intent_created", intent.encode()),
                &state,
            )
            .unwrap();
        }
        let all = PaymentsProjection::list_intents(&state, 7, false).unwrap();
        assert_eq!(all[0].id, "pi_3");
        assert_eq!(all[2].id, "pi_1");
    }

    #[test]
    fn policy_upsert_and_get() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        let policy = sample_policy("policy:payments_access");
        proj.apply(
            &make_event(1, "payment_policy_upserted", policy.encode()),
            &state,
        )
        .unwrap();
        let v = PaymentsProjection::get_policy(&state, "policy:payments_access")
            .unwrap()
            .unwrap();
        assert_eq!(v, serde_json::json!({ "enabled": true }));
        assert!(PaymentsProjection::get_policy(&state, "policy:nope")
            .unwrap()
            .is_none());
        // Overwrite.
        let updated = PaymentPolicyRecord::new("policy:payments_access", &serde_json::json!({ "enabled": false }));
        proj.apply(
            &make_event(2, "payment_policy_upserted", updated.encode()),
            &state,
        )
        .unwrap();
        let v = PaymentsProjection::get_policy(&state, "policy:payments_access")
            .unwrap()
            .unwrap();
        assert_eq!(v, serde_json::json!({ "enabled": false }));
    }

    #[test]
    fn user_block_upsert_and_delete() {
        let state = ProjectionState::new();
        let proj = PaymentsProjection;
        let block = sample_block(9);
        proj.apply(
            &make_event(1, "payment_user_block_upserted", block.encode()),
            &state,
        )
        .unwrap();
        let stored = PaymentsProjection::get_user_block(&state, "default-workspace", 9)
            .unwrap()
            .unwrap();
        assert_eq!(stored, block);
        assert_eq!(
            PaymentsProjection::list_user_blocks(&state, "default-workspace")
                .unwrap()
                .len(),
            1
        );
        let del = PaymentDeleteKey {
            user_id: 9,
            workspace_id: Some("default-workspace".into()),
            plugin_id: None,
        };
        proj.apply(
            &make_event(2, "payment_user_block_deleted", del.encode()),
            &state,
        )
        .unwrap();
        assert!(
            PaymentsProjection::get_user_block(&state, "default-workspace", 9)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn dispatch_table_routes_all_payment_events() {
        let table = DispatchTable::new(vec![Arc::new(PaymentsProjection)]).unwrap();
        let state = ProjectionState::new();
        let handler = table.get("payment_intent_created").unwrap();
        handler
            .apply(
                &make_event(1, "payment_intent_created", sample_intent(7, "pi_x").encode()),
                &state,
            )
            .unwrap();
        assert!(PaymentsProjection::get_intent_by_id(&state, "pi_x")
            .unwrap()
            .is_some());
        assert!(table.get("payment_account_link_upserted").is_some());
        assert!(table.get("payment_policy_upserted").is_some());
        assert!(table.get("payment_user_block_deleted").is_some());
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = make_event(1, "payment_intent_created", vec![0xde, 0xad]);
        assert!(PaymentsProjection.apply(&event, &state).is_err());
    }
}